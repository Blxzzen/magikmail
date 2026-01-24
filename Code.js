function main() {
    const status = JobRejectionHandler.deepScan();

    if (status === "CONTINUE") {
        console.log("Scheduling next phase in 1 minute...");

        // Clear old triggers to avoid clutter
        const triggers = ScriptApp.getProjectTriggers();
        triggers.forEach(t => ScriptApp.deleteTrigger(t));

        // Create a new trigger to run main again
        ScriptApp.newTrigger('main')
            .timeBased()
            .after(60 * 1000) // 60,000 ms = 1 minute
            .create();
    } else {
        console.log("All emails scanned! Cleaning up triggers.");
        const triggers = ScriptApp.getProjectTriggers();
        triggers.forEach(t => ScriptApp.deleteTrigger(t));
    }
}