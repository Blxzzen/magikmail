const JobRejectionHandler = (() => {
    const CONFIG = {
        USER_ID: "me",

        // visible label
        REJECTION_LABEL_NAME: "Job Rejection",

        // invisible scanned marker
        // labelListVisibility: labelHide hides it from Gmail’s label list
        // messageListVisibility: hide hides it from the message list
        SCANNED_LABEL_NAME: "Magikmail/Scanned",
        USE_SCANNED_LABEL: true,

        // Gmail API listing
        LIST_PAGE_SIZE: 500,

        // each apps script run under 6 minutes (soft stop)
        // handler is safe to trigger repeatedly until it finishes
        MAX_RUNTIME_MS: 5 * 60 * 1000,

        // non-ai prefilter
        // search query keywords to avoid fetching 10k messages locally
        // add/remove terms to control recall vs cost
        QUERY_TERMS: [
            "apply",
            "application",
            "\"thank you for applying\"",
            "candidate",
            "candidacy",
            "recruit",
            "recruiter",
            "hiring",
            "interview",
            "intern",
            "internship",
            "position",
            "role",
            "career",
            "opportunity",
            "assessment",
            "\"next steps\""
        ],

        // client-side check to prevent false positives
        JOB_SIGNAL_REGEX:
            /\b(apply|application|candidate|candidacy|recruit|recruiter|hiring|interview|internship|intern|position|role|career|opportunity|assessment|offer|greenhouse|workday|lever|ashby|smartrecruiters)\b/i,

        // newsletter indicators (not “job keywords”)
        BULK_HEADER_NAMES: ["List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"],
        BULK_HEADER_REGEX:
            /(list-unsubscribe|list-id|precedence|auto-submitted)/i,

        // if it’s bulk AND it doesn’t have job signals, skip llm request
        SKIP_BULK_IF_NO_JOB_SIGNALS: true,

        // groq
        GROQ_BASE_URL: "https://api.groq.com/openai/v1/chat/completions",
        GROQ_MODEL: "openai/gpt-oss-20b",
        GROQ_BATCH_SIZE: 5,
        GROQ_MAX_COMPLETION_TOKENS: 250,
        GROQ_REASONING_EFFORT: "low",

        // only label when model is confident
        MIN_CONFIDENCE_TO_LABEL: 0.80,

        // debugging
        LOG_RAW_GROQ_RESPONSE_ON_PARSE_FAIL: true
    };

    function nowMs() {
        return new Date().getTime();
    }

    function sleepMs(ms) {
        Utilities.sleep(ms);
    }

    function chunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) {
            out.push(arr.slice(i, i + size));
        }
        return out;
    }

    function headerMap(headers) {
        const map = {};
        (headers || []).forEach((h) => {
            if (!h || !h.name) return;
            map[h.name] = h.value || "";
        });
        return map;
    }

    function isLikelyBulk(headersObj) {
        return Object.keys(headersObj).some((k) => CONFIG.BULK_HEADER_REGEX.test(k));
    }

    function hasJobSignals(text) {
        return CONFIG.JOB_SIGNAL_REGEX.test(text || "");
    }

    function buildGmailQuery() {
        const terms = CONFIG.QUERY_TERMS.join(" OR ");
        const base = `in:inbox (${terms})`;
        const notRejected = `-label:"${CONFIG.REJECTION_LABEL_NAME}"`;
        const notScanned = CONFIG.USE_SCANNED_LABEL
            ? `-label:"${CONFIG.SCANNED_LABEL_NAME}"`
            : "";
        return [base, notRejected, notScanned].filter(Boolean).join(" ");
    }

    function ensureLabel({
                             name,
                             labelListVisibility,
                             messageListVisibility
                         }) {
        const res = Gmail.Users.Labels.list(CONFIG.USER_ID);
        const labels = (res && res.labels) || [];
        const existing = labels.find((l) => l.name === name);

        if (existing) return existing;

        const created = Gmail.Users.Labels.create(
            {
                name,
                labelListVisibility,
                messageListVisibility
            },
            CONFIG.USER_ID
        );

        return created;
    }

    function listCandidateMessageIds(query) {
        const ids = [];
        let pageToken = undefined;

        do {
            const resp = Gmail.Users.Messages.list(CONFIG.USER_ID, {
                q: query,
                maxResults: CONFIG.LIST_PAGE_SIZE,
                pageToken
            });

            const messages = (resp && resp.messages) || [];
            messages.forEach((m) => {
                if (m && m.id) ids.push(m.id);
            });

            pageToken = resp && resp.nextPageToken ? resp.nextPageToken : undefined;

            // only need one page per run because we re-run via trigger
            break;
        } while (pageToken);

        return ids;
    }

    function getMessageMetadata(messageId) {
        // metadata returns headers and snippet, avoids pulling full body
        return Gmail.Users.Messages.get(CONFIG.USER_ID, messageId, {
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"].concat(CONFIG.BULK_HEADER_NAMES)
        });
    }

    function safeJsonExtract(text) {
        if (!text) return null;

        // strip common code-fence wrappers
        const cleaned = text
            .replace(/^\s*```json\s*/i, "")
            .replace(/^\s*```\s*/i, "")
            .replace(/\s*```\s*$/i, "")
            .trim();

        try {
            return JSON.parse(cleaned);
        } catch (_) {
            // try to salvage by finding { ... } block
            const start = cleaned.indexOf("{");
            const end = cleaned.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                const slice = cleaned.slice(start, end + 1);
                return JSON.parse(slice);
            }
            return null;
        }
    }

    function callGroqClassify(batch) {
        const apiKey = ENV && ENV.GROQ_KEY ? ENV.GROQ_KEY : null;
        if (!apiKey) throw new Error("Missing ENV.GROQ_KEY");

        const schema = {
            name: "job_rejection_classifier",
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    results: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                id: { type: "string" },
                                verdict: { type: "string", enum: ["REJECT", "OTHER"] },
                                confidence: { type: "number" }
                            },
                            required: ["id", "verdict", "confidence"]
                        }
                    }
                },
                required: ["results"]
            }
        };

        const system = [
            "You classify emails.",
            "Return ONLY JSON that matches the provided schema.",
            "",
            "Return verdict REJECT only if BOTH are true:",
            "1) The email is about a job/internship application for the recipient.",
            "2) It clearly indicates rejection / non-advancement.",
            "",
            "Marketing/promotions/newsletters/game updates must be OTHER."
        ].join("\n");

        const user = [
            "Classify each item. Keep confidence between 0 and 1.",
            "Do not include markdown or code fences.",
            "",
            "ITEMS:",
            JSON.stringify(
                batch.map((b) => ({
                    id: b.id,
                    subject: b.subject,
                    snippet: b.snippet
                }))
            )
        ].join("\n");

        const payload = {
            model: CONFIG.GROQ_MODEL,
            temperature: 0,
            max_completion_tokens: CONFIG.GROQ_MAX_COMPLETION_TOKENS,
            reasoning_effort: CONFIG.GROQ_REASONING_EFFORT,
            response_format: {
                type: "json_schema",
                json_schema: schema
            },
            messages: [
                { role: "system", content: system },
                { role: "user", content: user }
            ]
        };

        const options = {
            method: "post",
            contentType: "application/json",
            payload: JSON.stringify(payload),
            muteHttpExceptions: true,
            headers: {
                Authorization: `Bearer ${apiKey}`
            }
        };

        function extractRetryDelayMs(raw) {
            try {
                const parsedErr = JSON.parse(raw);
                const msg = String(
                    parsedErr &&
                    parsedErr.error &&
                    parsedErr.error.message
                        ? parsedErr.error.message
                        : ""
                );
                const m = msg.match(/try again in\s+([0-9.]+)s/i);
                if (m && m[1]) {
                    return Math.ceil(Number(m[1]) * 1000) + 500;
                }
            } catch (_) {
                // ignore
            }
            return null;
        }

        function isJsonValidateFailed(raw) {
            try {
                const parsedErr = JSON.parse(raw);
                return (
                    parsedErr &&
                    parsedErr.error &&
                    parsedErr.error.code === "json_validate_failed"
                );
            } catch (_) {
                return false;
            }
        }

        function runOnce() {
            const resp = UrlFetchApp.fetch(CONFIG.GROQ_BASE_URL, options);
            const code = resp.getResponseCode();
            const raw = resp.getContentText();

            if (code === 429 || code === 503) {
                const retryMs = extractRetryDelayMs(raw);
                const delayMs = retryMs !== null ? retryMs : 2000;
                sleepMs(delayMs);
                return runOnce();
            }

            if (code < 200 || code >= 300) {
                throw new Error(`Groq error ${code}: ${raw}`);
            }

            const json = safeJsonExtract(raw);
            const content =
                json &&
                json.choices &&
                json.choices[0] &&
                json.choices[0].message &&
                json.choices[0].message.content
                    ? json.choices[0].message.content
                    : null;

            const parsed = safeJsonExtract(content);

            if (!parsed || !parsed.results) {
                if (CONFIG.LOG_RAW_GROQ_RESPONSE_ON_PARSE_FAIL) {
                    console.log("Groq raw response: " + raw);
                    console.log("Groq content: " + content);
                }
                throw new Error("Groq response did not match expected JSON shape.");
            }

            return parsed.results;
        }

        try {
            return runOnce();
        } catch (e) {
            const msg = String(e && e.message ? e.message : e);

            // If schema validation fails, split the batch smaller and retry.
            if (msg.includes("json_validate_failed") && batch.length > 1) {
                const mid = Math.ceil(batch.length / 2);
                const left = batch.slice(0, mid);
                const right = batch.slice(mid);

                const leftResults = callGroqClassify(left);
                const rightResults = callGroqClassify(right);

                return leftResults.concat(rightResults);
            }

            throw e;
        }
    }

    function batchAddLabel(messageIds, labelId) {
        if (!messageIds.length) return;

        // gmail API batchModify allows up to 1000 ids per request
        const chunks = chunk(messageIds, 1000);
        chunks.forEach((ids) => {
            Gmail.Users.Messages.batchModify(
                {
                    ids,
                    addLabelIds: [labelId],
                    removeLabelIds: []
                },
                CONFIG.USER_ID
            );
        });
    }

    function run() {
        const start = nowMs();

        const rejectionLabel = ensureLabel({
            name: CONFIG.REJECTION_LABEL_NAME,
            labelListVisibility: "labelShow",
            messageListVisibility: "show"
        });

        const scannedLabel = CONFIG.USE_SCANNED_LABEL
            ? ensureLabel({
                name: CONFIG.SCANNED_LABEL_NAME,
                labelListVisibility: "labelHide",
                messageListVisibility: "hide"
            })
            : null;

        const query = buildGmailQuery();
        console.log("JobRejectionHandler query: " + query);

        const messageIds = listCandidateMessageIds(query);
        if (!messageIds.length) {
            console.log("No candidate emails found for this query. Done.");
            return {
                processed: 0,
                sentToGroq: 0,
                labeledRejections: 0
            };
        }

        const candidates = [];
        const scanned = [];

        for (let i = 0; i < messageIds.length; i++) {
            if (nowMs() - start > CONFIG.MAX_RUNTIME_MS) break;

            const id = messageIds[i];
            const msg = getMessageMetadata(id);

            const headers = headerMap(msg.payload && msg.payload.headers);
            const subject = headers.Subject || "";
            const from = headers.From || "";
            const date = headers.Date || "";
            const snippet = msg.snippet || "";

            const combined = `${subject}\n${snippet}`;

            const bulk = isLikelyBulk(headers);
            const jobSignals = hasJobSignals(combined);

            scanned.push(id);

            if (CONFIG.SKIP_BULK_IF_NO_JOB_SIGNALS && bulk && !jobSignals) {
                continue;
            }

            // if it matched the gmail query but still doesn’t look
            // job-related, don’t spend llm tokens
            if (!jobSignals) continue;

            candidates.push({
                id,
                from,
                subject,
                date,
                snippet
            });
        }

        console.log(
            `Fetched ${messageIds.length} IDs, ${candidates.length} candidates for LLM.`
        );

        const rejectionIds = [];
        let sentToGroq = 0;

        const aiBatches = chunk(candidates, CONFIG.GROQ_BATCH_SIZE);
        for (let b = 0; b < aiBatches.length; b++) {
            if (nowMs() - start > CONFIG.MAX_RUNTIME_MS) break;

            const batch = aiBatches[b];
            sentToGroq += batch.length;

            const results = callGroqClassify(batch);

            // normalize results into a map for safety
            const byId = {};
            results.forEach((r) => {
                if (r && r.id) byId[r.id] = r;
            });

            batch.forEach((item) => {
                const r = byId[item.id];
                if (!r) return;

                const verdict = String(r.verdict || "").toUpperCase().trim();
                const confidence = Number(r.confidence || 0);

                if (verdict === "REJECT" && confidence >= CONFIG.MIN_CONFIDENCE_TO_LABEL) {
                    rejectionIds.push(item.id);
                }
            });

            // small pacing to be nice to Groq
            sleepMs(200);
        }

        // apply the job rejection label (cheap with batchModify)
        batchAddLabel(rejectionIds, rejectionLabel.id);

        // mark scanned invisibly (hidden label)
        if (CONFIG.USE_SCANNED_LABEL && scannedLabel) {
            batchAddLabel(scanned, scannedLabel.id);
        }

        console.log(
            `Processed: ${scanned.length}, SentToGroq: ${sentToGroq}, LabeledRejections: ${rejectionIds.length}`
        );

        return {
            processed: scanned.length,
            sentToGroq,
            labeledRejections: rejectionIds.length
        };
    }

    function reset() {
        // incase a rescan is needed, delete the hidden scanned label
        // in gmail settings, or set USE_SCANNED_LABEL=false temporarily
        console.log("Nothing to reset in properties (state is label-based).");
    }

    return { run, reset };
})();