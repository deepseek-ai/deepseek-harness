// Observe the actual CoreGraphics events without sending keyboard input to the desktop.
import CoreGraphics
import Darwin
import Testing
@testable import CuaNative

@Test(arguments: [
    (["w", "d"], ["shift"], [56, 13, 2, 2, 13, 56]),
    (["shift", "w", "d"], [], [56, 13, 2, 2, 13, 56]),
    (["a", "="], ["shift"], [56, 0, 24, 24, 0, 56]),
])
func chordKeepsShiftThroughBothKeyReleases(_ keys: [String], _ modifiers: [String], _ codes: [Int64]) throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == 42)
        events.append(event)
    }, textEventInterval: 0)
    try input.pressKey(keys, modifiers: modifiers, to: 42)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == codes)
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

@Test(arguments: [
    (["w", "unknown"], "Unknown key name: unknown"),
    (["w", "W"], "Keys 'w' and 'W' name the same physical key"),
    (["Enter", "Return"], "Keys 'Enter' and 'Return' name the same physical key"),
    (["a", "+"], "For a multi-key chord, use = with an explicit shift modifier instead of +"),
    (["Plus", "w"], "For a multi-key chord, use = with an explicit shift modifier instead of Plus"),
])
func invalidChordPostsNoInput(_ keys: [String], _ message: String) throws {
    let input = KeyboardInput(post: { _, _ in Issue.record("Invalid chord posted input") }, textEventInterval: 0)
    do {
        try input.pressKey(keys, modifiers: ["shift"], to: 42)
        Issue.record("Invalid chord was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "INVALID_ARGUMENT")
        #expect(error.message == message)
    }
}

@Test(arguments: ["+", "plus"])
func plusAlonePressesShiftEquals(_ alias: String) throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0)
    try input.pressKey([alias], modifiers: [], to: 42)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 24, 24, 56])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, true, true, false])
}

@Test func standaloneShiftSetsItsFlagOnlyWhileHeld() throws {
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0)
    try input.pressKey(["shift"], modifiers: [], to: 42)
    #expect(events.map(\.type) == [.flagsChanged, .flagsChanged])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, false])
}

@Test func directionalReleaseUsesOriginalRecipientAndPreservesOtherRuns() throws {
    let target = try NativePlatform.identity(getpid())
    let held = HeldKeys()
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == target.pid)
        events.append(event)
    }, textEventInterval: 0, held: held)
    try input.keyDown("shift", app: "editor", run: "one", recipient: target)
    try input.keyDown("w", app: "editor", run: "two", recipient: target)
    #expect(throws: NativeFailure.self) { try input.keyDown("W", app: "editor", run: "one", recipient: target) }
    #expect(throws: NativeFailure.self) { try input.keyUp("w", app: "other", run: "two") }
    #expect(throws: NativeFailure.self) { try input.pressKey(["w"], modifiers: [], to: target.pid) }
    try input.pressKey(["d"], modifiers: ["shift"], to: target.pid)
    try input.releaseHeldKeys(run: "one")
    #expect(try input.keyUp("w", app: "editor", run: "two"))
    try input.releaseHeldKeys(run: "two")
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 13, 2, 2, 56, 13])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, true, true, true, false, false])
}
