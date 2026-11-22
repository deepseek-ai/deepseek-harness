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
    let observed = history.observe(target, handle: "app", owner: a)
    func take() -> [JSONValue] { history.take(owner: a, handle: "app", observations: ["10": observed]) }
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
    #expect(history.take(owner: a, handle: "other", observations: ["10": observed]).isEmpty)
    #expect(history.take(owner: a, handle: "app", observations: ["11": observed]).isEmpty)
    #expect(take() == [
        .object(["source": .string("agent"), "windowId": .string("10"), "ageSeconds": .number(2)]),
        .object(["source": .string("external-input"), "windowId": .string("10"), "ageSeconds": .number(1)]),
    ])
    #expect(!history.hasInterests)
    history.record(target, owner: b)
    #expect(take().isEmpty)
    time += 1
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
    var observed: UInt64 = 0
    func observe() { observed = history.observe(target, handle: "app", owner: owner) }
    func take() -> [JSONValue] { history.take(owner: owner, handle: "app", observations: ["10": observed]) }
    observe()
    time += 1
    history.record(target, owner: other)
    // A native capture that the Host could not deliver keeps the previous receipt valid.
    let pending = history.observe(target, handle: "app", owner: owner)
    #expect(history.take(owner: owner, handle: "app", observations: ["10": observed]).count == 1)
    time += 1
    observe()
    #expect(observed > pending)
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
    var time = second
    let history = RecentActivity(now: { time }, uptime: { time })
    let target = ActivityTarget(process: try NativePlatform.identity(getpid()), windowID: 10)
    history.connect(owner, lookbackMs: 60_000)
    let observed = history.observe(target, handle: "app", owner: owner)
    let monitor = ExternalInputMonitor(activity: history, ownerOfWindow: { $0 == 10 ? getpid() : nil })
    let event = try #require(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: .zero, mouseButton: .left))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(getpid()))
    time += second
    event.timestamp = time
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: 10)
    event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(getpid()))
    monitor.receive(.leftMouseDown, event: event)
    event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    monitor.receive(.keyDown, event: event)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: 0)
    monitor.receive(.scrollWheel, event: event)
    #expect(history.take(owner: owner, handle: "app", observations: ["10": observed]).isEmpty)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: 10)
    monitor.receive(.leftMouseDown, event: event)
    #expect(history.take(owner: owner, handle: "app", observations: ["10": observed]) == [
        .object(["source": .string("external-input"), "windowId": .string("10"), "ageSeconds": .number(0)]),
    ])
}

@Test @MainActor func elapsedTimeIncludesSleepAfterExternalInput() {
    var awake = second
    var continuous = 5 * second
    let history = RecentActivity(now: { continuous }, uptime: { awake })
    let owner = UUID()
    history.connect(owner, lookbackMs: 60_000)
    let observed = history.observe(target, handle: "app", owner: owner)
    awake += second
    continuous += second
    history.recordExternal(target, eventUptime: awake)
    continuous += 3_600 * second
    #expect(history.take(owner: owner, handle: "app", observations: ["10": observed]).isEmpty)
}

@Test @MainActor func capturesInputDuringWindowReadsAndRollsBackFailedInterests() async throws {
    var time = second
    let history = RecentActivity(now: { time })
    let owner = UUID()
    history.connect(owner, lookbackMs: 60_000)
    func read() async throws -> UInt64 {
        let result = try await history.withObservation(target, handle: "app", owner: owner) {
            time += second
            history.record(target, owner: nil)
            time += second
            return .object([:])
        }
        let stamp = try #require(result["activityObservedAt"].string)
        return try #require(UInt64(stamp))
    }
    func fail() async throws {
        _ = try await history.withObservation(target, handle: "app", owner: owner) {
            time += second
            history.record(target, owner: nil)
            throw CancellationError()
        }
    }
    func take(_ receipt: UInt64) -> [JSONValue] {
        history.take(owner: owner, handle: "app", observations: ["10": receipt])
    }
    await #expect(throws: CancellationError.self) { try await fail() }
    #expect(!history.hasInterests)
    let first = try await read()
    #expect(take(first) == [.object(["windowId": .string("10"), "source": .string("external-input"), "ageSeconds": .number(1)])])
    await #expect(throws: CancellationError.self) { try await fail() }
    #expect(!history.hasInterests)
    time += second
    let next = try await read()
    await #expect(throws: CancellationError.self) { try await fail() }
    #expect(take(next) == [.object(["windowId": .string("10"), "source": .string("external-input"), "ageSeconds": .number(0)])])
}
