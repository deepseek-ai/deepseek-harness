import Testing
@testable import CuaNative

@Test func preservesUnknownForegroundValuesAndDispatchOnlyResult() {
    let observed = ForegroundObservation(frontPID: nil, focusedWindowID: nil, frontWindowID: nil, frontWindowPID: nil)
    #expect(observed.json == .object(["frontPid": .null, "focusedWindowId": .null, "frontWindowId": .null, "frontWindowPid": .null]))
    #expect(AXWorker.actionResult == .object(["dispatched": .bool(true)]))
}
