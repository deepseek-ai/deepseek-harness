// Restore a selected window while preserving the user's choice of foreground application.
import ApplicationServices
import Foundation

enum WindowForShow {
    case visible(UInt32)
    case needs(ShowTarget)
}

enum ShowTarget {
    case window(UInt32, AXUIElement)
    case application
}

extension AXWorker {
    func showWindow(_ requested: UInt32?, owner: ProcessIdentity, access: AXAccess, cancellation: CancellationLatch,
                    axTimeout: Float, sessionState: @escaping @Sendable () -> Bool?) async throws -> JSONValue {
        func result(_ id: UInt32, dispatched: Bool, changed: JSONValue) -> JSONValue {
            .object(["windowId": .string(String(id)), "dispatched": .bool(dispatched),
                     "foregroundChanged": changed])
        }
        let initial = NativePlatform.foregroundAppWindow()
        func foregroundChange() -> JSONValue {
            let final = NativePlatform.foregroundAppWindow()
            return ForegroundObservation.change(beforePID: initial.pid, beforeWindow: initial.windowID,
                                                afterPID: final.pid, afterWindow: final.windowID)
        }
        let selection = try access.selectWindowForShow(requested, owner: owner)
        let target: ShowTarget
        switch selection {
        case .visible(let id): return result(id, dispatched: false, changed: foregroundChange())
        case .needs(let selected): target = selected
        }
        guard let pid = initial.pid else { throw unavailable("Cannot identify the application to return focus to.") }
        let operation = try await WindowRestoration(owner: owner, access: access, previousPID: pid,
            previousWindow: initial.windowID, cancellation: cancellation, sessionState: sessionState,
            animation: ApplicationCatalog.animationDuration, timeout: axTimeout)
        let shown = try await operation.run(target, on: self, initial: initial)
        return result(shown.id, dispatched: shown.dispatched, changed: foregroundChange())
    }
}

private func unavailable(_ reason: String) -> NativeFailure {
    NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE", message: "\(reason) Inspect the window before using app.activate().")
}

/// Only the window and foreground captured for this request can receive restoration actions.
private final class WindowRestoration {
    let owner: ProcessIdentity
    private var targetID: UInt32?
    let access: AXAccess
    let original: ProcessIdentity
    let originalAX: AXUIElement?
    let originalID: UInt32?
    let cancellation: CancellationLatch
    let sessionState: @Sendable () -> Bool?
    let animation: Double
    let deadline: ContinuousClock.Instant
    private var handoffPending = false

    init(owner: ProcessIdentity, access: AXAccess, previousPID: Int32,
         previousWindow: UInt32?, cancellation: CancellationLatch, sessionState: @escaping @Sendable () -> Bool?,
         animation: Double, timeout: Float) throws {
        self.owner = owner
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
        if let targetID { _ = try NativePlatform.ownedWindow(owner.pid, targetID) }
    }
    func visible(_ window: AXUIElement, id: UInt32) throws -> Bool {
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
            guard try await ApplicationCatalog.returnFocus(to: original, from: owner) else {
                handoffPending = false
                return
            }
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
        if original == owner && focused != targetID { return }
        try NativePlatform.verify(original)
        guard let originalAX, try access.windowID(originalAX) == originalID,
              try NativePlatform.ownedWindow(original.pid, originalID).isOnScreen,
              try access.raiseForShow(originalAX) else { throw unavailable("The previous keyboard window could not be restored.") }
        guard try access.focusedWindowID(original.pid) == originalID else { throw unavailable("The previous keyboard window did not regain focus.") }
    }
    func waitForDisplay(_ window: AXUIElement, id: UInt32, on worker: isolated AXWorker) async throws -> Bool {
        let until = min(deadline, ContinuousClock.now + .seconds(animation))
        while try !visible(window, id: id) {
            try cancellation.check()
            try NativePlatform.requireUnlocked(sessionState())
            if userSwitched() || ContinuousClock.now >= until { return false }
            try await restoreFocus(on: worker)
            try await Task.sleep(for: .milliseconds(16))
        }
        return true
    }

    private func restore(_ window: AXUIElement, id: UInt32, on worker: isolated AXWorker) async throws {
        let app = AXUIElementCreateApplication(owner.pid)
        let hidden = try access.boolean(app, "AXHidden") == true
        var shown = false
        if !hidden, try access.raiseForShow(window) { shown = try await waitForDisplay(window, id: id, on: worker) }
        if !shown && !userSwitched() {
            try checkTarget()
            if hidden, try access.writable(app, "AXHidden") == true { try access.setAttribute(app, "AXHidden", .bool(false)) }
            if try access.boolean(window, "AXMinimized") == true, try access.writable(window, "AXMinimized") == true {
                try access.setAttribute(window, "AXMinimized", .bool(false))
            }
            shown = try await waitForDisplay(window, id: id, on: worker)
        }
        if !shown && !userSwitched() {
            try checkTarget()
            guard try access.boolean(window, "AXMinimized") == true else { return }
            try await ApplicationCatalog.activateForShow(owner, whileUsing: original)
            if !userSwitched(), try access.boolean(window, "AXMinimized") == true {
                if try access.writable(window, "AXMinimized") == true {
                    try access.setAttribute(window, "AXMinimized", .bool(false))
                } else if try !access.raiseForShow(window) {
                    throw unavailable("The selected window does not support restoration.")
                }
            }
        }
    }

    private func visibleAppWindow() -> UInt32? {
        NativePlatform.topVisibleWindow(owner.pid)
    }

    /// Returns whether an unhide or reopen request was sent.
    private func reopen(on worker: isolated AXWorker) async throws -> Bool {
        if visibleAppWindow() != nil { return false }
        let hidden = try access.boolean(AXUIElementCreateApplication(owner.pid), "AXHidden") == true
        if hidden {
            try await ApplicationCatalog.unhideForShow(owner)
            let until = min(deadline, ContinuousClock.now + .seconds(animation))
            repeat {
                try checkTarget()
                if visibleAppWindow() != nil { return true }
                if userSwitched() || ContinuousClock.now >= until { break }
                try await restoreFocus(on: worker)
                try await Task.sleep(for: .milliseconds(16))
            } while true
        }
        try checkTarget()
        if visibleAppWindow() != nil { return hidden }
        guard !userSwitched() else { throw unavailable("The foreground changed before the application could reopen.") }
        try ApplicationReopen.send(to: owner)
        // Leave the final animation interval for focus handoff and verification.
        let until = deadline - .seconds(animation)
        while true {
            try checkTarget()
            if visibleAppWindow() != nil { return true }
            try await restoreFocus(on: worker)
            guard !userSwitched(), ContinuousClock.now < until else {
                throw unavailable("The app was asked to reopen once, but no visible window was observed.")
            }
            try await Task.sleep(for: .milliseconds(16))
        }
    }

    func run(_ selection: ShowTarget, on worker: isolated AXWorker,
             initial: (pid: Int32?, windowID: UInt32?)) async throws -> (id: UInt32, dispatched: Bool) {
        try checkTarget()
        guard NativePlatform.foregroundAppWindow() == initial else { throw unavailable("The foreground changed before restoration.") }
        do {
            let dispatched: Bool
            switch selection {
            case .window(let id, let window):
                targetID = id
                guard WindowSpaces().memberships(windowIDs: [id])[id]?.onCurrentSpace == true else {
                    throw unavailable("Cannot confirm the selected window is on the current Space.")
                }
                try await restore(window, id: id, on: worker)
                dispatched = true
            case .application:
                dispatched = try await reopen(on: worker)
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
            switch selection {
            case .window(let id, let window):
                guard try visible(window, id: id) else {
                    throw NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE", message: "The selected window is not confirmed visible. Use app.show() to reopen the app if the window was closed.")
                }
                return (id, dispatched)
            case .application:
                guard let id = visibleAppWindow() else { throw unavailable("The application has no visible window after reopening.") }
                return (id, dispatched)
            }
        } catch {
            if !handoffPending { try await restoreFocus(on: worker) }
            throw error
        }
    }
}
