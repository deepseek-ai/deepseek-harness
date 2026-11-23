// Send the Dock reopen event to the selected process, including when another copy of the app is running.
import AppKit
import Carbon

enum ApplicationReopen {
    static func send(to owner: ProcessIdentity) throws {
        try NativePlatform.verify(owner)
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
            targetDescriptor: NSAppleEventDescriptor(processIdentifier: owner.pid),
            returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        do {
            _ = try event.sendEvent(options: [.noReply, .neverInteract], timeout: 0)
        } catch {
            throw NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE",
                                message: "macOS could not send the reopen request: \(error.localizedDescription). Inspect the app before retrying.")
        }
    }
}
