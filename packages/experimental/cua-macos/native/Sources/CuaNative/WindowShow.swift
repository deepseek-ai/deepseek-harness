// Restore a selected window while preserving the user's choice of foreground application.
import ApplicationServices
import Foundation

enum WindowForShow {
    case unchanged(UInt32?, visible: Bool)
    case minimized(UInt32, AXUIElement)
}

extension AXWorker {
    func showWindow(_ requested: UInt32?, owner: ProcessIdentity, access: AXAccess, cancellation: CancellationLatch,
                    axTimeout: Float, sessionState: @Sendable () -> Bool?) async throws -> JSONValue {
        func result(_ id: UInt32?, status: String, dispatched: Bool, changed: JSONValue) -> JSONValue {
            .object(["windowId": id.map { .string(String($0)) } ?? .null, "dispatched": .bool(dispatched),
                     "status": .string(status), "foregroundChanged": changed])
        }
        let initial = NativePlatform.foregroundAppWindow()
        func foregroundChange() -> JSONValue {
            let final = NativePlatform.foregroundAppWindow()
            return ForegroundObservation.change(beforePID: initial.pid, beforeWindow: initial.windowID,
                                                afterPID: final.pid, afterWindow: final.windowID)
        }
        let selection = try access.selectWindowForShow(requested, owner: owner)
        let id: UInt32, window: AXUIElement
        switch selection {
        case .unchanged(let id, let visible):
            return result(id, status: visible ? "already_visible" : "unchanged", dispatched: false, changed: foregroundChange())
        case .minimized(let selected, let element):
            id = selected
            window = element
        }
        func unavailable(_ reason: String) -> NativeFailure {
            NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE", message: "\(reason) Inspect the window before using app.activate().")
        }
        guard let pid = initial.pid else { throw unavailable("Cannot identify the application to return focus to.") }
        let original = try NativePlatform.identity(pid)
        let originalAX = try access.element(AXUIElementCreateApplication(pid), "AXFocusedWindow")
        let originalID = try originalAX.flatMap { try access.windowID($0) } ?? initial.windowID
        guard WindowSpaces().memberships(windowIDs: [id])[id]?.onCurrentSpace == true else {
            throw unavailable("Cannot confirm the minimized window is on the current Space.")
        }
        let animation = await ApplicationCatalog.animationDuration
        let deadline = ContinuousClock.now + .seconds(Double(axTimeout))
        let app = AXUIElementCreateApplication(owner.pid)
        func checkTarget() throws {
            try cancellation.check()
            try NativePlatform.requireUnlocked(sessionState())
            try NativePlatform.verify(owner)
            _ = try NativePlatform.ownedWindow(owner.pid, id)
        }
        func visible() throws -> Bool {
            try access.boolean(window, "AXMinimized") == false && NativePlatform.ownedWindow(owner.pid, id).isOnScreen
        }
        func userSwitched() -> Bool {
            let front = NativePlatform.frontPID()
            return front != original.pid && front != owner.pid
        }
        var handoffPending = false
        func restoreFocus() async throws {
            try NativePlatform.requireUnlocked(sessionState())
            var current = NativePlatform.foregroundAppWindow()
            let returningToOriginalApp = current.pid == owner.pid && original != owner
            if returningToOriginalApp {
                handoffPending = true
                try await ApplicationCatalog.returnFocus(to: original, from: owner)
                while NativePlatform.frontPID() == owner.pid {
                    try cancellation.check()
                    guard ContinuousClock.now < deadline else { throw unavailable("The previous application did not regain focus.") }
                    try await Task.sleep(for: .milliseconds(16))
                }
                current = NativePlatform.foregroundAppWindow()
            }
            handoffPending = false
            guard current.pid == original.pid, let originalID, returningToOriginalApp || original == owner else { return }
            let focused = try access.focusedWindowID(original.pid) ?? current.windowID
            guard focused != originalID else { return }
            // Within the target app, a third window may have been chosen by the user.
            if original == owner && focused != id { return }
            try NativePlatform.verify(original)
            guard let originalAX, try access.windowID(originalAX) == originalID,
                  try NativePlatform.ownedWindow(original.pid, originalID).isOnScreen,
                  try access.raiseForShow(originalAX) else { throw unavailable("The previous keyboard window could not be restored.") }
            guard try access.focusedWindowID(original.pid) == originalID else { throw unavailable("The previous keyboard window did not regain focus.") }
        }
        func waitForDisplay() async throws -> Bool {
            let until = min(deadline, ContinuousClock.now + .seconds(animation))
            while try !visible() {
                try cancellation.check()
                try NativePlatform.requireUnlocked(sessionState())
                if userSwitched() || ContinuousClock.now >= until { return false }
                try await restoreFocus()
                try await Task.sleep(for: .milliseconds(16))
            }
            return true
        }
        try checkTarget()
        guard NativePlatform.foregroundAppWindow() == initial else { throw unavailable("The foreground changed before restoration.") }
        do {
            let hidden = try access.boolean(app, "AXHidden") == true
            var shown = false
            if !hidden, try access.raiseForShow(window) { shown = try await waitForDisplay() }
            if !shown && !userSwitched() {
                try checkTarget()
                if hidden, try access.writable(app, "AXHidden") == true { try access.setAttribute(app, "AXHidden", .bool(false)) }
                if try access.boolean(window, "AXMinimized") == true, try access.writable(window, "AXMinimized") == true {
                    try access.setAttribute(window, "AXMinimized", .bool(false))
                }
                shown = try await waitForDisplay()
            }
            if !shown && !userSwitched() {
                try checkTarget()
                try await ApplicationCatalog.activateForShow(owner, whileUsing: original)
                if !userSwitched(), try access.boolean(window, "AXMinimized") == true {
                    if try access.writable(window, "AXMinimized") == true {
                        try access.setAttribute(window, "AXMinimized", .bool(false))
                    } else if try !access.raiseForShow(window) {
                        throw unavailable("The selected window does not support restoration.")
                    }
                }
            }
            // AppKit may deliver a foreground change during the restoration animation, after the AX request returns.
            let settleBy = min(deadline, ContinuousClock.now + .seconds(animation))
            repeat {
                try cancellation.check()
                if userSwitched() { break }
                try await restoreFocus()
                if ContinuousClock.now >= settleBy { break }
                try await Task.sleep(for: .milliseconds(16))
            } while true
            guard try visible() else { throw unavailable("The selected window is not confirmed visible after restoration.") }
        } catch {
            if !handoffPending { try await restoreFocus() }
            throw error
        }
        return result(id, status: "restored", dispatched: true, changed: foregroundChange())
    }
}
