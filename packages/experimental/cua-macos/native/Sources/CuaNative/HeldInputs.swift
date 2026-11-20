// One ledger orders key and pointer posts across the shared helper's workers and connections.
import CoreGraphics
import Foundation

/// The lock covers registration, dispatch, explicit release, and reverse-order cleanup.
final class HeldInputs: @unchecked Sendable {
    struct Owner: Equatable {
        let connection: UUID
        let app: String
    }
    enum Mode: Equatable {
        case keyboard(CGKeyCode, CGEventFlags, String, system: Bool)
        case windowPointer(CGMouseButton, UInt32)
        case systemPointer(CGMouseButton, UInt32)
    }
    private struct Press {
        let owner: Owner
        let recipient: ProcessIdentity
        let mode: Mode
        let up: CGEvent
        let post: (CGEvent) -> Void
        let prepareRelease: ((CGEvent) throws -> Void)?
    }
    private let lock = NSLock()
    private var pressed: [Press] = []

    private let systemFlags: () -> CGEventFlags

    init(systemFlags: @escaping () -> CGEventFlags = { CGEventSource.flagsState(.combinedSessionState) }) {
        self.systemFlags = systemFlags
    }

    func snapshot(pid: Int32, system: Bool = false) -> [CGKeyCode: CGEventFlags] {
        lock.withLock {
            Dictionary(uniqueKeysWithValues: pressed.compactMap {
                guard case .keyboard(let code, let flag, _, let viaSystem) = $0.mode, viaSystem == system,
                      system || $0.recipient.pid == pid else { return nil }
                return (code, flag)
            })
        }
    }

    private func conflict(_ name: String, holder: Owner, caller: Owner) -> NativeFailure {
        let source = holder.connection != caller.connection ? "another session" : "a different application handle"
        return RequestParameters.invalid("Key '\(name)' is held for this target by \(source). No event was sent. Wait for the holder to release it before using it.")
    }

    /// Repeats retain the original recipient and do not change the cleanup order.
    func repeatIfHeld(owner: Owner, name: String, code: CGKeyCode, down: CGEvent, system: Bool = false) throws -> Bool {
        try lock.withLock {
            guard let key = pressed.first(where: { $0.owner == owner && $0.mode.keyCode == code }) else { return false }
            guard key.mode.isSystem == system else { throw RequestParameters.invalid("Match useSystemInput to the held key") }
            guard case .keyboard(_, let flag, _, _) = key.mode, flag.isEmpty, down.type == .keyDown else {
                throw RequestParameters.invalid("Modifier '\(name)' is already held. Send 'up' to release it.")
            }
            try NativePlatform.verify(key.recipient)
            down.flags = flags(for: key.recipient, system: system)
            down.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
            key.post(down)
            return true
        }
    }

    func keyDown(owner: Owner, recipient: ProcessIdentity, name: String, code: CGKeyCode, flag: CGEventFlags,
                 down: CGEvent, up: CGEvent, system: Bool = false, post: @escaping (CGEvent) -> Void) throws {
        try lock.withLock {
            if let key = pressed.first(where: { $0.mode.keyCode == code && (($0.mode.isSystem && system) || $0.recipient.pid == recipient.pid) }) {
                throw conflict(name, holder: key.owner, caller: owner)
            }
            pressed.append(Press(owner: owner, recipient: recipient, mode: .keyboard(code, flag, name, system: system), up: up,
                                 post: post, prepareRelease: nil))
            down.flags = flags(for: recipient, system: system)
            post(down)
        }
    }

    private func flags(for recipient: ProcessIdentity, system: Bool, releasing: CGEventFlags = []) -> CGEventFlags {
        pressed.reduce(into: system ? systemFlags().subtracting(releasing) : CGEventFlags()) {
            if case .keyboard(_, let flag, _, let viaSystem) = $1.mode, system == viaSystem,
               system || $1.recipient == recipient { $0.formUnion(flag) }
        }
    }

    /// System releases must reach the desktop even after the original process or window disappears.
    private func release(at index: Int) throws -> Bool {
        let press = pressed[index]
        if case .systemPointer = press.mode {
            if let point = CGEvent(source: nil)?.location { press.up.location = point }
        } else if !press.mode.isSystem {
            do { try NativePlatform.verify(press.recipient) }
            catch let error as NativeFailure where error.code == "STALE_APP" || error.code == "APP_UNAVAILABLE" {
                pressed.remove(at: index)
                return false
            }
        }
        try press.prepareRelease?(press.up)
        pressed.remove(at: index)
        if case .keyboard(_, let flag, _, let system) = press.mode {
            press.up.flags = flags(for: press.recipient, system: system, releasing: flag)
        }
        press.post(press.up)
        return true
    }

    func keyUp(owner: Owner, name: String, code: CGKeyCode, system: Bool = false, recipientIfUnheld: () throws -> ProcessIdentity) throws -> Bool {
        let dispatched = try lock.withLock { () throws -> Bool? in
            guard let index = pressed.firstIndex(where: { $0.owner == owner && $0.mode.keyCode == code }) else { return nil }
            guard pressed[index].mode.isSystem == system else { throw RequestParameters.invalid("Match useSystemInput to the held key") }
            return try release(at: index)
        }
        if let dispatched { return dispatched }
        let recipient = try recipientIfUnheld()
        throw lock.withLock {
            if let key = pressed.first(where: { $0.mode.keyCode == code && $0.recipient == recipient }) {
                return conflict(name, holder: key.owner, caller: owner)
            }
            return RequestParameters.invalid("Key '\(name)' is not held for this target. Send 'down' before 'up'.")
        }
    }

    func pointerDown(owner: Owner, route: WindowRoute, button: CGMouseButton, system: Bool,
                     down: CGEvent, up: CGEvent, post: @escaping (CGEvent) -> Void,
                     prepareRelease: ((CGEvent) throws -> Void)? = nil) throws {
        try lock.withLock {
            try checkPointerAvailable(route: route, button: button, system: system)
            pressed.append(Press(owner: owner, recipient: route.owner,
                mode: system ? .systemPointer(button, route.windowID) : .windowPointer(button, route.windowID), up: up, post: post, prepareRelease: prepareRelease))
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
                throw RequestParameters.invalid("Release the mouse button through the same connection, application and window that pressed it")
            }
            return try release(at: index)
        }
    }

    /// Create and post movement under the same lock as ownership and the saved release point.
    func moveSystem(owner: Owner, route: WindowRoute, screen: CGPoint, checkCancellation: () throws -> Void) throws {
        try lock.withLock {
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

    private func record(_ press: Press) -> JSONValue {
        var record: [String: JSONValue] = ["appHandle": .string(press.owner.app)]
        switch press.mode {
        case .keyboard(_, _, let name, let system):
            record["kind"] = .string("key")
            record["key"] = .string(name)
            record["mode"] = .string(system ? "system" : "application")
        case .windowPointer(let button, let window), .systemPointer(let button, let window):
            record["kind"] = .string("mouse")
            record["button"] = .string(button == .left ? "left" : button == .right ? "right" : "middle")
            record["windowId"] = .string(String(window))
            if case .systemPointer = press.mode { record["mode"] = .string("system") }
            else { record["mode"] = .string("window") }
        }
        return .object(record)
    }

    /// Only the caller's registered input is disclosed; physical user input is never inferred.
    func held(connection: UUID) throws -> JSONValue {
        try lock.withLock {
            for index in pressed.indices.reversed() {
                let press = pressed[index]
                guard press.owner.connection == connection else { continue }
                if press.mode.isSystem { continue }
                do { try NativePlatform.verify(press.recipient) }
                catch let error as NativeFailure where error.code == "STALE_APP" || error.code == "APP_UNAVAILABLE" {
                    pressed.remove(at: index)
                }
            }
            return .array(pressed.filter { $0.owner.connection == connection }.map { press in
                record(press)
            })
        }
    }

    @discardableResult
    func release(connection: UUID) throws -> [JSONValue] {
        try lock.withLock {
            var failures: [String] = []
            var released: [JSONValue] = []
            for index in pressed.indices.reversed() {
                let press = pressed[index]
                guard press.owner.connection == connection else { continue }
                do { if try release(at: index) { released.append(record(press)) } }
                catch { failures.append(String(describing: error)) }
            }
            if !failures.isEmpty { throw NativeFailure(code: "INPUT_CLEANUP_FAILED", message: failures.joined(separator: "; ")) }
            return released
        }
    }

    private static var pointerBusy: NativeFailure {
        NativeFailure(code: "INPUT_BUSY", message: "A mouse button is held; release it before dispatching a conflicting gesture")
    }
}

private extension HeldInputs.Mode {
    var isSystem: Bool {
        switch self {
        case .keyboard(_, _, _, let system): return system
        case .systemPointer: return true
        case .windowPointer: return false
        }
    }
    var keyCode: CGKeyCode? { if case .keyboard(let code, _, _, _) = self { return code }; return nil }
    var pointer: CGMouseButton? {
        switch self { case .keyboard: return nil; case .windowPointer(let button, _), .systemPointer(let button, _): return button }
    }
    var window: UInt32? {
        switch self { case .keyboard: return nil; case .windowPointer(_, let window), .systemPointer(_, let window): return window }
    }
}
