// Alternate accessibility UI can remain revealed without moving the system pointer.
import ApplicationServices

final class AXHover {
    /// Only diagnostic clients without a connection policy may opt in per request.
    static func requireSystemPointer(connectionSetting: Bool?, requestSetting: Bool?) throws {
        guard connectionSetting ?? requestSetting ?? false else {
            throw NativeFailure(code: "HOVER_UNAVAILABLE", message: "No enabled element at this target or in its ancestors offers both AXShowAlternateUI and AXShowDefaultUI. System-pointer hover is disabled; this provider has no other pointer-free hover route. No input was sent and the pointer did not move. Use click on an available control or performAction with an action from listActions.")
        }
    }

    private var revealed: (element: AXUIElement, windowID: UInt32)?

    /// Entering revealed descendants preserves their parent UI; leaving restores it once.
    func move(to target: AXUIElement?, in windowID: UInt32, access: AXAccess) throws -> Bool {
        var current = target
        var visited: [AXUIElement] = []
        var alternate: AXUIElement?
        while let node = current {
            guard !visited.contains(where: { CFEqual($0, node) }) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility hover ancestry contains a cycle; read fresh state")
            }
            visited.append(node)
            if let revealed, revealed.windowID == windowID, CFEqual(revealed.element, node) { return true }
            let actions = try access.actions(node)
            if alternate == nil, actions.contains("AXShowAlternateUI"), actions.contains("AXShowDefaultUI"),
               try access.boolean(node, "AXEnabled") != false { alternate = node }
            let role = try access.string(node, "AXRole")
            if role == "AXWindow" || role == "AXSheet" || role == "AXApplication" { break }
            current = try access.element(node, "AXParent")
        }
        let leaving = revealed != nil
        if let revealed {
            try access.perform(revealed.element, "AXShowDefaultUI")
            self.revealed = nil
        }
        if let alternate {
            try access.perform(alternate, "AXShowAlternateUI")
            revealed = (alternate, windowID)
            return true
        }
        return leaving
    }
}
