// One ledger orders key and pointer posts across the shared helper's workers and connections.
import CoreGraphics
import Foundation

/// The lock covers registration, dispatch, explicit release, and reverse-order cleanup.
final class HeldInputs: @unchecked Sendable {
    struct Scope: Equatable {
        let task: String
        let turn: Int
    }
    struct Owner: Equatable {
        let connection: UUID
        let scope: Scope
        let app: String
    }
    enum Mode: Equatable {
        case keyboard(CGKeyCode, CGEventFlags)
        case windowPointer(CGMouseButton, UInt32)
        case systemPointer(CGMouseButton, UInt32)
    }
    private struct Press {
        let owner: Owner
        let recipient: ProcessIdentity
        let mode: Mode
        let up: CGEvent
        let post: (CGEvent) -> Void
    }
    private let lock = NSLock()
    private var pressed: [Press] = []
    private var ended: [UUID: [String: Int]] = [:]

    func snapshot(pid: Int32) -> [CGKeyCode: CGEventFlags] {
        lock.withLock {
            Dictionary(uniqueKeysWithValues: pressed.compactMap {
                guard $0.recipient.pid == pid, case .keyboard(let code, let flag) = $0.mode else { return nil }
                return (code, flag)
            })
        }
    }

    private func admit(_ owner: Owner) throws {
        if let last = ended[owner.connection]?[owner.scope.task], owner.scope.turn <= last {
            throw NativeFailure(code: "INPUT_TURN_CLOSED", message: "Input for this turn has already been released")
        }
    }

    private func conflict(_ name: String, holder: Owner, caller: Owner) -> NativeFailure {
        let source: String
        if holder.connection != caller.connection { source = "another session" }
        else if holder.scope != caller.scope { source = "another turn" }
        else { source = "a different application handle in this turn" }
        return RequestParameters.invalid("Key '\(name)' is held for this target by \(source). No event was sent. Wait for the holder to release it or for its turn to end.")
    }

    /// Repeats retain the original recipient and do not change the cleanup order.
    func repeatIfHeld(owner: Owner, name: String, code: CGKeyCode, down: CGEvent, post: (CGEvent, Int32) -> Void) throws -> Bool {
        try lock.withLock {
            try admit(owner)
            guard let key = pressed.first(where: { $0.owner == owner && $0.mode.keyCode == code }) else { return false }
            guard case .keyboard(_, let flag) = key.mode, flag.isEmpty, down.type == .keyDown else {
                throw RequestParameters.invalid("Modifier '\(name)' is already held. Send 'up' to release it.")
            }
            try NativePlatform.verify(key.recipient)
            down.flags = flags(for: key.recipient)
            down.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
            post(down, key.recipient.pid)
            return true
        }
    }

    func keyDown(owner: Owner, recipient: ProcessIdentity, name: String, code: CGKeyCode, flag: CGEventFlags,
                 down: CGEvent, up: CGEvent, post: @escaping (CGEvent, Int32) -> Void) throws {
        try lock.withLock {
            try admit(owner)
            if let key = pressed.first(where: { $0.mode.keyCode == code && $0.recipient.pid == recipient.pid }) {
                throw conflict(name, holder: key.owner, caller: owner)
            }
            pressed.append(Press(owner: owner, recipient: recipient, mode: .keyboard(code, flag), up: up,
                                 post: { post($0, recipient.pid) }))
            down.flags = flags(for: recipient)
            post(down, recipient.pid)
        }
    }

    private func flags(for recipient: ProcessIdentity) -> CGEventFlags {
        pressed.reduce(into: CGEventFlags()) {
            if $1.recipient == recipient, case .keyboard(_, let flag) = $1.mode { $0.formUnion(flag) }
        }
    }

    /// System releases must reach the desktop even after the original process or window disappears.
    private func release(at index: Int) throws -> Bool {
        let press = pressed[index]
        if case .systemPointer = press.mode {
            if let point = CGEvent(source: nil)?.location { press.up.location = point }
        } else {
            do { try NativePlatform.verify(press.recipient) }
            catch let error as NativeFailure where error.code == "STALE_APP" || error.code == "APP_UNAVAILABLE" {
                pressed.remove(at: index)
                return false
            }
        }
        pressed.remove(at: index)
        if case .keyboard = press.mode { press.up.flags = flags(for: press.recipient) }
        press.post(press.up)
        return true
    }

    func keyUp(owner: Owner, name: String, code: CGKeyCode, recipientIfUnheld: () throws -> ProcessIdentity) throws -> Bool {
        let dispatched = try lock.withLock { () throws -> Bool? in
            guard let index = pressed.firstIndex(where: { $0.owner == owner && $0.mode.keyCode == code }) else { return nil }
            return try release(at: index)
        }
        if let dispatched { return dispatched }
        let recipient = try recipientIfUnheld()
        throw lock.withLock {
            if let key = pressed.first(where: { $0.mode.keyCode == code && $0.recipient == recipient }) {
                return conflict(name, holder: key.owner, caller: owner)
            }
            return RequestParameters.invalid("Key '\(name)' is not held for this target. Send 'down' in this turn before 'up'.")
        }
    }

    func pointerDown(owner: Owner, route: WindowRoute, button: CGMouseButton, system: Bool,
                     down: CGEvent, up: CGEvent, post: @escaping (CGEvent) -> Void) throws {
        try lock.withLock {
            try admit(owner)
            try checkPointerAvailable(route: route, button: button, system: system)
            pressed.append(Press(owner: owner, recipient: route.owner,
                mode: system ? .systemPointer(button, route.windowID) : .windowPointer(button, route.windowID), up: up, post: post))
            post(down)
        }
    }

    /// A balanced action cannot release another operation's held mouse button.
    func requirePointerAvailable(route: WindowRoute, button: CGMouseButton, system: Bool) throws {
        try lock.withLock { try checkPointerAvailable(route: route, button: button, system: system) }
    }

    private func checkPointerAvailable(route: WindowRoute, button: CGMouseButton, system: Bool) throws {
        if pressed.contains(where: { press in
            switch press.mode {
            case .keyboard: return false
            case .systemPointer: return true
            case .windowPointer(let held, _): return system || (held == button && press.recipient == route.owner)
            }
        }) { throw Self.pointerBusy }
    }

    /// The requested routing option is irrelevant to an up: use the route saved by its down.
    func pointerUp(owner: Owner, window: UInt32, button: CGMouseButton) throws -> Bool {
        try lock.withLock {
            guard let index = pressed.firstIndex(where: { $0.owner == owner && $0.mode.pointer == button && $0.mode.window == window }) else {
                throw RequestParameters.invalid("Release the mouse button through the same task, turn, application and window that pressed it")
            }
            return try release(at: index)
        }
    }

    /// Create and post movement under the same lock as ownership and the saved release point.
    func moveSystem(owner: Owner, route: WindowRoute, screen: CGPoint, checkCancellation: () throws -> Void) throws {
        try lock.withLock {
            try admit(owner)
            let press = pressed.first { if case .systemPointer = $0.mode { return true }; return false }
            let event: CGEvent
            if let press {
                guard press.owner == owner, press.recipient == route.owner, press.mode.window == route.windowID,
                      let button = press.mode.pointer else { throw Self.pointerBusy }
                event = try SystemPointerInput.event(WindowPointerInput.dragged(button), source: nil, at: screen,
                    button: button, group: press.up.getIntegerValueField(.mouseEventNumber))
                let previous = CGEvent(source: nil)?.location ?? press.up.location
                event.setIntegerValueField(.mouseEventDeltaX, value: Int64(screen.x.rounded() - previous.x.rounded()))
                event.setIntegerValueField(.mouseEventDeltaY, value: Int64(screen.y.rounded() - previous.y.rounded()))
            } else {
                event = try SystemPointerInput.event(.mouseMoved, source: nil, at: screen, button: .left, group: 0)
            }
            try checkCancellation()
            SystemPointerInput.post(event)
            press?.up.location = screen
        }
    }

    func release(connection: UUID, scope: Scope? = nil) throws {
        try lock.withLock {
            if let scope { ended[connection, default: [:]][scope.task] = max(ended[connection]?[scope.task] ?? 0, scope.turn) }
            defer { if scope == nil { ended.removeValue(forKey: connection) } }
            var failures: [String] = []
            for index in pressed.indices.reversed() {
                let owner = pressed[index].owner
                guard owner.connection == connection, scope == nil || owner.scope == scope else { continue }
                do { _ = try release(at: index) }
                catch { failures.append(String(describing: error)) }
            }
            if !failures.isEmpty { throw NativeFailure(code: "INPUT_CLEANUP_FAILED", message: failures.joined(separator: "; ")) }
        }
    }

    private static var pointerBusy: NativeFailure {
        NativeFailure(code: "INPUT_BUSY", message: "A mouse button is held; release it before dispatching a conflicting gesture")
    }
}

private extension HeldInputs.Mode {
    var keyCode: CGKeyCode? { if case .keyboard(let code, _) = self { return code }; return nil }
    var pointer: CGMouseButton? {
        switch self { case .keyboard: return nil; case .windowPointer(let button, _), .systemPointer(let button, _): return button }
    }
    var window: UInt32? {
        switch self { case .keyboard: return nil; case .windowPointer(_, let window), .systemPointer(_, let window): return window }
    }
}
