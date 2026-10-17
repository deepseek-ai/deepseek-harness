// Activity history uses an injected monotonic clock and connection-scoped application identities.
import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

@Test @MainActor func reportsOtherActorsWithinEachConnectionsLookback() {
    var time = 100.0
    let history = RecentActivity(now: { time })
    let a = UUID(), b = UUID()
    let app = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)
    let first = ActivityTarget(process: app, windowID: 10)
    let second = ActivityTarget(process: app, windowID: 11)
    history.connect(a, lookback: 60)
    history.connect(b, lookback: 5)
    history.watch(first, owner: a)
    history.watch(first, owner: b)
    history.record(first, owner: b, operation: "click")
    history.record(second, owner: b, operation: "scroll")
    #expect(history.report(first, owner: b, monitoring: "listening")["events"] == .array([]))
    #expect(history.report(first, owner: a, monitoring: "listening")["events"] == .array([
        .object(["source": .string("other-agent"), "windowId": .number(10), "ageMs": .number(0), "operation": .string("click")]),
    ]))
    time += 6
    history.record(first, owner: a, operation: "setValue")
    #expect(history.report(first, owner: a, monitoring: "listening")["events"] != .array([]))
    time += 6
    #expect(history.report(first, owner: b, monitoring: "listening")["events"] == .array([]))
    time = 160
    #expect(history.report(first, owner: a, monitoring: "listening")["events"] != .array([]))
    time += 0.001
    #expect(history.report(first, owner: a, monitoring: "listening")["events"] == .array([]))
}

@Test @MainActor func appScopedInputAppliesToEveryWindowAndHistoryIsBoundedPerSource() {
    let history = RecentActivity(now: { 1 })
    let a = UUID(), b = UUID()
    let app = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)
    let target = ActivityTarget(process: app, windowID: 10)
    history.connect(a, lookback: 60)
    history.connect(b, lookback: 60)
    history.watch(target, owner: a)
    for _ in 0..<100 {
        history.record(target, owner: b, operation: "click")
        history.record(ActivityTarget(process: app, windowID: nil), owner: nil, operation: "keyboard")
    }
    let report = history.report(target, owner: a, monitoring: "unavailable")
    #expect(report["externalInputMonitoring"] == .string("unavailable"))
    #expect(report["events"] == .array([
        .object(["source": .string("other-agent"), "windowId": .number(10), "ageMs": .number(0), "operation": .string("click")]),
        .object(["source": .string("external-input"), "windowId": .null, "ageMs": .number(0), "operation": .string("keyboard")]),
    ]))
    history.disconnect(b)
    #expect(history.report(target, owner: a, monitoring: "listening")["events"] == report["events"])
    history.disconnect(a)
    #expect(!history.isTracked(app))
    history.connect(a, lookback: 60)
    history.watch(target, owner: a)
    #expect(history.report(target, owner: a, monitoring: "listening")["events"] == .array([]))
}

@Test @MainActor func doesNotShareHistoryAcrossProcessLifetimesOrUnobservedApps() {
    let history = RecentActivity(now: { 1 })
    let owner = UUID()
    let old = ActivityTarget(process: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0), windowID: 1)
    let new = ActivityTarget(process: ProcessIdentity(pid: 42, startedSeconds: 2, startedMicroseconds: 0), windowID: 1)
    history.connect(owner, lookback: 60)
    history.record(old, owner: nil, operation: "click")
    history.watch(old, owner: owner)
    #expect(history.report(old, owner: owner, monitoring: "listening")["events"] == .array([]))
    history.record(old, owner: nil, operation: "click")
    #expect(history.report(new, owner: owner, monitoring: "listening")["events"] == .array([]))
    #expect(history.report(old, owner: UUID(), monitoring: "listening") == .null)
}

@Test @MainActor func externalInputExcludesHelperEventsAndKeepsUnknownWindowsAtAppScope() throws {
    let history = RecentActivity(now: { 1 })
    let owner = UUID()
    let target = ActivityTarget(process: try NativePlatform.identity(getpid()), windowID: nil)
    history.connect(owner, lookback: 60)
    history.watch(target, owner: owner)
    let monitor = ExternalInputMonitor(activity: history)
    defer { monitor.stop() }
    let event = try #require(CGEvent(source: nil))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(getpid()))
    event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(getpid()))
    monitor.receive(.keyDown, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening")["events"] == .array([]))
    event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    monitor.receive(.mouseMoved, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening")["events"] == .array([]))
    monitor.receive(.keyDown, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening")["events"] == .array([
        .object(["source": .string("external-input"), "windowId": .null, "ageMs": .number(0), "operation": .string("keyboard")]),
    ]))
    monitor.receive(.tapDisabledByTimeout, event: event)
    #expect(monitor.status != "listening")
}
