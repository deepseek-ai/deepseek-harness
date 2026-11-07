// Observe the actual CoreGraphics events without sending keyboard input to the desktop.
import CoreGraphics
import Testing
@testable import CuaNative

@Test func chordKeepsModifiersThroughBothLetterReleases() throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == 42)
        events.append(event)
    }, textEventInterval: 0)
    try input.pressKey(["w", "d"], modifiers: ["shift"], to: 42)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 13, 2, 2, 13, 56])
    #expect(events.map(\.type) == [.flagsChanged, .keyDown, .keyDown, .keyUp, .keyUp, .flagsChanged])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, true, true, true, true, false])
}

@Test(arguments: [1, 2])
func cancelledChordReleasesOnlyPressedKeys(_ cancelAfter: Int) {
    let cancellation = CancellationLatch()
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in
        events.append(event)
        if events.count == cancelAfter { cancellation.cancel() }
    }, textEventInterval: 0, checkCancellation: cancellation.check)
    #expect(throws: NativeFailure.self) { try input.pressKey(["w", "d"], modifiers: [], to: 42) }
    let held = [Int64(13), 2].prefix(cancelAfter)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == Array(held) + held.reversed())
    #expect(events.map(\.type) == Array(repeating: .keyDown, count: cancelAfter) + Array(repeating: .keyUp, count: cancelAfter))
}

@Test(arguments: [["w", "unknown"], ["w", "W"], ["Enter", "Return"]])
func invalidChordPostsNoInput(_ keys: [String]) {
    let input = KeyboardInput(post: { _, _ in Issue.record("Invalid chord posted input") }, textEventInterval: 0)
    #expect(throws: NativeFailure.self) { try input.pressKey(keys, modifiers: ["shift"], to: 42) }
}
