// System pointer validation; HeldInputs owns every persistent button press.
import CoreGraphics
import Dispatch
import Foundation

@MainActor final class SystemPointerInput {
    private let held: HeldInputs

    init(held: HeldInputs) { self.held = held }

    nonisolated static func event(_ type: CGEventType, source: CGEventSource?, at screen: CGPoint, button: CGMouseButton,
                                  group: Int64, flags: CGEventFlags? = nil, clickState: Int64 = 1) throws -> CGEvent {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: screen, mouseButton: button) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create system mouse event")
        }
        event.flags = flags ?? CGEventSource.flagsState(.combinedSessionState)
        event.setIntegerValueField(.mouseEventNumber, value: group)
        event.setIntegerValueField(.mouseEventClickState, value: type == .mouseMoved ? 0 : clickState)
        return event
    }

    nonisolated static func post(_ event: CGEvent) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        event.post(tap: .cghidEventTap)
    }

    func down(owner: HeldInputs.Owner, in route: WindowRoute, button: CGMouseButton, checkCancellation: () throws -> Void) throws {
        try WindowPointerInput.validateWindow(route)
        guard let point = CGEvent(source: nil)?.location else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not read the current pointer position")
        }
        try WindowPointerInput.checkSystemHit(route, at: point)
        try WindowPointerInput.requireReleasedButtons(except: held.systemButtonsHeld(by: owner, in: route))
        let group = Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
        let down = try Self.event(WindowPointerInput.down(button), source: nil, at: point, button: button, group: group)
        let up = try Self.event(WindowPointerInput.up(button), source: nil, at: point, button: button, group: group)
        try checkCancellation()
        try held.pointerDown(owner: owner, route: route, button: button, system: true, down: down, up: up, post: Self.post)
    }

    func move(owner: HeldInputs.Owner, in route: WindowRoute, at point: WindowPoint, checkCancellation: () throws -> Void) throws {
        try WindowPointerInput.validate(point, in: route)
        try WindowPointerInput.validateWindow(route)
        let screen = WindowPointerInput.screenPoint(point, in: route)
        try WindowPointerInput.checkSystemHit(route, at: screen)
        try held.moveSystem(owner: owner, route: route, screen: screen, checkCancellation: checkCancellation)
        try checkCancellation()
    }
}
