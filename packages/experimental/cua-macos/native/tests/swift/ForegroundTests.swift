import Testing
@testable import CuaNative

@Test func preservesUnknownForegroundValuesAndDispatchOnlyResult() {
    let observed = ForegroundObservation(frontPID: nil, focusedWindowID: nil, frontWindowID: nil, frontWindowPID: nil)
    #expect(observed.json == .object(["frontPid": .null, "focusedWindowId": .null, "frontWindowId": .null, "frontWindowPid": .null]))
    #expect(AXWorker.actionResult == .object(["dispatched": .bool(true)]))
}

@Test func emitsForegroundWindowIDsAsStringsAndPIDsAsNumbers() {
    let observed = ForegroundObservation(frontPID: 42, focusedWindowID: 7, frontWindowID: 8, frontWindowPID: 43)
    #expect(observed.json == .object([
        "frontPid": .number(42), "focusedWindowId": .string("7"),
        "frontWindowId": .string("8"), "frontWindowPid": .number(43),
    ]))
}

@Test func reportsOnlyObservableForegroundChanges() {
    #expect(ForegroundObservation.change(beforePID: 1, beforeWindow: nil, afterPID: 2, afterWindow: nil) == .bool(true))
    #expect(ForegroundObservation.change(beforePID: nil, beforeWindow: 3, afterPID: nil, afterWindow: 4) == .bool(true))
    #expect(ForegroundObservation.change(beforePID: 1, beforeWindow: 3, afterPID: 1, afterWindow: 3) == .bool(false))
    #expect(ForegroundObservation.change(beforePID: 1, beforeWindow: nil, afterPID: 1, afterWindow: 3) == .null)
}
