// A controlled clock distinguishes new activity, repeated observations, and expired history.
import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

private let process = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)

@Test @MainActor func reportsOtherActorsOnceWithoutSuppressingLaterIdenticalInput() throws {
    var time = 100.0
    let history = RecentActivity(now: { time })
    let a = UUID(), b = UUID()
    let target = ActivityTarget(process: process, windowID: 10)
    let lookback = try #require(HelperConfiguration(arguments: []).recentActivityWindowMs)
    #expect(lookback == 10_000)
    history.connect(a, lookbackMs: lookback)
    history.connect(b, lookbackMs: lookback)
    history.watch(target, owner: a)
    history.watch(target, owner: b)
    history.record(target, owner: b, operation: "invoke")
    #expect(history.report(target, owner: b, monitoring: "listening") == nil)
    #expect(history.report(target, owner: a, monitoring: "listening")?["events"] == .array([
        .object(["source": .string("agent"), "windowId": .string("10"), "ageMs": .number(0), "operation": .string("invoke")]),
    ]))
    #expect(history.report(target, owner: a, monitoring: "listening") == nil)
    // Identical operations at the same clock reading are distinct records.
    history.record(target, owner: b, operation: "invoke")
    #expect(history.report(target, owner: a, monitoring: "listening") != nil)
    time += 1
    history.record(target, owner: b, operation: "invoke")
    time += 10.001
    #expect(history.report(target, owner: a, monitoring: "listening") == nil)
}

@Test @MainActor func scopesReportsToWindowsAndUsesEachClientsLookback() {
    var time = 10.0
    let history = RecentActivity(now: { time })
    let a = UUID(), b = UUID(), source = UUID()
    let first = ActivityTarget(process: process, windowID: 10)
    let second = ActivityTarget(process: process, windowID: 11)
    history.connect(a, lookbackMs: 60000)
    history.connect(b, lookbackMs: 1001)
    history.watch(first, owner: a)
    history.watch(first, owner: b)
    history.record(first, owner: source, operation: "click")
    #expect(history.report(second, owner: a, monitoring: "listening") == nil)
    time += 2
    #expect(history.report(first, owner: b, monitoring: "listening") == nil)
    #expect(history.report(first, owner: a, monitoring: "listening")?["lookbackMs"] == .number(60000))
    history.record(ActivityTarget(process: process, windowID: nil), owner: nil, operation: "keyboard")
    #expect(history.report(second, owner: b, monitoring: "listening")?["lookbackMs"] == .number(1001))
}

@Test @MainActor func keepsRecentHistoryAfterDisconnectAndClearsUnwatchedApps() {
    let history = RecentActivity(now: { 1 })
    let a = UUID(), b = UUID()
    let target = ActivityTarget(process: process, windowID: nil)
    history.connect(a, lookbackMs: 60000)
    history.connect(b, lookbackMs: 60000)
    history.watch(target, owner: a)
    history.watch(target, owner: b)
    history.record(target, owner: b, operation: "typeText")
    history.disconnect(b)
    #expect(history.report(target, owner: a, monitoring: "listening") != nil)
    history.disconnect(a)
    #expect(!history.isTracked(process))
    history.connect(a, lookbackMs: 60000)
    history.watch(target, owner: a)
    #expect(history.report(target, owner: a, monitoring: "listening") == nil)
}

@Test @MainActor func reportsMonitoringLossAndRecoveryWithoutInventingInput() {
    let history = RecentActivity(now: { 1 })
    let owner = UUID()
    let target = ActivityTarget(process: process, windowID: nil)
    history.connect(owner, lookbackMs: 60000)
    history.watch(target, owner: owner)
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    #expect(history.report(target, owner: owner, monitoring: "unavailable")?["events"] == .array([]))
    #expect(history.report(target, owner: owner, monitoring: "unavailable") == nil)
    #expect(history.report(target, owner: owner, monitoring: "secure-input")?["externalInputMonitoring"] == .string("secure-input"))
    #expect(history.report(target, owner: owner, monitoring: "listening")?["externalInputMonitoring"] == .string("listening"))
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
}

@Test @MainActor func doesNotReplayOlderSourcesOrCrossProcessLifetimes() {
    let history = RecentActivity(now: { 1 })
    let owner = UUID()
    let target = ActivityTarget(process: process, windowID: nil)
    history.connect(owner, lookbackMs: 60000)
    history.record(target, owner: UUID(), operation: "untracked")
    history.watch(target, owner: owner)
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    history.record(target, owner: UUID(), operation: "older")
    history.record(target, owner: UUID(), operation: "newer")
    history.record(target, owner: nil, operation: "keyboard")
    #expect(history.report(target, owner: owner, monitoring: "listening")?["events"] == .array([
        .object(["source": .string("agent"), "windowId": .null, "ageMs": .number(0), "operation": .string("newer")]),
        .object(["source": .string("external-input"), "windowId": .null, "ageMs": .number(0), "operation": .string("keyboard")]),
    ]))
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    let restarted = ActivityTarget(process: ProcessIdentity(pid: 42, startedSeconds: 2, startedMicroseconds: 0), windowID: nil)
    #expect(history.report(restarted, owner: owner, monitoring: "listening") == nil)
}

@Test @MainActor func externalInputFiltersHelperEventsAndKeepsNewKeystrokes() throws {
    let history = RecentActivity(now: { 1 })
    let owner = UUID()
    let target = ActivityTarget(process: try NativePlatform.identity(getpid()), windowID: nil)
    history.connect(owner, lookbackMs: 60000)
    history.watch(target, owner: owner)
    let monitor = ExternalInputMonitor(activity: history)
    let event = try #require(CGEvent(source: nil))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(getpid()))
    event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(getpid()))
    monitor.receive(.keyDown, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    monitor.receive(.mouseMoved, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    monitor.receive(.keyDown, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening")?["events"] == .array([
        .object(["source": .string("external-input"), "windowId": .null, "ageMs": .number(0), "operation": .string("keyboard")]),
    ]))
    #expect(history.report(target, owner: owner, monitoring: "listening") == nil)
    monitor.receive(.keyDown, event: event)
    #expect(history.report(target, owner: owner, monitoring: "listening") != nil)
}
