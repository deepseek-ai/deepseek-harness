// Independent automation source for the shared-helper activity test; only targets its owned fixture.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]),
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { exit(1) }
down.postToPid(pid)
up.postToPid(pid)
