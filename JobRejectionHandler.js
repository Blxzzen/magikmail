const JobRejectionHandler = {
    // The label name
    LABEL_NAME: "Job Rejection",
    BATCH_SIZE: 100,
    MAX_PER_RUN: 500,

    // Keyphrases curated from samples
    REJECTION_PHRASES: [
        "not move forward with the interview process",
        "decided to move ahead with other candidates",
        "move forward with other applicants",
        "decided to move forward with other",
        "best of luck in your search",
        //"best in your job search", Kinda broken rn ngl probs won't ever get uncommented
        "not the news you were hoping for",
    ],

    /**
     * Scans the inbox in chunks and saves progress
     */
    deepScan: function() {
        const props = PropertiesService.getScriptProperties();
        // Get current offset (defaults to 0 if not set)
        let offset = parseInt(props.getProperty('SCAN_OFFSET') || '0');
        let totalLabeled = 0;
        const label = this.getOrCreateLabel();

        console.log(`Starting scan from offset: ${offset}`);

        // Loop until hit 500 emails for this specific run
        while (totalLabeled < this.MAX_PER_RUN) {
            // skip emails  already labeled
            const threads = GmailApp.search("-label:" + this.LABEL_NAME, offset, this.BATCH_SIZE);

            if (threads.length === 0) {
                console.log("Reached the end of the inbox.");
                props.setProperty('SCAN_OFFSET', '0'); // Reset for future unread-only scans
                return "FINISHED";
            }

            threads.forEach(thread => {
                const body = thread.getMessages()[0].getPlainBody().toLowerCase();
                if (this.REJECTION_PHRASES.some(p => body.includes(p))) {
                    thread.addLabel(label);
                }
            });

            offset += this.BATCH_SIZE;
            totalLabeled += this.BATCH_SIZE;

            // Save progress to Properties
            props.setProperty('SCAN_OFFSET', offset.toString());
            console.log(`Processed up to ${offset}...`);
        }

        return "CONTINUE";
    },

    /**
     * Helper to check the label exists in Gmail
     */
    getOrCreateLabel: function () {
        let label = GmailApp.getUserLabelByName(this.LABEL_NAME);
        if (!label) {
            label = GmailApp.createLabel(this.LABEL_NAME);
        }
        return label;
    },
};