function testConnection() {
    console.log("Magikmail is online.");
    const threads = GmailApp.getInboxUnreadCount();
    console.log("You have " + threads + " unread emails.");
}