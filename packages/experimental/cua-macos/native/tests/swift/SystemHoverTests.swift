// System-pointer movement must not target another app or an obscured window.
import Testing
import CoreGraphics
@testable import CuaNative

@Test func systemHoverRequiresTheForegroundUnobscuredTarget() throws {
    let owner = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)
    let bounds = WindowBounds(x: 100, y: 100, width: 400, height: 300)
    let route = WindowRoute(owner: owner, windowID: 7, bounds: bounds)
    try WindowPointerInput.requireSystemPointerTarget(route, frontPID: 42, hitWindowID: 7)
    for pid: Int32? in [nil, 99] {
        #expect(throws: NativeFailure.self) {
            try WindowPointerInput.requireSystemPointerTarget(route, frontPID: pid, hitWindowID: 7)
        }
    }
    for hitWindowID in [0, -1, 8] {
        #expect(throws: NativeFailure.self) {
            try WindowPointerInput.requireSystemPointerTarget(route, frontPID: 42, hitWindowID: hitWindowID)
        }
    }
}

@Test func hoverHitTestingUsesThePrimaryDisplayOriginForEveryDisplay() {
    #expect(WindowGeometry.appKitPoint(CGPoint(x: 120, y: 230), mainDisplayHeight: 900) == CGPoint(x: 120, y: 670))
    #expect(WindowGeometry.appKitPoint(CGPoint(x: -800, y: -200), mainDisplayHeight: 900) == CGPoint(x: -800, y: 1100))
    #expect(WindowGeometry.appKitPoint(CGPoint(x: 2100, y: 1200), mainDisplayHeight: 900) == CGPoint(x: 2100, y: -300))
}
