// Window activity uses the monotonic event time shared by the helper and Quartz.
import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

private let process = ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0)
private let target = ActivityTarget(process: process, windowID: 10)
private let second: UInt64 = 1_000_000_000

@Test @MainActor func reportsLatestTimePerSourceOnceBetweenWindowUses() throws {
    var time = second
    let history = RecentActivity(now: { time })
    let a = UUID(), b = UUID()
    let lookback = try #require(HelperConfiguration(arguments: []).recentActivityWindowMs)
    #expect(lookback == 60_000)
    history.connect(a, lookbackMs: lookback)
    history.observe(target, handle: "app", owner: a)
    func take() -> [JSONValue] { history.take(owner: a, handle: "app", windowIDs: ["10"]) }
    history.record(target, owner: b, at: time)
    time += second
    history.record(target, owner: a)
    #expect(take().isEmpty)
    history.record(target, owner: b)
    time += second
    history.record(target, owner: b)
    history.record(target, owner: b, at: time - second)
    time += second
    history.record(target, owner: nil)
    time += second
    #expect(history.take(owner: a, handle: "other", windowIDs: ["10"]).isEmpty)
    #expect(history.take(owner: a, handle: "app", windowIDs: ["11"]).isEmpty)
    #expect(take() == [
        .object(["source": .string("agent"), "windowId": .string("10"), "ageSeconds": .number(2)]),
        .object(["source": .string("external-input"), "windowId": .string("10"), "ageSeconds": .number(1)]),
    ])
    #expect(!history.hasInterests)
    history.record(target, owner: b)
    #expect(take().isEmpty)
    history.record(target, owner: a)
    #expect(history.hasInterests)
    time += 1
    history.record(target, owner: b)
    #expect(take().count == 1)
}

@Test @MainActor func filtersByLatestObservationLookbackAndProcessLifetime() {
    var time = second
    let history = RecentActivity(now: { time })
    let owner = UUID(), other = UUID()
    history.connect(owner, lookbackMs: 1_000)
    func observe() { history.observe(target, handle: "app", owner: owner) }
    func take() -> [JSONValue] { history.take(owner: owner, handle: "app", windowIDs: ["10"]) }
    observe()
    time += 1
    history.record(target, owner: other)
    observe()
    history.record(target, owner: nil, at: time - 1)
    #expect(take().isEmpty)
    history.record(ActivityTarget(process: ProcessIdentity(pid: 42, startedSeconds: 2, startedMicroseconds: 0), windowID: 10), owner: other)
    history.record(ActivityTarget(process: process, windowID: 11), owner: other)
    #expect(take().isEmpty)
    time += 1
    history.record(target, owner: nil)
    time += second + 1
    #expect(take().isEmpty)
    history.record(target, owner: other)
    time += second
    #expect(take().count == 1)
    observe()
    history.clear(owner)
    #expect(!history.isTracked(process))
    history.record(target, owner: other)
    #expect(take().isEmpty)
    observe()
    history.disconnect(owner)
    #expect(!history.hasInterests)
    #expect(take().isEmpty)
}

@Test @MainActor func externalInputNeedsAWindowAndANonHelperSource() throws {
    let owner = UUID()
    let history = RecentActivity()
    let target = ActivityTarget(process: try NativePlatform.identity(getpid()), windowID: 10)
    history.connect(owner, lookbackMs: 60_000)
    history.observe(target, handle: "app", owner: owner)
    let monitor = ExternalInputMonitor(activity: history)
    let event = try #require(CGEvent(source: nil))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(getpid()))
    event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(getpid()))
    monitor.receive(.leftMouseDown, event: event)
    event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    monitor.receive(.keyDown, event: event)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: 0)
    monitor.receive(.scrollWheel, event: event)
    #expect(history.take(owner: owner, handle: "app", windowIDs: ["10"]).isEmpty)
}
