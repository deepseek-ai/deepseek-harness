// Observe the actual CoreGraphics events without sending keyboard input to the desktop.
import CoreGraphics
import Darwin
import Testing
@testable import CuaNative

@Test func shortcutHoldsCommandAndShiftAroundOneKey() throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == 42)
        events.append(event)
    }, textEventInterval: 0)
    try input.pressKey("s", modifiers: ["cmd", "shift"], to: 42)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 56, 1, 1, 56, 55])
    #expect(events.map(\.type) == [.flagsChanged, .flagsChanged, .keyDown, .keyUp, .flagsChanged, .flagsChanged])
    #expect(events.map { $0.flags.contains(.maskShift) } == [false, true, true, true, false, false])
    #expect(events.map { $0.flags.contains(.maskCommand) } == [true, true, true, true, true, false])
}

@Test(arguments: [1, 2])
func cancelledShortcutReleasesOnlyPressedKeys(_ cancelAfter: Int) {
    let cancellation = CancellationLatch()
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in
        events.append(event)
        if events.count == cancelAfter { cancellation.cancel() }
    }, textEventInterval: 0, checkCancellation: cancellation.check)
    #expect(throws: NativeFailure.self) { try input.pressKey("d", modifiers: ["shift"], to: 42) }
    let held = [Int64(56), 2].prefix(cancelAfter)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == Array(held) + held.reversed())
    let types: [CGEventType] = cancelAfter == 1 ? [.flagsChanged, .flagsChanged] : [.flagsChanged, .keyDown, .keyUp, .flagsChanged]
    #expect(events.map(\.type) == types)
}

@Test(arguments: [
    ("unknown", ["shift"], "Unknown key name: unknown"),
    ("w", ["d"], "Unsupported key modifier: d"),
])
func invalidShortcutPostsNoInput(_ key: String, _ modifiers: [String], _ message: String) throws {
    let input = KeyboardInput(post: { _, _ in Issue.record("Invalid shortcut posted input") }, textEventInterval: 0)
    do {
        try input.pressKey(key, modifiers: modifiers, to: 42)
        Issue.record("Invalid shortcut was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "INVALID_ARGUMENT")
        #expect(error.message == message)
    }
}

@Test(arguments: ["+", "plus"])
func plusAlonePressesShiftEquals(_ alias: String) throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0)
    try input.pressKey(alias, modifiers: [], to: 42)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 24, 24, 56])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, true, true, false])
}

@Test func standaloneShiftSetsItsFlagOnlyWhileHeld() throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0)
    try input.pressKey("shift", modifiers: [], to: 42)
    #expect(events.map(\.type) == [.flagsChanged, .flagsChanged])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, false])
}
