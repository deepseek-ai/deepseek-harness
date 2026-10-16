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

    private struct DragStep {
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
    @MainActor static func hover(in route: WindowRoute, at point: WindowPoint, checkCancellation: @Sendable () throws -> Void) throws {
        try checkCancellation()
        try Self.validate(point, in: route)
        try NativePlatform.verify(route.owner)
        try NativePlatform.requireUnlocked(NativePlatform.sessionLocked())
        let current = try NativePlatform.ownedWindow(route.owner.pid, route.windowID)
        guard current.bounds == route.bounds else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized before hover; read fresh state")
        }
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                  mouseCursorPosition: Self.screenPoint(point, in: route), mouseButton: .left) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create system pointer movement")
        }
        event.flags = []
        try Self.requireSystemPointerTarget(route, frontPID: NativePlatform.frontPID(),
                                            hitWindowID: NativePlatform.mouseWindow(at: Self.screenPoint(point, in: route)))
        try checkCancellation()
        event.post(tap: .cghidEventTap)
        try checkCancellation()
    }

    /// Input-transparent windows do not obscure a target; AppKit owns mouse hit testing.
    static func requireSystemPointerTarget(_ route: WindowRoute, frontPID: Int32?, hitWindowID: Int) throws {
        guard frontPID == route.owner.pid, hitWindowID == Int(route.windowID) else {
            throw NativeFailure(code: "FOREGROUND_REQUIRED", message: "System-pointer hover requires foreground PID \(route.owner.pid) and mouse-hit window \(route.windowID); observed foreground PID \(frontPID.map(String.init) ?? "unknown") and mouse-hit window \(hitWindowID). Activate or raise the target explicitly, then observe again")
        }
    }

    /// Post one or two left clicks, or one right/middle click, with a shared window-routing group.
    func click(in route: WindowRoute, at point: WindowPoint, button: String, count: Int, modifiers: [String] = []) throws {
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
            Thread.sleep(forTimeInterval: 0.015)
            for (index, pair) in pairs.enumerated() {
                try postPair(pair, to: route.owner.pid, downInterval: 0.001)
                if index + 1 < pairs.count { Thread.sleep(forTimeInterval: 0.080) }
            }
        } else {
            let pair = try mousePair(
                source: source, route: route, screen: screen, local: point,
                button: selectedButton, clickState: 1, group: group, flags: flags
            )
            try checkCancellation()
            poster.post(move, to: route.owner.pid)
            Thread.sleep(forTimeInterval: 0.012)
            try postPair(pair, to: route.owner.pid, downInterval: 0.028)
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
        button: String = "left", modifiers: [String] = []
    ) throws {
        try checkCancellation()
        try Self.validate(start, in: route)
        try Self.validate(end, in: route)
        guard (1...5000).contains(durationMs), (1...240).contains(steps) else {
            throw NativeFailure(code: "INVALID_ARGUMENT", message: "Drag durationMs must be 1...5000 and steps 1...240")
        }
        let source = try Self.source()
        let selectedButton = try Self.button(button)
        let flags = try KeyboardInput.modifierFlags(modifiers)
        let group = Self.clickGroup()
        let down = try mouseEvent(
            source: source, route: route, screen: Self.screenPoint(start, in: route), local: start,
            type: Self.down(selectedButton), button: selectedButton, clickState: 1, subtype: 0, group: group, flags: flags
        )
        let initialRelease = try mouseEvent(
            source: source, route: route, screen: Self.screenPoint(start, in: route), local: start,
            type: Self.up(selectedButton), button: selectedButton, clickState: 1, subtype: 0, group: group, flags: flags
        )
        var path: [DragStep] = []
        for index in 1...steps {
            let fraction = Double(index) / Double(steps)
            let local = WindowPoint(
                x: start.x + (end.x - start.x) * fraction,
                y: start.y + (end.y - start.y) * fraction
            )
            let screen = Self.screenPoint(local, in: route)
            path.append(DragStep(
                movement: try mouseEvent(
                    source: source, route: route, screen: screen, local: local,
                    type: Self.dragged(selectedButton), button: selectedButton, clickState: 1, subtype: 0, group: group, flags: flags
                ),
                release: try mouseEvent(
                    source: source, route: route, screen: screen, local: local,
                    type: Self.up(selectedButton), button: selectedButton, clickState: 1, subtype: 0, group: group, flags: flags
                )
            ))
        }
        var heldRelease: CGEvent?
        do {
            defer {
                if let heldRelease {
                    poster.post(heldRelease, to: route.owner.pid)
                    Thread.sleep(forTimeInterval: 0.100)
                }
            }
            try checkCancellation()
            poster.post(down, to: route.owner.pid)
            heldRelease = initialRelease
            Thread.sleep(forTimeInterval: 0.016)
            let stepInterval = Self.dragStepInterval(durationMs: durationMs, steps: steps)
            for step in path {
                try checkCancellation()
                poster.post(step.movement, to: route.owner.pid)
                heldRelease = step.release
                if stepInterval > 0 { Thread.sleep(forTimeInterval: stepInterval) }
            }
            Thread.sleep(forTimeInterval: 0.050)
            try checkCancellation()
            if let release = heldRelease { poster.post(release, to: route.owner.pid) }
            heldRelease = nil
            Thread.sleep(forTimeInterval: 0.100)
        }
        try checkCancellation()
    }

    private func postPair(_ pair: MousePair, to pid: Int32, downInterval: TimeInterval) throws {
        var held = false
        defer {
            if held { poster.post(pair.up, to: pid) }
        }
        try checkCancellation()
        poster.post(pair.down, to: pid)
        held = true
        Thread.sleep(forTimeInterval: downInterval)
        try checkCancellation()
        poster.post(pair.up, to: pid)
        held = false
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
