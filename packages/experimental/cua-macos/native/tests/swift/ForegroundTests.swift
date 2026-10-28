// A same-app foreground process is insufficient to skip raising a different window.
import Testing
@testable import CuaNative

private func plan(window: UInt32? = 7, role: String? = "AXWindow", main: Bool? = true,
                  minimized: Bool? = false) -> ForegroundPlan {
    ForegroundPlan(appHandle: "app", identity: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
                   snapshotID: "snapshot", index: 0, targetWindowID: window, role: role, main: main, minimized: minimized)
}

@Test func onlySkipsRaisingTheExactFocusedMainFrontWindow() {
    let current = ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: 7, frontWindowPID: 42)
    #expect(!AXWorker.shouldRaise(plan(), before: current))
    for requested in [plan(window: nil), plan(window: 8), plan(role: "AXSheet"), plan(main: nil),
                      plan(main: false), plan(minimized: nil), plan(minimized: true)] {
        #expect(AXWorker.shouldRaise(requested, before: current))
    }
    for observed in [
        ForegroundObservation(frontPID: nil, focusedWindowID: 7, frontWindowID: 7, frontWindowPID: 42),
        ForegroundObservation(frontPID: 99, focusedWindowID: 7, frontWindowID: 7, frontWindowPID: 42),
        ForegroundObservation(frontPID: 42, focusedWindowID: nil, frontWindowID: 7, frontWindowPID: 42),
        ForegroundObservation(frontPID: 42, focusedWindowID: 8, frontWindowID: 7, frontWindowPID: 42),
        ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: nil, frontWindowPID: 42),
        ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: 8, frontWindowPID: 42),
        ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: 7, frontWindowPID: nil),
        ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: 7, frontWindowPID: 99),
    ] {
        #expect(AXWorker.shouldRaise(plan(), before: observed))
    }
}

@Test func preservesUnknownForegroundValuesAndDispatchOnlyResult() {
    let observed = ForegroundObservation(frontPID: nil, focusedWindowID: nil, frontWindowID: nil, frontWindowPID: nil)
    #expect(observed.json == .object(["frontPid": .null, "focusedWindowId": .null, "frontWindowId": .null, "frontWindowPid": .null]))
    #expect(AXWorker.actionResult == .object(["dispatched": .bool(true), "verified": .bool(false)]))
}

@Test func normalizesOnlyTheObservedAXActionName() {
    #expect(AXWorker.actionKey("AXRaise") == AXWorker.actionKey("raise"))
    #expect(AXWorker.actionKey("AXZoomWindow") == AXWorker.actionKey("zoom window"))
    #expect(AXWorker.actionKey("AXRaise") != AXWorker.actionKey("AXPress"))
}
