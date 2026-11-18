// Independent automation source for the shared-helper activity test; only targets its owned fixture.
import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--can-post" {
    print(CGPreflightPostEventAccess() ? "yes" : "no")
    exit(0)
}
guard [2, 5].contains(arguments.count), let pid = Int32(arguments[1]) else { exit(1) }
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(2) }
let down: CGEvent
let up: CGEvent
if arguments.count == 5 {
    guard let x = Double(arguments[2]), let y = Double(arguments[3]),
          let press = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                              mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left),
          let release = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                                mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(1) }
    guard let expectedWindow = Int(arguments[4]),
          NSWindow.windowNumber(at: NSPoint(x: x, y: CGDisplayBounds(CGMainDisplayID()).height - y),
                                belowWindowWithWindowNumber: 0) == expectedWindow else { exit(3) }
    down = press; up = release
} else {
    // Escape exercises delivery without starting input-method composition.
    guard let press = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true),
          let release = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false) else { exit(1) }
    down = press; up = release
}
down.post(tap: .cgSessionEventTap)
up.post(tap: .cgSessionEventTap)
print("POSTED")
fflush(stdout)
_ = readLine()
