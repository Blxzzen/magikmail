const JobRejectionHandler = {
    LABEL_NAME: "Job Rejection",
    BATCH_SIZE: 25,

    /**
     * calls gemini api to classify a batch of emails
     */
    getAIClassifications: function (snippets) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${ENV.GEMINI_API_KEY}`;

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
            const json = JSON.parse(response.getContentText());
            return JSON.parse(json.candidates[0].content.parts[0].text);
        } catch (e) {
            console.error("AI classification failed: " + e);
            return [];
        }
    },

    /**
     * fetches emails, makes a gemini call, and applies labels
     */
    handleInbox: function () {
        console.log("Magikmail: Fetching next batch of 25...");
        const label = this.getOrCreateLabel();

        // Fetch 25 emails that haven't been processed yet
        const threads = GmailApp.search(`in:inbox -label:${this.LABEL_NAME}`, 0, this.BATCH_SIZE);

        if (threads.length === 0) {
            console.log("Inbox clear! No more emails to process.");
            return 0;
        }

        // Prepare content for the gemini
        const snippets = threads.map(t => {
            const msg = t.getMessages()[0];
            return `From: ${msg.getFrom()} | Sub: ${msg.getSubject()} | Body: ${msg.getPlainBody().substring(0, 800)}`;
        });

        const results = this.getAIClassifications(snippets);

        // Apply labels based on what gemini returns
        let rejectionCount = 0;
        threads.forEach((thread, index) => {
            if (results[index] === "REJECT") {
                thread.addLabel(label);
                rejectionCount++;
            }
            // Future: Tag emails as Processed so they dont get scanned again
        });

        console.log(`Batch complete. Found ${rejectionCount} rejections.`);
        return rejectionCount;
    },

    getOrCreateLabel: function () {
        let label = GmailApp.getUserLabelByName(this.LABEL_NAME);
        return label || GmailApp.createLabel(this.LABEL_NAME);
    }
};