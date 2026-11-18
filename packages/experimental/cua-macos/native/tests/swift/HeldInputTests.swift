// Observe native CGEvents at dispatch without injecting input into the developer's desktop.
import CoreGraphics
import Darwin
import Foundation
import Testing
@testable import CuaNative

private let scope = HeldInputs.Scope(task: "task", turn: 1)

private func pointer(_ type: CGEventType) throws -> CGEvent {
    let event = try #require(CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: .zero, mouseButton: .left))
    event.flags = .maskAlternate
    return event
}

@Test(arguments: [false, true])
func mixedInputsReleaseInDispatchOrder(_ system: Bool) throws {
    let held = HeldInputs()
    let connection = UUID()
    let target = try NativePlatform.identity(getpid())
    let owner = HeldInputs.Owner(connection: connection, scope: scope, app: "editor")
    let route = WindowRoute(owner: target, windowID: 7, bounds: .init(x: 0, y: 0, width: 100, height: 100))
    var events: [String] = []
    let input = KeyboardInput(post: { event, pid in
        #expect(pid == target.pid)
        events.append("key:\(event.getIntegerValueField(.keyboardEventKeycode)):\(event.type.rawValue)")
    }, textEventInterval: 0, held: held, connection: connection)
    try input.keyDown("shift", app: "editor", scope: scope, recipient: { target })
    try held.pointerDown(owner: owner, route: route, button: .left, system: system,
                         down: pointer(.leftMouseDown), up: pointer(.leftMouseUp), post: { events.append("mouse:\($0.type.rawValue)") })
    try input.keyDown("w", app: "editor", scope: scope, recipient: { target })
    try held.release(connection: connection, scope: scope)
    try held.release(connection: connection, scope: scope)
    #expect(events == ["key:56:12", "mouse:1", "key:13:10", "key:13:11", "mouse:2", "key:56:12"])
}

@Test func explicitReleaseRepeatAndRepressKeepOnlyTheLatestPress() throws {
    let held = HeldInputs()
    let connection = UUID()
    let target = try NativePlatform.identity(getpid())
    var events: [CGEvent] = []
    let input = KeyboardInput(post: { event, _ in events.append(event) }, textEventInterval: 0, held: held, connection: connection)
    func changedFocus() throws -> ProcessIdentity { throw RequestParameters.invalid("Unexpected focus lookup") }
    try input.keyDown("w", app: "editor", scope: scope, recipient: { target })
    try input.keyDown("w", app: "editor", scope: scope, recipient: changedFocus)
    #expect(try input.keyUp("w", app: "editor", scope: scope, recipientIfUnheld: changedFocus))
    try input.keyDown("d", app: "editor", scope: scope, recipient: { target })
    try input.keyDown("w", app: "editor", scope: scope, recipient: { target })
    try held.release(connection: connection, scope: scope)
    #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [13, 13, 13, 2, 13, 13, 2])
    #expect(events.map(\.type) == [.keyDown, .keyDown, .keyUp, .keyDown, .keyDown, .keyUp, .keyUp])
    #expect(events.map { $0.getIntegerValueField(.keyboardEventAutorepeat) } == [0, 1, 0, 0, 0, 0, 0])
}

@Test func connectionsAndTurnsCannotReleaseEachOthersInput() throws {
    let held = HeldInputs()
    let a = UUID(), b = UUID()
    let target = try NativePlatform.identity(getpid())
    var events: [CGEventType] = []
    let input = KeyboardInput(post: { event, _ in events.append(event.type) }, textEventInterval: 0, held: held, connection: a)
    let peer = KeyboardInput(post: { _, _ in Issue.record("Foreign connection posted input") }, textEventInterval: 0, held: held, connection: b)
    try input.keyDown("w", app: "editor", scope: scope, recipient: { target })
    #expect(throws: NativeFailure.self) { try peer.keyDown("w", app: "editor", scope: scope, recipient: { target }) }
    #expect(throws: NativeFailure.self) { try peer.keyUp("w", app: "editor", scope: scope, recipientIfUnheld: { target }) }
    try held.release(connection: b)
    #expect(events == [.keyDown])
    try held.release(connection: a, scope: scope)
    #expect(throws: NativeFailure.self) { try input.keyDown("w", app: "editor", scope: scope, recipient: { target }) }
    let next = HeldInputs.Scope(task: scope.task, turn: 2)
    try input.keyDown("w", app: "editor", scope: next, recipient: { target })
    try held.release(connection: a, scope: scope)
    #expect(events == [.keyDown, .keyUp, .keyDown])
    try held.release(connection: a)
    #expect(events == [.keyDown, .keyUp, .keyDown, .keyUp])
}

@Test(arguments: [false, true])
func pointerReleaseUsesSavedRouteAfterWindowAndProcessChanges(_ system: Bool) throws {
    let held = HeldInputs()
    let target = try NativePlatform.identity(getpid())
    // The current PID with a different start identity models a reused process identifier.
    let stale = ProcessIdentity(pid: target.pid, startedSeconds: target.startedSeconds + 1, startedMicroseconds: target.startedMicroseconds)
    let owner = HeldInputs.Owner(connection: UUID(), scope: scope, app: "old-window")
    let route = WindowRoute(owner: stale, windowID: 987654, bounds: .init(x: 0, y: 0, width: 100, height: 100))
    var events: [CGEventType] = []
    try held.pointerDown(owner: owner, route: route, button: .left, system: system,
                         down: pointer(.leftMouseDown), up: pointer(.leftMouseUp), post: { events.append($0.type) })
    #expect(try held.pointerUp(owner: owner, window: route.windowID, button: .left) == system)
    try held.release(connection: owner.connection)
    #expect(events == (system ? [.leftMouseDown, .leftMouseUp] : [.leftMouseDown]))
}

@Test func balancedGestureCannotReleaseAWindowHold() throws {
    let held = HeldInputs()
    let target = try NativePlatform.identity(getpid())
    let route = WindowRoute(owner: target, windowID: 7, bounds: .init(x: 0, y: 0, width: 100, height: 100))
    let owner = HeldInputs.Owner(connection: UUID(), scope: scope, app: "editor")
    try held.pointerDown(owner: owner, route: route, button: .left, system: false,
                         down: pointer(.leftMouseDown), up: pointer(.leftMouseUp), post: { _ in })
    #expect(throws: NativeFailure.self) { try held.requirePointerAvailable(route: route, button: .left, system: false) }
    #expect(throws: NativeFailure.self) { try held.requirePointerAvailable(route: route, button: .right, system: true) }
    try held.requirePointerAvailable(route: route, button: .right, system: false)
    try held.release(connection: owner.connection)
    try held.requirePointerAvailable(route: route, button: .left, system: false)
}
