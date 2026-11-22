// Restore a selected window while preserving the user's choice of foreground application.
import ApplicationServices
import Foundation

enum WindowForShow {
    case unchanged(UInt32?, visible: Bool)
    case minimized(UInt32, AXUIElement)
}

extension AXWorker {
    func showWindow(_ requested: UInt32?, owner: ProcessIdentity, access: AXAccess, cancellation: CancellationLatch,
                    axTimeout: Float, sessionState: @escaping @Sendable () -> Bool?) async throws -> JSONValue {
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
        guard let pid = initial.pid else { throw unavailable("Cannot identify the application to return focus to.") }
        guard WindowSpaces().memberships(windowIDs: [id])[id]?.onCurrentSpace == true else {
            throw unavailable("Cannot confirm the minimized window is on the current Space.")
        }
        let operation = try await WindowRestoration(owner: owner, id: id, window: window, access: access,
            previousPID: pid, previousWindow: initial.windowID, cancellation: cancellation, sessionState: sessionState,
            animation: ApplicationCatalog.animationDuration, timeout: axTimeout)
        try await operation.run(on: self, initial: initial)
        return result(id, status: "restored", dispatched: true, changed: foregroundChange())
    }
}

private func unavailable(_ reason: String) -> NativeFailure {
    NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE", message: "\(reason) Inspect the window before using app.activate().")
}

/// Only the window and foreground captured for this request can receive restoration actions.
private final class WindowRestoration {
    let owner: ProcessIdentity
    let id: UInt32
    let window: AXUIElement
    let access: AXAccess
    let original: ProcessIdentity
    let originalAX: AXUIElement?
    let originalID: UInt32?
    let cancellation: CancellationLatch
    let sessionState: @Sendable () -> Bool?
    let animation: Double
    let deadline: ContinuousClock.Instant
    private var handoffPending = false

    init(owner: ProcessIdentity, id: UInt32, window: AXUIElement, access: AXAccess, previousPID: Int32,
         previousWindow: UInt32?, cancellation: CancellationLatch, sessionState: @escaping @Sendable () -> Bool?,
         animation: Double, timeout: Float) throws {
        self.owner = owner
        self.id = id
        self.window = window
        self.access = access
        original = try NativePlatform.identity(previousPID)
        originalAX = try access.element(AXUIElementCreateApplication(previousPID), "AXFocusedWindow")
        originalID = try originalAX.flatMap { try access.windowID($0) } ?? previousWindow
        self.cancellation = cancellation
        self.sessionState = sessionState
        self.animation = animation
        deadline = ContinuousClock.now + .seconds(Double(timeout))
    }

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

    func restoreFocus(on worker: isolated AXWorker) async throws {
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
    func waitForDisplay(on worker: isolated AXWorker) async throws -> Bool {
        let until = min(deadline, ContinuousClock.now + .seconds(animation))
        while try !visible() {
            try cancellation.check()
            try NativePlatform.requireUnlocked(sessionState())
            if userSwitched() || ContinuousClock.now >= until { return false }
            try await restoreFocus(on: worker)
            try await Task.sleep(for: .milliseconds(16))
        }
        return true
    }

    func run(on worker: isolated AXWorker, initial: (pid: Int32?, windowID: UInt32?)) async throws {
        try checkTarget()
        guard NativePlatform.foregroundAppWindow() == initial else { throw unavailable("The foreground changed before restoration.") }
        do {
            let app = AXUIElementCreateApplication(owner.pid)
            let hidden = try access.boolean(app, "AXHidden") == true
            var shown = false
            if !hidden, try access.raiseForShow(window) { shown = try await waitForDisplay(on: worker) }
            if !shown && !userSwitched() {
                try checkTarget()
                if hidden, try access.writable(app, "AXHidden") == true { try access.setAttribute(app, "AXHidden", .bool(false)) }
                if try access.boolean(window, "AXMinimized") == true, try access.writable(window, "AXMinimized") == true {
                    try access.setAttribute(window, "AXMinimized", .bool(false))
                }
                shown = try await waitForDisplay(on: worker)
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
                try await restoreFocus(on: worker)
                if ContinuousClock.now >= settleBy { break }
                try await Task.sleep(for: .milliseconds(16))
            } while true
            guard try visible() else { throw unavailable("The selected window is not confirmed visible after restoration.") }
        } catch {
            if !handoffPending { try await restoreFocus(on: worker) }
            throw error
        }
    }
}
