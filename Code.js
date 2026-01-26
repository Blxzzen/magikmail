function main() {
    console.log("Magikmail: Starting Batch Scan");

    const startTime = new Date().getTime();
    const SIX_MINUTES_MS = 6 * 60 * 1000;
    const SAFETY_BUFFER = 60 * 1000; // Stop 1 minute early to be safe

    let totalProcessedInThisRun = 0;
    let isFinished = false;

    // Loop until either run out of emails or run out of time
    while (new Date().getTime() - startTime < SIX_MINUTES_MS - SAFETY_BUFFER) {

        // Process one batch of 25
        const rejectionCount = JobRejectionHandler.handleInbox();

        // If handleInbox returns 0, it means the search found NO emails
        if (rejectionCount === 0) {
            // Check if done by seeing if the search is empty
            const testSearch = GmailApp.search("in:inbox -label:Job Rejection", 0, 1);
            if (testSearch.length === 0) {
                isFinished = true;
                break;
            }
        }

        totalProcessedInThisRun += 25;
        console.log(`Current Run Progress: ~${totalProcessedInThisRun} emails checked...`);

        // Gemini Free Tier (15 requests per minute)
        // 60 seconds / 15 requests = 4 seconds per request.
        Utilities.sleep(4500);
    }

    // Handle triggers
    if (!isFinished) {
        console.log("Time window closing. Scheduling next run in 1 minute...");
        setupTrigger();
    } else {
        console.log("SUCCESS: All emails scanned. Clearing triggers.");
        clearTriggers();
    }
}

/**
 * Helper to clean up old triggers
 */
function clearTriggers() {
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
}

/**
 * Helper to create the next wake-up call
 */
function setupTrigger() {
    clearTriggers();
    ScriptApp.newTrigger('main')
        .timeBased()
        .after(60 * 1000)
        .create();
}