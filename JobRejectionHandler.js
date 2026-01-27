const JobRejectionHandler = {
    LABEL_NAME: "Job Rejection",
    BATCH_SIZE: 100,

    /**
     * calls gemini api to classify a batch of emails
     */
    getAIClassifications: function (snippets) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${ENV.GEMINI_API_KEY}`;

        const prompt = `Analyze these ${snippets.length} emails. For each, determine if it is a job application rejection.
    Return ONLY a JSON array of strings: either "REJECT" or "OTHER". 
    Maintain the exact same order. 
    
    EMAILS:
    ${snippets.map((s, i) => `ID ${i}: ${s}`).join("\n---\n")}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        try {
            const response = UrlFetchApp.fetch(url, {
                method: "post",
                contentType: "application/json",
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            });

            const rawResponse = response.getContentText();
            const json = JSON.parse(rawResponse);

            if (json.candidates && json.candidates[0]) {
                return JSON.parse(json.candidates[0].content.parts[0].text);
            }

            console.log("failed to return candidates. Raw Response: " + rawResponse);
            return new Array(snippets.length).fill("OTHER");
        } catch (e) {
            console.error("classification failed: " + e);
            return new Array(snippets.length).fill("OTHER");
        }
    },

    /**
     * fetches emails, makes a gemini call, and applies labels
     */
    handleInbox: function () {
        console.log("Magikmail: Performing single search for 500 threads...");
        const label = this.getOrCreateLabel();

        // Search larger pool to minimize Service invoked too many times
        const allThreads = GmailApp.search(`in:inbox -label:"${this.LABEL_NAME}"`, 0, 500);

        if (allThreads.length === 0) {
            console.log("Inbox clear! No more emails to process.");
            return 0;
        }

        let totalRejectionsFound = 0;

        // Break 500 threads into chunks of 100 for LLM
        for (let i = 0; i < allThreads.length; i += this.BATCH_SIZE) {
            const chunk = allThreads.slice(i, i + this.BATCH_SIZE);

            const snippets = chunk.map(t => {
                const msg = t.getMessages()[0];
                return `From: ${msg.getFrom()} | Sub: ${msg.getSubject()} | Body: ${msg.getPlainBody().substring(0, 800)}`;
            });

            const results = this.getAIClassifications(snippets);

            if (Array.isArray(results) && results.length === chunk.length) {
                chunk.forEach((thread, index) => {
                    if (results[index] === "REJECT") {
                        thread.addLabel(label);
                        totalRejectionsFound++;
                    }
                });
            }

            console.log(`Processed chunk ${i/this.BATCH_SIZE + 1}. Total rejections so far: ${totalRejectionsFound}`);

            // Gemini rate limits between 100-count chunks
            if (i + this.BATCH_SIZE < allThreads.length) {
                Utilities.sleep(5000);
            }
        }

        return totalRejectionsFound;
    },

    getOrCreateLabel: function () {
        let label = GmailApp.getUserLabelByName(this.LABEL_NAME);
        return label || GmailApp.createLabel(this.LABEL_NAME);
    }
};