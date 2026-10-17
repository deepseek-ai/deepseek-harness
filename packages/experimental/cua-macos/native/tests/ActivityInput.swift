// Independent automation source for the shared-helper activity test; only targets its owned fixture.
import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard [2, 4].contains(arguments.count), let pid = Int32(arguments[1]) else { exit(1) }
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(2) }
let down: CGEvent
let up: CGEvent
if arguments.count == 4 {
    guard let x = Double(arguments[2]), let y = Double(arguments[3]),
          let press = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                              mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left),
          let release = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                                mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(1) }
    down = press; up = release
} else {
    guard let press = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let release = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { exit(1) }
    down = press; up = release
}
down.post(tap: .cgSessionEventTap)
up.post(tap: .cgSessionEventTap)
print("POSTED")
fflush(stdout)
_ = readLine()
