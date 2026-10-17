// Independent automation source for the shared-helper activity test; only targets its owned fixture.
import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]),
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { exit(1) }
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(2) }
down.post(tap: .cgSessionEventTap)
up.post(tap: .cgSessionEventTap)
