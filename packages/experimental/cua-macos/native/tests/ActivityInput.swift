// Independent automation source for the shared-helper activity test; only targets its owned fixture.
import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--can-post" {
    print(CGPreflightPostEventAccess() ? "yes" : "no")
    exit(0)
}
if arguments.count == 3 && arguments[1] == "--has-listener", let pid = Int32(arguments[2]) {
    var count: UInt32 = 0
    guard CGGetEventTapList(0, nil, &count) == .success else { exit(4) }
    var taps = Array(repeating: CGEventTapInformation(), count: Int(count) + 1)
    guard CGGetEventTapList(UInt32(taps.count), &taps, &count) == .success else { exit(4) }
    print(taps.prefix(Int(count)).contains {
        $0.tappingProcess == pid && $0.tapPoint == .cgAnnotatedSessionEventTap && $0.options == .listenOnly
    } ? "yes" : "no")
    exit(0)
}
guard arguments.count == 5, let pid = Int32(arguments[1]) else { exit(1) }
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(2) }
guard let x = Double(arguments[2]), let y = Double(arguments[3]),
      let press = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                          mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left),
      let release = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(1) }
guard let expectedWindow = Int(arguments[4]),
      NSWindow.windowNumber(at: NSPoint(x: x, y: CGDisplayBounds(CGMainDisplayID()).height - y),
                            belowWindowWithWindowNumber: 0) == expectedWindow else { exit(3) }
press.post(tap: .cgSessionEventTap)
release.post(tap: .cgSessionEventTap)
print("POSTED")
fflush(stdout)
_ = readLine()
