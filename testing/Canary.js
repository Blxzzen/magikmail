// Check if Gmail daily premium restrictions have been lifted
function checkQuota() {
    try {
        const count = GmailApp.search('is:unread', 0, 1).length;
        console.log("Quota reset, good to run.");
    } catch (e) {
        console.error("Still LIMITED, " + e.message);
    }
}