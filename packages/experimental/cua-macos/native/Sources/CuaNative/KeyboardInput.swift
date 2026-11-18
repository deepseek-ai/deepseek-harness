// Keyboard semantics follow DSH's MIT-licensed Cua Driver adaptation.
import CoreGraphics
import Foundation

/// Balanced PID-targeted chords and scalar-based Unicode input on one serial worker.
final class KeyboardInput {
    private struct Key {
        let keyCode: CGKeyCode
        let flag: CGEventFlags
    }

    private let connection = UUID()
    private let held: HeldKeys
    private let post: (CGEvent, Int32) -> Void
    private let textEventInterval: Double
    private let checkCancellation: @Sendable () throws -> Void

    init(post: @escaping (CGEvent, Int32) -> Void, textEventInterval: Double, held: HeldKeys = HeldKeys(), checkCancellation: @escaping @Sendable () throws -> Void = {}) {
        self.held = held
        self.post = post
        self.textEventInterval = textEventInterval
        self.checkCancellation = checkCancellation
    }

    func keyDown(_ name: String, app: String, run: String, recipient: () throws -> ProcessIdentity) throws {
        let owner = HeldKeys.Owner(connection: connection, run: run, app: app)
        let code = try Self.keyCode(name)
        let source = try Self.source()
        let down = try Self.keyEvent(source: source, code: code, down: true, flags: [])
        try checkCancellation()
        if try held.repeatIfHeld(owner: owner, name: name, code: code, down: down, post: post) { return }
        let target = try recipient()
        let up = try Self.keyEvent(source: source, code: code, down: false, flags: [])
        try checkCancellation()
        try NativePlatform.verify(target)
        try held.down(owner: owner, recipient: target, name: name, code: code, flag: Self.namedModifier(name)?.flag ?? [],
                      down: down, up: up, post: post)
    }

    func keyUp(_ name: String, app: String, run: String, recipientIfUnheld: () throws -> ProcessIdentity) throws -> Bool {
        try held.up(owner: .init(connection: connection, run: run, app: app), name: name, code: Self.keyCode(name),
                    recipientIfUnheld: recipientIfUnheld, post: post)
    }

    func releaseHeldKeys(run: String? = nil) throws {
        try held.release(connection: connection, run: run, post: post)
    }

    /// Prepare every event before dispatch. On cancellation, release only the keys this call pressed.
    func pressKey(_ name: String, modifiers: [String], to pid: Int32) throws {
        try checkCancellation()
        var chord = try modifiers.map(Self.modifier)
        let isPlus = name == "+" || name.lowercased() == "plus"
        if isPlus { chord.append(try Self.modifier("shift")) }
        let code = try Self.keyCode(isPlus ? "=" : name)
        chord.append(Key(keyCode: code, flag: Self.namedModifier(name)?.flag ?? []))
        let alreadyHeld = held.snapshot(pid: pid)
        guard alreadyHeld[code] == nil else {
            throw RequestParameters.invalid("Key '\(name)' is already held for this target. Use pressKey after the run_code that holds it releases it.")
        }
        var selected = Set(alreadyHeld.keys)
        var flags = alreadyHeld.values.reduce(CGEventFlags()) { $0.union($1) }
        var events: [(down: CGEvent, up: CGEvent)] = []
        let source = try Self.source()
        for key in chord {
            guard selected.insert(key.keyCode).inserted else { continue }
            let releasedFlags = flags
            flags.formUnion(key.flag)
            events.append((
                down: try Self.keyEvent(source: source, code: key.keyCode, down: true, flags: flags),
                up: try Self.keyEvent(source: source, code: key.keyCode, down: false, flags: releasedFlags)
            ))
        }
        var pressed = 0
        do {
            defer {
                for index in (0..<pressed).reversed() {
                    post(events[index].up, pid)
                    if index > 0 { Thread.sleep(forTimeInterval: 0.008) }
                }
            }
            for event in events {
                try checkCancellation()
                post(event.down, pid)
                pressed += 1
                Thread.sleep(forTimeInterval: 0.008)
            }
        }
        try checkCancellation()
    }

    /// Send Unicode scalars as down/up pairs; line breaks and tabs use their physical keys.
    func typeText(_ text: String, to pid: Int32) throws {
        try checkCancellation()
        let source = try Self.source()
        let alreadyHeld = held.snapshot(pid: pid)
        let flags = alreadyHeld.values.reduce(CGEventFlags()) { $0.union($1) }
        for scalar in text.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars {
            try checkCancellation()
            let code: CGKeyCode
            switch scalar.value {
            case 10, 13: code = try Self.keyCode("Return")
            case 9: code = try Self.keyCode("Tab")
            default: code = 0
            }
            guard alreadyHeld[code] == nil else {
                throw RequestParameters.invalid("Release the held physical key before typing text with its key code")
            }
            let down = try Self.keyEvent(source: source, code: code, down: true, flags: flags)
            let up = try Self.keyEvent(source: source, code: code, down: false, flags: flags)
            if code == 0 {
                let units = Array(String(scalar).utf16)
                units.withUnsafeBufferPointer { buffer in
                    // A Unicode scalar always has one or two UTF-16 code units.
                    down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                    up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                }
            }
            var keyHeld = false
            do {
                defer {
                    if keyHeld {
                        post(up, pid)
                        Thread.sleep(forTimeInterval: textEventInterval)
                    }
                }
                try checkCancellation()
                post(down, pid)
                keyHeld = true
                Thread.sleep(forTimeInterval: textEventInterval)
                try checkCancellation()
                post(up, pid)
                keyHeld = false
                Thread.sleep(forTimeInterval: textEventInterval)
            }
        }
        try checkCancellation()
    }

    private static func source() throws -> CGEventSource {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create keyboard event source")
        }
        return source
    }

    private static func keyEvent(
        source: CGEventSource, code: CGKeyCode, down: Bool, flags: CGEventFlags
    ) throws -> CGEvent {
        // CoreGraphics creates FlagsChanged for modifier virtual keys.
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create keyboard event")
        }
        event.flags = flags
        return event
    }

    private static func namedModifier(_ name: String) -> Key? {
        switch name.lowercased() {
        case "command", "cmd": return Key(keyCode: 55, flag: .maskCommand)
        case "shift": return Key(keyCode: 56, flag: .maskShift)
        case "option", "alt": return Key(keyCode: 58, flag: .maskAlternate)
        case "control", "ctrl": return Key(keyCode: 59, flag: .maskControl)
        case "fn": return Key(keyCode: 63, flag: .maskSecondaryFn)
        default: return nil
        }
    }

    private static func modifier(_ name: String) throws -> Key {
        guard let modifier = namedModifier(name) else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Unsupported key modifier: \(name)")
        }
        return modifier
    }

    static func modifierFlags(_ names: [String]) throws -> CGEventFlags {
        try names.reduce(into: CGEventFlags()) { flags, name in flags.formUnion(try modifier(name).flag) }
    }

    static func keyCode(_ key: String) throws -> CGKeyCode {
        if let modifier = namedModifier(key) { return modifier.keyCode }
        switch key.lowercased() {
        case "kp_0": return 82
        case "kp_1": return 83
        case "kp_2": return 84
        case "kp_3": return 85
        case "kp_4": return 86
        case "kp_5": return 87
        case "kp_6": return 88
        case "kp_7": return 89
        case "kp_8": return 91
        case "kp_9": return 92
        case "kp_decimal": return 65
        case "kp_separator": return 95
        case "kp_multiply": return 67
        case "kp_add": return 69
        case "kp_clear": return 71
        case "kp_divide": return 75
        case "kp_enter": return 76
        case "kp_subtract": return 78
        case "kp_equal": return 81
        case "return", "enter": return 36
        case "tab": return 48
        case "space": return 49
        case "delete", "backspace": return 51
        case "escape", "esc": return 53
        case "capslock": return 57
        case "home": return 115
        case "pageup": return 116
        case "del", "forward_delete": return 117
        case "end": return 119
        case "pagedown": return 121
        case "left", "left_arrow": return 123
        case "right", "right_arrow": return 124
        case "down", "down_arrow": return 125
        case "up", "up_arrow": return 126
        case "f1": return 122
        case "f2": return 120
        case "f3": return 99
        case "f4": return 118
        case "f5": return 96
        case "f6": return 97
        case "f7": return 98
        case "f8": return 100
        case "f9": return 101
        case "f10": return 109
        case "f11": return 103
        case "f12": return 111
        case "a": return 0
        case "s": return 1
        case "d": return 2
        case "f": return 3
        case "h": return 4
        case "g": return 5
        case "z": return 6
        case "x": return 7
        case "c": return 8
        case "v": return 9
        case "b": return 11
        case "q": return 12
        case "w": return 13
        case "e": return 14
        case "r": return 15
        case "y": return 16
        case "t": return 17
        case "1": return 18
        case "2": return 19
        case "3": return 20
        case "4": return 21
        case "6": return 22
        case "5": return 23
        case "=": return 24
        case "9": return 25
        case "7": return 26
        case "-": return 27
        case "8": return 28
        case "0": return 29
        case "]": return 30
        case "o": return 31
        case "u": return 32
        case "[": return 33
        case "i": return 34
        case "p": return 35
        case "l": return 37
        case "j": return 38
        case "'": return 39
        case "k": return 40
        case ";": return 41
        case "\\": return 42
        case ",": return 43
        case "/": return 44
        case "n": return 45
        case "m": return 46
        case ".": return 47
        case "`": return 50
        default: throw RequestParameters.invalid("Unknown key name: \(key)")
        }
    }
}
