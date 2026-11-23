// Record synthesized events and desktop state queries without posting input to the user's desktop.
import CoreGraphics
import Darwin
import Foundation
import Testing
@testable import CuaNative

@Test func systemModifiersPressKeysAndReleaseInReverseOrder() throws {
    var events: [CGEvent] = []
    let input = SystemKeyboardInput(post: { events.append($0) }, keyState: { _ in false }, currentFlags: { [] })
    let release = try input.pressModifiers(["command", "shift", "cmd"], check: {})
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 56])
    release()
    release()
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 56, 56, 55])
    #expect(events.map(\.type) == [.flagsChanged, .flagsChanged, .flagsChanged, .flagsChanged])
    #expect(events.map { $0.flags.contains(.maskCommand) } == [true, true, true, false])
    #expect(events.map { $0.flags.contains(.maskShift) } == [false, true, false, false])
}

@Test func cancelledSystemModifierPressReleasesOnlyItsKeys() throws {
    var events: [CGEvent] = []
    let input = SystemKeyboardInput(post: { events.append($0) }, keyState: { _ in false }, currentFlags: { [] })
    do {
        _ = try input.pressModifiers(["command", "shift"], check: {
            if !events.isEmpty { throw CancellationError() }
        })
        Issue.record("Cancelled modifier press completed")
    } catch { #expect(error is CancellationError) }
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 55])
    #expect(events.last?.flags.contains(.maskCommand) == false)
}

@Test func systemModifiersRejectHeldOrInvalidKeysBeforePosting() throws {
    let input = SystemKeyboardInput(post: { _ in Issue.record("Rejected modifier posted input") },
                                    keyState: { $0 == 56 }, currentFlags: { [] })
    #expect(throws: NativeFailure.self) { try input.pressModifiers(["command", "shift"], check: {}) }
    #expect(throws: NativeFailure.self) { try input.pressModifiers(["command", "unknown"], check: {}) }
}

@Test func systemShortcutUsesSystemEventsAndPreservesProcessDefault() throws {
    var systemEvents: [CGEvent] = []
    var processEvents: [CGEvent] = []
    let system = SystemKeyboardInput(post: { systemEvents.append($0) }, keyState: { _ in false }, currentFlags: { [] }, foreground: { 42 })
    let keyboard = KeyboardInput(post: { event, pid in #expect(pid == 42); processEvents.append(event) }, textEventInterval: 0, system: system)
    try keyboard.pressKey("s", modifiers: ["command", "shift"], to: 42, useSystemInput: true)
    #expect(processEvents.isEmpty)
    #expect(systemEvents.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 56, 1, 1, 56, 55])
    try keyboard.pressKey("s", modifiers: ["command"], to: 42)
    #expect(processEvents.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 1, 1, 55])
    #expect(systemEvents.count == 6)
    #expect(systemEvents.allSatisfy { CGEventSource(event: $0)?.sourceStateID == .combinedSessionState })
    #expect(processEvents.allSatisfy { CGEventSource(event: $0)?.sourceStateID == .hidSystemState })
}

@Test func systemShortcutReleasesAfterForegroundChanges() throws {
    var events: [CGEvent] = []
    let system = SystemKeyboardInput(post: { events.append($0) }, keyState: { _ in false }, currentFlags: { [] },
                                     foreground: { events.isEmpty ? 42 : 99 })
    let keyboard = KeyboardInput(post: { _, _ in Issue.record("System shortcut used process delivery") }, textEventInterval: 0, system: system)
    #expect(throws: NativeFailure.self) { try keyboard.pressKey("s", modifiers: ["command"], to: 42, useSystemInput: true) }
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [55, 55])
    #expect(events.last?.flags.contains(.maskCommand) == false)
}

@Test func systemDirectionalKeysReleaseThroughTheirRecordedRoute() throws {
    let target = try NativePlatform.identity(getpid())
    var events: [CGEvent] = []
    var foreground = target.pid
    let system = SystemKeyboardInput(post: { events.append($0) }, keyState: { _ in false }, currentFlags: { [] }, foreground: { foreground })
    let held = HeldInputs()
    let connection = UUID()
    let keyboard = KeyboardInput(post: { _, _ in Issue.record("System key used process delivery") }, textEventInterval: 0, held: held, connection: connection, system: system)
    try keyboard.keyDown("shift", app: "app", useSystemInput: true, recipient: { target })
    #expect(throws: NativeFailure.self) { try keyboard.keyUp("shift", app: "app", recipientIfUnheld: { target }) }
    foreground = 99
    #expect(try keyboard.keyUp("shift", app: "app", useSystemInput: true, recipientIfUnheld: { target }))
    foreground = target.pid
    try keyboard.keyDown("w", app: "app", useSystemInput: true, recipient: { target })
    foreground = 99
    try held.release(connection: connection)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [56, 56, 13, 13])
}

@Test func systemClickEventsPreserveDoubleClickCount() throws {
    let event = try SystemPointerInput.event(.leftMouseDown, source: nil, at: CGPoint(x: 3, y: 4), button: .left,
                                            group: 7, flags: .maskShift, clickState: 2)
    #expect(event.getIntegerValueField(.mouseEventClickState) == 2)
    #expect(event.flags.contains(.maskShift))
}

@Test func systemDirectionalEventsPreserveExternalModifiers() throws {
    let target = try NativePlatform.identity(getpid())
    var ambient: CGEventFlags = .maskAlternate
    let connection = UUID()
    let held = HeldInputs(systemFlags: { ambient })
    var events: [CGEvent] = []
    let system = SystemKeyboardInput(post: { events.append($0) }, keyState: { _ in false }, currentFlags: { ambient }, foreground: { target.pid })
    let keyboard = KeyboardInput(post: { _, _ in Issue.record("System key used process delivery") }, textEventInterval: 0, held: held, connection: connection, system: system)
    try keyboard.keyDown("w", app: "app", useSystemInput: true, recipient: { target })
    try keyboard.keyDown("w", app: "app", useSystemInput: true, recipient: { target })
    #expect(try keyboard.keyUp("w", app: "app", useSystemInput: true, recipientIfUnheld: { target }))
    #expect(events.allSatisfy { $0.flags.contains(.maskAlternate) })
    try keyboard.keyDown("command", app: "app", useSystemInput: true, recipient: { target })
    ambient.formUnion(.maskCommand)
    try held.release(connection: connection)
    #expect(events.last?.flags == .maskAlternate)
}
