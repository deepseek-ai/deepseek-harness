// Pointer event fields and pacing follow DSH's MIT-licensed Cua Driver adaptation.
import CoreGraphics
import Dispatch
import Foundation

/// Window-local gestures for a route whose owner and process generation the caller has validated.
final class WindowPointerInput {
    private struct MousePair {
        let down: CGEvent
        let up: CGEvent
    }

    struct DragStep {
        let movement: CGEvent
        let release: CGEvent
    }

    private let poster: PIDEventPoster
    private let checkCancellation: @Sendable () throws -> Void

    init(poster: PIDEventPoster, checkCancellation: @escaping @Sendable () throws -> Void = {}) {
        self.poster = poster
        self.checkCancellation = checkCancellation
    }

    /// Requested movement time is distributed across every validated drag segment.
    static func dragStepInterval(durationMs: Int, steps: Int) -> TimeInterval {
        Double(durationMs) / Double(steps) / 1000
    }

    /// Move the visible cursor without restoring the prior point or reserving the application.
    @MainActor static func mouseMove(in route: WindowRoute, at point: WindowPoint, checkCancellation: @Sendable () throws -> Void) throws {
        try checkCancellation()
        try Self.validate(point, in: route)
        try validateSystemWindow(route)
        let screen = screenPoint(point, in: route)
        try checkSystemHit(route, at: screen)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                  mouseCursorPosition: screen, mouseButton: .left) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create system pointer movement")
        }
        event.flags = []
        try checkCancellation()
        event.post(tap: .cghidEventTap)
        try checkCancellation()
    }

    private static func validateSystemWindow(_ route: WindowRoute) throws {
        try NativePlatform.verify(route.owner)
        try NativePlatform.requireUnlocked(NativePlatform.sessionLocked())
        let current = try NativePlatform.ownedWindow(route.owner.pid, route.windowID)
        guard current.bounds == route.bounds else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized before system-pointer input; read fresh state")
        }
    }

    @MainActor private static func checkSystemHit(_ route: WindowRoute, at screen: CGPoint) throws {
        try requireSystemPointerTarget(route, frontPID: NativePlatform.frontPID(), hitWindowID: NativePlatform.mouseWindow(at: screen))
    }

    /// Input-transparent windows do not obscure a target; AppKit owns mouse hit testing.
    static func requireSystemPointerTarget(_ route: WindowRoute, frontPID: Int32?, hitWindowID: Int) throws {
        guard frontPID == route.owner.pid, hitWindowID == Int(route.windowID) else {
            throw NativeFailure(code: "FOREGROUND_REQUIRED", message: "System-pointer input requires foreground PID \(route.owner.pid) and mouse-hit window \(route.windowID); observed foreground PID \(frontPID.map(String.init) ?? "unknown") and mouse-hit window \(hitWindowID). Call app.activate() or use performAction with an advertised AXRaise, then observe again")
        }
    }

    /// Post balanced mouse presses; holdMs replaces each press-to-release interval and remains cancellable.
    func click(in route: WindowRoute, at point: WindowPoint, button: String, count: Int, modifiers: [String] = [],
               holdMs: Int? = nil, isolation: isolated (any Actor)? = #isolation) async throws {
        try checkCancellation()
        try Self.validate(point, in: route)
        guard (button == "left" && (count == 1 || count == 2)) || (["right", "middle"].contains(button) && count == 1) else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Unsupported mouse button or click count")
        }
        let source = try Self.source()
        let selectedButton = try Self.button(button)
        let flags = try KeyboardInput.modifierFlags(modifiers)
        let group = Self.clickGroup()
        let screen = Self.screenPoint(point, in: route)
        let move = try mouseEvent(
            source: source, route: route, screen: screen, local: point,
            type: .mouseMoved, button: .left, clickState: 0, subtype: 3,
            group: group, number: button == "left" ? 2 : nil, flags: flags
        )
        if button == "left" {
            var pairs: [MousePair] = []
            for index in 1...count {
                pairs.append(try mousePair(
                    source: source, route: route, screen: screen, local: point,
                    button: .left, clickState: Int64(index), group: group, downNumber: 3, upNumber: 3, flags: flags
                ))
            }
            try checkCancellation()
            poster.post(move, to: route.owner.pid)
            try await Task.sleep(for: .milliseconds(15))
            for (index, pair) in pairs.enumerated() {
                try await Self.postPair(downInterval: .milliseconds(holdMs ?? 1), checkCancellation: checkCancellation,
                    down: { poster.post(pair.down, to: route.owner.pid) }, up: { poster.post(pair.up, to: route.owner.pid) })
                if index + 1 < pairs.count { try await Task.sleep(for: .milliseconds(80)) }
            }
        } else {
            let pair = try mousePair(
                source: source, route: route, screen: screen, local: point,
                button: selectedButton, clickState: 1, group: group, flags: flags
            )
            try checkCancellation()
            poster.post(move, to: route.owner.pid)
            try await Task.sleep(for: .milliseconds(12))
            try await Self.postPair(downInterval: .milliseconds(holdMs ?? 28), checkCancellation: checkCancellation,
                down: { poster.post(pair.down, to: route.owner.pid) }, up: { poster.post(pair.up, to: route.owner.pid) })
        }
        try checkCancellation()
    }

    /// Send one two-axis line-unit wheel event after its window-local tracking primer.
    func scroll(
        in route: WindowRoute, at point: WindowPoint, deltaLinesX: Int32, deltaLinesY: Int32
    ) throws {
        try checkCancellation()
        try Self.validate(point, in: route)
        guard (-10...10).contains(deltaLinesX), (-10...10).contains(deltaLinesY),
              deltaLinesX != 0 || deltaLinesY != 0 else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Scroll requires nonzero line deltas within -10...10")
        }
        let source = try Self.source()
        let screen = Self.screenPoint(point, in: route)
        let move = try mouseEvent(
            source: source, route: route, screen: screen, local: point,
            type: .mouseMoved, button: .left, clickState: 0, subtype: 3, group: Self.clickGroup()
        )
        guard let wheel = CGEvent(
            scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
            wheel1: deltaLinesY, wheel2: deltaLinesX, wheel3: 0
        ) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create scroll event")
        }
        wheel.location = screen
        wheel.flags = []
        try poster.stampWindow(wheel, pid: route.owner.pid, windowID: route.windowID, point: point)
        try checkCancellation()
        poster.post(move, to: route.owner.pid)
        Thread.sleep(forTimeInterval: 0.012)
        try checkCancellation()
        poster.post(wheel, to: route.owner.pid)
        Thread.sleep(forTimeInterval: 0.030)
        try checkCancellation()
    }

    /// Drag the selected button along an interpolated path, releasing at the last posted point on cancellation.
    func drag(
        in route: WindowRoute, from start: WindowPoint, to end: WindowPoint, durationMs: Int, steps: Int,
        button: String = "left", modifiers: [String] = [], useSystemPointer: Bool = false,
        isolation: isolated (any Actor)? = #isolation
    ) async throws {
        try checkCancellation()
        try Self.validate(start, in: route)
        try Self.validate(end, in: route)
        guard (1...5000).contains(durationMs), (1...240).contains(steps) else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Drag durationMs must be 1...5000 and steps 1...240")
        }
        let source = try Self.source()
        let selected = try Self.button(button)
        let flags = try KeyboardInput.modifierFlags(modifiers)
        let group = Self.clickGroup()
        func event(_ type: CGEventType, at point: WindowPoint) throws -> CGEvent {
            let screen = Self.screenPoint(point, in: route)
            if !useSystemPointer {
                return try mouseEvent(source: source, route: route, screen: screen, local: point, type: type,
                                      button: selected, clickState: 1, subtype: 0, group: group, flags: flags)
            }
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: screen, mouseButton: selected) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create system drag event")
            }
            event.flags = flags
            event.setIntegerValueField(.mouseEventNumber, value: group)
            event.setIntegerValueField(.mouseEventClickState, value: type == .mouseMoved ? 0 : 1)
            return event
        }
        func post(_ event: CGEvent) {
            if useSystemPointer {
                event.timestamp = DispatchTime.now().uptimeNanoseconds
                event.post(tap: .cghidEventTap)
            } else {
                poster.post(event, to: route.owner.pid)
            }
        }
        let down = try event(Self.down(selected), at: start)
        let initialRelease = try event(Self.up(selected), at: start)
        var previous = start
        var path: [DragStep] = []
        for index in 1...steps {
            let fraction = Double(index) / Double(steps)
            let local = WindowPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
            let movement = try event(Self.dragged(selected), at: local)
            if useSystemPointer {
                movement.setIntegerValueField(.mouseEventDeltaX, value: Int64(local.x.rounded() - previous.x.rounded()))
                movement.setIntegerValueField(.mouseEventDeltaY, value: Int64(local.y.rounded() - previous.y.rounded()))
            }
            path.append(DragStep(movement: movement, release: try event(Self.up(selected), at: local)))
            previous = local
        }
        if useSystemPointer {
            try Self.validateSystemWindow(route)
            try await Self.checkSystemHit(route, at: down.location)
            try Self.requireReleasedButtons()
            try checkCancellation()
            post(try event(.mouseMoved, at: start))
        }
        let check = checkCancellation
        try await Self.postDrag(down: down, initialRelease: initialRelease, path: path,
                                interval: Self.dragStepInterval(durationMs: durationMs, steps: steps),
                                validate: { type, point in
            if useSystemPointer {
                try await Self.checkSystemHit(route, at: point)
                if type == Self.down(selected) { try Self.requireReleasedButtons() }
            }
            try check()
        }, post: post)
        try checkCancellation()
    }

    static func requireReleasedButtons(isPressed: (CGMouseButton) -> Bool = {
        CGEventSource.buttonState(.combinedSessionState, button: $0)
    }) throws {
        if [CGMouseButton.left, .right, .center].contains(where: isPressed) {
            throw NativeFailure(code: "INPUT_BUSY", message: "Wait for the held mouse button to be released before requesting a system drag")
        }
    }

    /// After a press, always post one release at the last posted point, even when validation or a wait fails.
    static func postDrag(down: CGEvent, initialRelease: CGEvent, path: [DragStep], interval: TimeInterval,
                         validate: (CGEventType, CGPoint) async throws -> Void, post: (CGEvent) -> Void,
                         isolation: isolated (any Actor)? = #isolation) async throws {
        try await validate(down.type, down.location)
        post(down)
        var release = initialRelease
        var failure: (any Error)?
        do {
            try await Task.sleep(for: .milliseconds(16))
            for step in path {
                try await validate(step.movement.type, step.movement.location)
                post(step.movement)
                release = step.release
                try await Task.sleep(for: .seconds(interval))
            }
            try await Task.sleep(for: .milliseconds(50))
            try await validate(release.type, release.location)
        } catch { failure = error }
        post(release)
        // The next input request must allow time for release processing even when this request was cancelled.
        try await Task { try await Task.sleep(for: .milliseconds(100)) }.value
        if let failure { throw failure }
    }

    /// Every posted down is paired with exactly one up, including cancellation during the wait.
    static func postPair(downInterval: Duration, checkCancellation: () throws -> Void,
                         down: () -> Void, up: () -> Void, isolation: isolated (any Actor)? = #isolation) async throws {
        try checkCancellation()
        down()
        defer { up() }
        try await Task.sleep(for: downInterval)
        try checkCancellation()
    }

    private func mousePair(
        source: CGEventSource, route: WindowRoute, screen: CGPoint, local: WindowPoint,
        button: CGMouseButton, clickState: Int64, group: Int64,
        downNumber: Int64? = nil, upNumber: Int64? = nil, flags: CGEventFlags = []
    ) throws -> MousePair {
        try MousePair(
            down: mouseEvent(
                source: source, route: route, screen: screen, local: local,
                type: Self.down(button),
                button: button, clickState: clickState, subtype: 3, group: group, number: downNumber, flags: flags
            ),
            up: mouseEvent(
                source: source, route: route, screen: screen, local: local,
                type: Self.up(button),
                button: button, clickState: clickState, subtype: 3, group: group, number: upNumber, flags: flags
            )
        )
    }

    private func mouseEvent(
        source: CGEventSource, route: WindowRoute, screen: CGPoint, local: WindowPoint,
        type: CGEventType, button: CGMouseButton, clickState: Int64, subtype: Int64,
        group: Int64, number: Int64? = nil, flags: CGEventFlags = []
    ) throws -> CGEvent {
        guard let event = CGEvent(
            mouseEventSource: source, mouseType: type, mouseCursorPosition: screen, mouseButton: button
        ) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create pointer event")
        }
        event.flags = flags
        try poster.stampWindow(event, pid: route.owner.pid, windowID: route.windowID, point: local)
        let fields: [(UInt32, Int64)] = [(1, clickState), (3, Int64(button.rawValue)), (7, subtype), (58, group)]
        for (field, value) in fields { try poster.stamp(event, field: field, value: value) }
        if let number { try poster.stamp(event, field: 0, value: number) }
        return event
    }

    static func button(_ name: String) throws -> CGMouseButton {
        switch name {
        case "left": return .left
        case "right": return .right
        case "middle": return .center
        default: throw NativeFailure(code: "INVALID_ARGUMENT", message: "Unsupported mouse button")
        }
    }
    static func down(_ button: CGMouseButton) -> CGEventType {
        button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
    }
    static func up(_ button: CGMouseButton) -> CGEventType {
        button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    }
    static func dragged(_ button: CGMouseButton) -> CGEventType {
        button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
    }

    static func validate(_ point: WindowPoint, in route: WindowRoute) throws {
        guard point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0,
              point.x < route.bounds.width, point.y < route.bounds.height,
              (route.bounds.x + point.x).isFinite, (route.bounds.y + point.y).isFinite else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Point is outside the selected window; use window-local macOS points")
        }
    }

    private static func screenPoint(_ point: WindowPoint, in route: WindowRoute) -> CGPoint {
        CGPoint(x: CGFloat(route.bounds.x + point.x), y: CGFloat(route.bounds.y + point.y))
    }

    private static func source() throws -> CGEventSource {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create pointer event source")
        }
        return source
    }

    private static func clickGroup() -> Int64 {
        Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
    }
}
