// Frame comparison is independent of WindowServer, AX permission and desktop state.
import Testing
@testable import CuaNative

private func frame(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> WindowBounds {
    WindowBounds(x: x, y: y, width: width, height: height)
}

@Test func coordinateInputRequiresAnObservedWindowSize() {
    do {
        try WindowGeometry.validateObservedSize(observed: nil, current: frame(0, 0, 320, 200))
        Issue.record("Unobserved coordinates were accepted")
    } catch let error as NativeFailure { #expect(error.code == "STALE_SNAPSHOT") }
    catch { Issue.record("Unexpected error: \(error)") }
}

@Test(arguments: [frame(0, 0, 321, 200), frame(0, 0, 320, 201), frame(0, 0, 320.5, 200)])
func coordinateInputRejectsAWindowResizedSinceObservation(_ current: WindowBounds) {
    do {
        try WindowGeometry.validateObservedSize(observed: frame(0, 0, 320, 200), current: current)
        Issue.record("Coordinates from before resizing were accepted")
    } catch let error as NativeFailure { #expect(error.code == "WINDOW_CHANGED") }
    catch { Issue.record("Unexpected error: \(error)") }
}

@Test func coordinateInputAllowsWindowMovementAndFreshlyObservedSizes() throws {
    try WindowGeometry.validateObservedSize(observed: frame(0, 0, 320, 200), current: frame(-900, 120, 320, 200))
    try WindowGeometry.validateObservedSize(observed: frame(0, 0, 500, 400), current: frame(0, 0, 500, 400))
}

@Test(arguments: [
    (frame(221, 50, 1200, 832), frame(16, 512, 131, 145)),
    (frame(-600, -100, 320, 200), frame(-599, -100, 320, 200)),
    (frame(0, 0, 131, 145), frame(0, 0, 132, 145)),
])
func rejectsDifferentAXAndDisplayRectangles(_ ax: WindowBounds, _ cg: WindowBounds) {
    do {
        try WindowGeometry.validate(before: cg, after: cg, accessibility: ax)
        Issue.record("Conflicting window geometry was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "WINDOW_CHANGED")
        #expect(error.message == WindowGeometry.conflictMessage)
    } catch { Issue.record("Unexpected error: \(error)") }
}

@Test(arguments: [
    (frame(16, 512, 131, 145), frame(16, 512, 131, 145)),
    (frame(-1145, -1080, 320, 200), frame(-1145, -1080, 320, 200)),
    (frame(10.25, 20.25, 99.5, 49.5), frame(10, 20, 100, 50)),
    (frame(-10.75, -20.75, 9.5, 4.5), frame(-11, -21, 10, 5)),
])
func acceptsTheSameIntegralPointRectangle(_ ax: WindowBounds, _ cg: WindowBounds) throws {
    try WindowGeometry.validate(before: cg, after: cg, accessibility: ax)
}

@Test func preservesUnknownAXGeometry() throws {
    let cg = frame(16, 512, 131, 145)
    for ax in [nil, frame(0, 0, 0, 0), frame(0, 0, -1, 10), frame(.nan, 0, 10, 10)] {
        try WindowGeometry.validate(before: cg, after: cg, accessibility: ax)
    }
}

@Test func rejectsMovementDuringAnAXlessRead() {
    #expect(throws: NativeFailure.self) {
        try WindowGeometry.validate(before: frame(0, 0, 320, 200), after: frame(0.25, 0, 320, 200), accessibility: nil)
    }
}

private let geometryOwner = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)

private func geometryWindow(_ bounds: WindowBounds) -> WindowInfo {
    WindowInfo(windowID: 7, pid: geometryOwner.pid, appName: "Fixture", title: "Fixture", bounds: bounds,
               isOnScreen: true, onCurrentSpace: true)
}

@Test func resolveDetectsMovementDuringTheAXQueryEvenWhenTheFinalFramesMatch() {
    var current = frame(0, 0, 320, 200)
    do {
        _ = try WindowGeometry.resolve(owner: geometryOwner, windowID: 7,
            readWindow: { _, _ in geometryWindow(current) }, verifyOwner: { _ in },
            accessibilityBounds: { current = frame(20, 30, 320, 200); return current })
        Issue.record("Movement during AX observation was accepted")
    } catch let error as NativeFailure { #expect(error.code == "WINDOW_CHANGED") }
    catch { Issue.record("Unexpected error: \(error)") }
}

@Test func resolveRejectsAProcessReplacedDuringTheAXQuery() {
    var currentOwner = geometryOwner
    var reads = 0
    let bounds = frame(0, 0, 320, 200)
    do {
        _ = try WindowGeometry.resolve(owner: geometryOwner, windowID: 7,
            readWindow: { _, _ in reads += 1; return geometryWindow(bounds) },
            verifyOwner: { expected in
                guard currentOwner == expected else { throw NativeFailure(code: "STALE_APP", message: "Process replaced") }
            },
            accessibilityBounds: {
                currentOwner = ProcessIdentity(pid: geometryOwner.pid, startedSeconds: 2, startedMicroseconds: 0)
                return bounds
            })
        Issue.record("A replaced process was accepted")
    } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
    catch { Issue.record("Unexpected error: \(error)") }
    #expect(reads == 1)
}
