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

@Test func directionalReleaseUsesOriginalRecipientAndPreservesOtherRuns() throws {
    let target = try NativePlatform.identity(getpid())
    let held = HeldKeys()
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == target.pid)
        events.append(event)
    }, textEventInterval: 0, held: held)
    try input.keyDown("shift", app: "editor", run: "one", recipient: { target })
    #expect(throws: NativeFailure.self) { try input.keyDown("shift", app: "editor", run: "one", recipient: { target }) }
    try input.keyDown("w", app: "editor", run: "two", recipient: { target })
    #expect(throws: NativeFailure.self) { try input.keyDown("W", app: "editor", run: "one", recipient: { target }) }
    #expect(throws: NativeFailure.self) { try input.keyUp("w", app: "other", run: "two", recipientIfUnheld: { target }) }
    #expect(throws: NativeFailure.self) { try input.pressKey("w", modifiers: [], to: target.pid) }
    try input.pressKey("d", modifiers: ["shift"], to: target.pid)
    try input.releaseHeldKeys(run: "one")
    #expect(try input.keyUp("w", app: "editor", run: "two", recipientIfUnheld: { target }))
    try input.releaseHeldKeys(run: "two")
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 13, 2, 2, 56, 13])
    #expect(events.map { $0.flags.contains(.maskShift) } == [true, true, true, true, false, false])
}

@Test(arguments: [true, false])
func repeatedDownUsesOriginalRecipientAndOneRelease(_ explicitUp: Bool) throws {
    let target = try NativePlatform.identity(getpid())
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == target.pid)
        events.append(event)
    }, textEventInterval: 0)
    func changedFocus() throws -> ProcessIdentity {
        throw RequestParameters.invalid("The repeat or release looked up a new recipient")
    }
    try input.keyDown("w", app: "editor", run: "one", recipient: { target })
    try input.keyDown("W", app: "editor", run: "one", recipient: changedFocus)
    if explicitUp { #expect(try input.keyUp("w", app: "editor", run: "one", recipientIfUnheld: changedFocus)) }
    try input.releaseHeldKeys(run: "one")
    #expect(events.map(\.type) == [.keyDown, .keyDown, .keyUp])
    #expect(events.map { $0.getIntegerValueField(.keyboardEventAutorepeat) } == [0, 1, 0])
}

@Test func foreignSessionCannotRepeatOrReleaseTheOwnersKey() throws {
    let target = try NativePlatform.identity(getpid())
    let held = HeldKeys()
    var events: [CGEvent] = []
    let a = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0, held: held)
    let b = KeyboardInput(post: { _, _ in Issue.record("Non-owner dispatched an event") }, textEventInterval: 0, held: held)
    try a.keyDown("w", app: "a", run: "same-run-id", recipient: { target })
    for direction in ["down", "up"] {
        do {
            if direction == "down" { try b.keyDown("W", app: "b", run: "same-run-id", recipient: { target }) }
            else { _ = try b.keyUp("W", app: "b", run: "same-run-id", recipientIfUnheld: { target }) }
            Issue.record("Non-owner was allowed to send an event")
        } catch let failure as NativeFailure {
            #expect(failure.code == "INVALID_ARGUMENT")
            #expect(failure.message.contains("Key 'W' is held for this target by another session"))
            #expect(failure.message.contains("Wait for the holder to release it"))
        }
    }
    try b.releaseHeldKeys()
    try a.keyDown("W", app: "a", run: "same-run-id", recipient: { target })
    try a.releaseHeldKeys()
    #expect(events.map(\.type) == [.keyDown, .keyDown, .keyUp])
    do {
        _ = try b.keyUp("W", app: "b", run: "same-run-id", recipientIfUnheld: { target })
        Issue.record("Unheld key was released")
    } catch let failure as NativeFailure {
        #expect(failure.code == "INVALID_ARGUMENT")
        #expect(failure.message.contains("Key 'W' is not held for this target"))
    }
}
