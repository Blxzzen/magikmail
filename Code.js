function main() {
    console.log("Magikmail: Starting Batch Scan");

    let isFinished = false;

    try {
        const res = JobRejectionHandler.run();

        const processed = Number(res && res.processed ? res.processed : 0);
        const sentToGroq = Number(res && res.sentToGroq ? res.sentToGroq : 0);
        const labeled = Number(res && res.labeledRejections ? res.labeledRejections : 0);

        console.log(
            `Current Run Progress: processed=${processed}, sentToGroq=${sentToGroq}, labeled=${labeled}`
        );

        if (processed === 0) {
            isFinished = true;
        }
    } catch (e) {
        console.error("Magikmail: main() failed: " + e);

        console.log("Scheduling retry in 10 minutes...");
        setupTrigger(10 * 60 * 1000);
        return;
    }

    if (!isFinished) {
        console.log("Scheduling next run in 2 minutes...");
        setupTrigger(2 * 60 * 1000);
    } else {
        console.log("SUCCESS: All emails scanned. Clearing triggers.");
        clearTriggers();
    }
}

function clearTriggers() {
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach((t) => ScriptApp.deleteTrigger(t));
}

function setupTrigger(afterMs) {
    clearTriggers();
    ScriptApp.newTrigger("main")
        .timeBased()
        .after(afterMs)
        .create();
}