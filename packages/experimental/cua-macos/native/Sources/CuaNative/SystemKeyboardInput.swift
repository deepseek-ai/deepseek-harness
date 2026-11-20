// System keyboard delivery and balanced modifiers shared by keyboard and pointer operations.
import CoreGraphics
import Foundation

final class SystemKeyboardInput {
    let post: (CGEvent) -> Void
    private let foreground: () -> Int32?
    private let keyState: (CGKeyCode) -> Bool
    let currentFlags: () -> CGEventFlags

    init(post: @escaping (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) },
         keyState: @escaping (CGKeyCode) -> Bool = { CGEventSource.keyState(.combinedSessionState, key: $0) },
         currentFlags: @escaping () -> CGEventFlags = { CGEventSource.flagsState(.combinedSessionState) },
         foreground: @escaping () -> Int32? = NativePlatform.frontPID) {
        self.post = post
        self.keyState = keyState
        self.currentFlags = currentFlags
        self.foreground = foreground
    }

    func validateTarget(_ pid: Int32) throws {
        guard foreground() == pid else {
            throw NativeFailure(code: "FOREGROUND_REQUIRED", message: "System keyboard input requires the selected application in the foreground; activate it and observe again")
        }
    }

    func requireReleased(_ codes: [CGKeyCode]) throws {
        guard !codes.contains(where: keyState) else {
            throw NativeFailure(code: "INPUT_BUSY", message: "A requested system key is already held; release it before sending another press")
        }
    }

    /// Prepare all events before pressing; the returned release only covers keys pressed by this call.
    func pressModifiers(_ names: [String], check: () throws -> Void) throws -> () -> Void {
        let source = try KeyboardInput.source(system: true)
        var seen = Set<CGKeyCode>()
        var flags = currentFlags()
        var pairs: [(down: CGEvent, up: CGEvent)] = []
        var codes: [CGKeyCode] = []
        for name in names {
            let flag = try KeyboardInput.modifierFlags([name])
            let code = try KeyboardInput.keyCode(name)
            guard seen.insert(code).inserted else { continue }
            let previous = flags
            flags.formUnion(flag)
            pairs.append((try KeyboardInput.keyEvent(source: source, code: code, down: true, flags: flags),
                          try KeyboardInput.keyEvent(source: source, code: code, down: false, flags: previous)))
            codes.append(code)
        }
        try requireReleased(codes)
        var pressed = 0
        let release = { [post] in
            while pressed > 0 {
                pressed -= 1
                post(pairs[pressed].up)
            }
        }
        do {
            for pair in pairs {
                try check()
                post(pair.down)
                pressed += 1
                Thread.sleep(forTimeInterval: 0.008)
            }
        } catch {
            release()
            throw error
        }
        return release
    }
}
