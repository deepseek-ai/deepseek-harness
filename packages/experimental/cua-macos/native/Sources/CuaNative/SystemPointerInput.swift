// The shared desktop has one system pointer. Its held button belongs to the connection and window that pressed it.
import CoreGraphics
import Dispatch
import Foundation

@MainActor final class SystemPointerInput {
    private struct Press {
        let connection: UUID
        let app: String
        let route: WindowRoute
        let button: CGMouseButton
        let group: Int64
        let release: CGEvent
    }
    private var press: Press?

    nonisolated static func event(_ type: CGEventType, source: CGEventSource?, at screen: CGPoint, button: CGMouseButton,
                                  group: Int64, flags: CGEventFlags = []) throws -> CGEvent {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: screen, mouseButton: button) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create system mouse event")
        }
        event.flags = flags
        event.setIntegerValueField(.mouseEventNumber, value: group)
        event.setIntegerValueField(.mouseEventClickState, value: type == .mouseMoved ? 0 : 1)
        return event
    }

    nonisolated static func post(_ event: CGEvent) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        event.post(tap: .cghidEventTap)
    }

    func down(connection: UUID, app: String, in route: WindowRoute, button: CGMouseButton, checkCancellation: () throws -> Void) throws {
        guard press == nil else { throw Self.busy }
        try WindowPointerInput.validateWindow(route)
        guard let point = CGEvent(source: nil)?.location else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not read the current pointer position")
        }
        try WindowPointerInput.checkSystemHit(route, at: point)
        try WindowPointerInput.requireReleasedButtons()
        let group = Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
        let down = try Self.event(WindowPointerInput.down(button), source: nil, at: point, button: button, group: group)
        let up = try Self.event(WindowPointerInput.up(button), source: nil, at: point, button: button, group: group)
        try checkCancellation()
        press = Press(connection: connection, app: app, route: route, button: button, group: group, release: up)
        Self.post(down)
    }

    func move(connection: UUID, in route: WindowRoute, at point: WindowPoint, checkCancellation: () throws -> Void) throws {
        try WindowPointerInput.validate(point, in: route)
        try WindowPointerInput.validateWindow(route)
        let screen = WindowPointerInput.screenPoint(point, in: route)
        try WindowPointerInput.checkSystemHit(route, at: screen)
        let event: CGEvent
        if let press {
            guard press.connection == connection, press.route.owner == route.owner, press.route.windowID == route.windowID else { throw Self.busy }
            let button = press.button
            event = try Self.event(WindowPointerInput.dragged(button), source: nil, at: screen, button: button, group: press.group)
            let previous = CGEvent(source: nil)?.location ?? press.release.location
            event.setIntegerValueField(.mouseEventDeltaX, value: Int64(screen.x.rounded() - previous.x.rounded()))
            event.setIntegerValueField(.mouseEventDeltaY, value: Int64(screen.y.rounded() - previous.y.rounded()))
        } else {
            event = try Self.event(.mouseMoved, source: nil, at: screen, button: .left, group: 0)
        }
        try checkCancellation()
        Self.post(event)
        press?.release.location = screen
        try checkCancellation()
    }

    func up(connection: UUID, app: String, window: UInt32, button: CGMouseButton) throws {
        guard let press, press.connection == connection, press.app == app, press.route.windowID == window, press.button == button else {
            throw RequestParameters.invalid("Release the system button through the same window and connection that pressed it")
        }
        release(connection: connection)
    }

    /// Releasing at the current pointer also works after focus changes or the original window closes.
    func release(connection: UUID) {
        guard let press, press.connection == connection else { return }
        if let point = CGEvent(source: nil)?.location { press.release.location = point }
        Self.post(press.release)
        self.press = nil
    }

    private static var busy: NativeFailure {
        NativeFailure(code: "INPUT_BUSY", message: "A system mouse button is held; release it before controlling another window or button")
    }
}
