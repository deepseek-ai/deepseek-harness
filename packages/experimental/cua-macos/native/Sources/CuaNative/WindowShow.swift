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
    case shelf(UInt32)
}

extension AXWorker {
    func showWindow(_ requested: UInt32?, owner: ProcessIdentity, access: AXAccess, cancellation: CancellationLatch,
                    deadline: ContinuousClock.Instant, sessionState: @escaping @Sendable () -> Bool?, shelf: StageManagerShelf?) async throws -> JSONValue {
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
        let selection = try access.selectWindowForShow(requested, owner: owner, shelf: shelf)
        let target: ShowTarget
        switch selection {
        case .visible(let id): return result(id, dispatched: false, changed: foregroundChange())
        case .needs(let selected): target = selected
        }
        guard let pid = initial.pid else { throw unavailable("Cannot identify the application to return focus to.") }
        let operation = try await WindowRestoration(owner: owner, access: access, previousPID: pid,
            previousWindow: initial.windowID, cancellation: cancellation, sessionState: sessionState,
            animation: ApplicationCatalog.animationDuration, deadline: deadline, shelf: shelf, appScoped: requested == nil)
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
    let originalFrontWindow: UInt32?
    let originalAX: AXUIElement?
    let originalID: UInt32?
    let cancellation: CancellationLatch
    let sessionState: @Sendable () -> Bool?
    let animation: Double
    let deadline: ContinuousClock.Instant
    private let shelf: StageManagerShelf?
    private let appScoped: Bool
    private var stageActionSent = false
    private var handoffPending = false

    init(owner: ProcessIdentity, access: AXAccess, previousPID: Int32,
         previousWindow: UInt32?, cancellation: CancellationLatch, sessionState: @escaping @Sendable () -> Bool?,
         animation: Double, deadline: ContinuousClock.Instant, shelf: StageManagerShelf?, appScoped: Bool) throws {
        self.owner = owner
        self.shelf = shelf
        self.appScoped = appScoped
        self.access = access
        originalFrontWindow = previousWindow
        original = try NativePlatform.identity(previousPID)
        originalAX = try access.element(AXUIElementCreateApplication(previousPID), "AXFocusedWindow")
        originalID = try originalAX.flatMap { try access.windowID($0) } ?? previousWindow
        self.cancellation = cancellation
        self.sessionState = sessionState
        self.animation = animation
        self.deadline = deadline
    }

    func checkTarget() throws {
        try cancellation.check()
        try NativePlatform.requireUnlocked(sessionState())
        try NativePlatform.verify(owner)
        if let targetID { _ = try NativePlatform.ownedWindow(owner.pid, targetID) }
    }
    func visible(_ window: AXUIElement, id: UInt32) throws -> Bool {
        guard try access.boolean(window, "AXMinimized") == false else { return false }
        return try access.displayedForShow(NativePlatform.ownedWindow(owner.pid, id), window: window,
                                           shelf: shelf, piles: shelf?.piles(access) ?? [])
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
            if let shelf, try shelf.piles(access).contains(where: { $0.ids.contains(id) }) {
                _ = try await joinStage(id, exact: true, on: worker)
                return try visible(window, id: id)
            }
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

    /// The system action moves a window into the active group. Switching groups to activate the app does not join them.
    private func joinStage(_ id: UInt32, exact: Bool, on worker: isolated AXWorker) async throws -> UInt32 {
        guard let shelf else { throw unavailable("Stage Manager is unavailable.") }
        func expanded() throws -> UInt32? {
            if case .visible(let shown) = try access.selectWindowForShow(exact ? id : nil, owner: owner, shelf: shelf) { return shown }
            return nil
        }
        try checkTarget()
        guard !userSwitched() else { throw unavailable("The active group changed before the window could be added.") }
        try await restoreFocus(on: worker)
        // The strip can report transformed bounds before publishing the pile's accessibility button.
        let readyBy = min(deadline, ContinuousClock.now + .seconds(animation * 2))
        var pile: StageManagerShelf.Pile?
        repeat {
            if let already = try expanded() { return already }
            pile = try shelf.piles(access).first { $0.ids.contains(id) }
            if pile != nil || userSwitched() || ContinuousClock.now >= readyBy { break }
            try await Task.sleep(for: .milliseconds(16))
        } while true
        guard !stageActionSent, let pile else {
            throw unavailable("Stage Manager has not exposed a selectable pile for the full-size window.")
        }
        try checkTarget()
        try shelf.join(pile, windowID: id, owner: owner, appScoped: !exact, foreground: (original.pid, originalFrontWindow), access: access)
        stageActionSent = true
        // Some apps accept the pile action but only leave the strip after receiving activation.
        let transition = Duration.seconds(animation * 2)
        let activateAfter = ContinuousClock.now + transition
        var activationTime: ContinuousClock.Instant?
        var expandedSince: ContinuousClock.Instant?
        var interruptedSince: ContinuousClock.Instant?
        repeat {
            try checkTarget()
            let now = ContinuousClock.now
            let shown = try expanded()
            if userSwitched() {
                interruptedSince = interruptedSince ?? now
                if let start = interruptedSince, now - start >= transition {
                    throw unavailable("The active application changed while Stage Manager was adding the window.")
                }
            } else {
                interruptedSince = nil
                if shown == nil, activationTime == nil, now >= activateAfter,
                   NativePlatform.foregroundAppWindow() == (original.pid, originalFrontWindow) {
                    activationTime = now
                    try await ApplicationCatalog.activateForShow(owner, whileUsing: original)
                }
                let handoffBy = (activationTime ?? activateAfter) + transition
                if shown != nil || now >= handoffBy { try await restoreFocus(on: worker) }
            }
            if let shown, NativePlatform.frontPID() == original.pid, try originalWindowIsExpanded() {
                expandedSince = expandedSince ?? now
                if let start = expandedSince, now - start >= .seconds(animation), try expanded() == shown { return shown }
            } else {
                expandedSince = nil
            }
            guard now < deadline - .seconds(animation) else {
                throw unavailable("The window was not confirmed expanded in the original stage after Add Window to Stage.")
            }
            try await Task.sleep(for: .milliseconds(16))
        } while true
    }

    private func originalWindowIsExpanded() throws -> Bool {
        guard let id = originalFrontWindow else { return true }
        let info = try NativePlatform.ownedWindow(original.pid, id)
        guard info.isOnScreen else { return false }
        if let originalAX, try access.windowID(originalAX) == id, let bounds = try access.bounds(originalAX) {
            return StageManagerShelf.matchesWindowSize(info.bounds, bounds)
        }
        return NativePlatform.foregroundAppWindow() == (original.pid, id)
    }

    private func visibleAppWindow(on worker: isolated AXWorker, allowGrouping: Bool) async throws -> UInt32? {
        guard let shelf else { return NativePlatform.topVisibleWindow(owner.pid) }
        switch try access.selectWindowForShow(nil, owner: owner, shelf: shelf) {
        case .visible(let id): return id
        case .needs(.shelf(let id)) where allowGrouping: return try await joinStage(id, exact: false, on: worker)
        default: return nil
        }
    }

    /// Returns whether an unhide or reopen request was sent.
    private func reopen(on worker: isolated AXWorker) async throws -> Bool {
        if try await visibleAppWindow(on: worker, allowGrouping: true) != nil { return stageActionSent }
        let hidden = try access.boolean(AXUIElementCreateApplication(owner.pid), "AXHidden") == true
        if hidden {
            try await ApplicationCatalog.unhideForShow(owner)
            let until = min(deadline, ContinuousClock.now + .seconds(animation))
            repeat {
                try checkTarget()
                if try await visibleAppWindow(on: worker, allowGrouping: true) != nil { return true }
                if userSwitched() || ContinuousClock.now >= until { break }
                try await restoreFocus(on: worker)
                try await Task.sleep(for: .milliseconds(16))
            } while true
        }
        try checkTarget()
        if try await visibleAppWindow(on: worker, allowGrouping: true) != nil { return hidden || stageActionSent }
        guard !userSwitched() else { throw unavailable("The foreground changed before the application could reopen.") }
        try ApplicationReopen.send(to: owner)
        // Leave the final animation interval for focus handoff and verification.
        let until = deadline - .seconds(animation)
        while true {
            try checkTarget()
            if try await visibleAppWindow(on: worker, allowGrouping: true) != nil { return true }
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
            case .shelf(let id):
                targetID = appScoped ? nil : id
                targetID = try await joinStage(id, exact: !appScoped, on: worker)
                dispatched = stageActionSent
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
            case .shelf:
                guard let targetID,
                      case .visible(let id) = try access.selectWindowForShow(targetID, owner: owner, shelf: shelf) else {
                    throw unavailable("The window did not remain expanded in the original stage.")
                }
                return (id, dispatched)
            case .application:
                guard let id = try await visibleAppWindow(on: worker, allowGrouping: false) else { throw unavailable("The application has no visible window after reopening.") }
                return (id, dispatched)
            }
        } catch {
            if !handoffPending { try await restoreFocus(on: worker) }
            throw error
        }
    }
}
