// Window interests and input metadata belong to the observing helper connection for one turn.
import Foundation
import Darwin

struct ActivityTarget: Hashable, Sendable {
    let process: ProcessIdentity
    let windowID: UInt32
}

@MainActor final class RecentActivity {
    private struct Observation {
        let handle: String
        var since: UInt64
        var lastReport: UInt64?
        var lastOwnUse: UInt64?
        var armed = true
        // Keep only the latest timestamp per source for the window activity notice.
        var events: [String: UInt64] = [:]
    }
    private struct Client {
        let lookback: UInt64
        var windows: [ActivityTarget: Observation] = [:]
    }
    private var clients: [UUID: Client] = [:]
    private let now: () -> UInt64
    private let uptime: () -> UInt64

    init(now: @escaping () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) },
         uptime: @escaping () -> UInt64 = { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }) {
        self.now = now
        self.uptime = uptime
    }
    /// Quartz timestamps exclude sleep. Preserve their delivery delay on the clock used for expiry.
    func recordExternal(_ target: ActivityTarget, eventUptime: UInt64) {
        let awake = uptime()
        let current = now()
        guard awake >= eventUptime, current >= awake - eventUptime else { return }
        record(target, owner: nil, at: current - (awake - eventUptime))
    }
    func connect(_ owner: UUID, lookbackMs: Int) { clients[owner] = Client(lookback: UInt64(lookbackMs) * 1_000_000) }
    var hasInterests: Bool { clients.values.contains { $0.windows.values.contains(where: \.armed) } }
    func disconnect(_ owner: UUID) { clients.removeValue(forKey: owner) }
    func clear(_ owner: UUID) { clients[owner]?.windows.removeAll() }
    /// Arm before sampling the window so input during a slow read can invalidate its result.
    @discardableResult func observe(_ target: ActivityTarget, handle: String, owner: UUID) -> UInt64 {
        let time = now()
        if var window = clients[owner]?.windows[target] {
            if !window.armed { window.since = time; window.armed = true }
            clients[owner]?.windows[target] = window
        } else {
            clients[owner]?.windows[target] = Observation(handle: handle, since: time)
        }
        return time
    }
    /// Keep the previous delivered observation eligible when a refresh fails.
    func withObservation(_ target: ActivityTarget, handle: String, owner: UUID,
                         read: @MainActor () async throws -> JSONValue) async throws -> JSONValue {
        let previous = clients[owner]?.windows[target]
        let start = observe(target, handle: handle, owner: owner)
        do {
            guard var fields = try await read().object else {
                throw NativeFailure(code: "NATIVE_PROTOCOL", message: "Expected a window observation")
            }
            fields["activityObservedAt"] = .string(String(start))
            return .object(fields)
        } catch {
            if previous?.armed != true { clients[owner]?.windows[target] = previous }
            throw error
        }
    }
    func isTracked(_ process: ProcessIdentity) -> Bool {
        clients.values.contains { $0.windows.contains { $0.key.process == process && $0.value.armed } }
    }
    func record(_ target: ActivityTarget, owner: UUID?, at time: UInt64? = nil) {
        let time = time ?? now()
        let source = owner == nil ? "external-input" : "agent"
        for id in clients.keys {
            guard let window = clients[id]?.windows[target] else { continue }
            if id == owner {
                clients[id]?.windows[target]?.lastOwnUse = time
                if !window.armed {
                    clients[id]?.windows[target]?.since = time
                    clients[id]?.windows[target]?.armed = true
                }
            } else if window.armed && time > window.since && time >= (window.events[source] ?? 0) {
                clients[id]?.windows[target]?.events[source] = time
            }
        }
    }
    /// Poll only windows observed on this connection under the authorized application handle.
    func take(owner: UUID, handle: String, observations: [String: UInt64]) -> [JSONValue] {
        guard let client = clients[owner] else { return [] }
        let time = now()
        var rows: [JSONValue] = []
        for (target, window) in client.windows.sorted(by: { $0.key.windowID < $1.key.windowID }) {
            guard window.armed, window.handle == handle, let observedAt = observations[String(target.windowID)] else { continue }
            if let reported = window.lastReport, max(observedAt, window.lastOwnUse ?? 0) <= reported {
                clients[owner]?.windows[target]?.armed = false
                clients[owner]?.windows[target]?.events.removeAll()
                continue
            }
            for source in ["agent", "external-input"] {
                guard let input = window.events[source], input > observedAt, time >= input, time - input <= client.lookback else { continue }
                rows.append(.object(["windowId": .string(String(target.windowID)), "source": .string(source),
                                     "ageSeconds": .number(Double((time - input) / 1_000_000_000))]))
                clients[owner]?.windows[target]?.lastReport = time
                clients[owner]?.windows[target]?.armed = false
            }
            clients[owner]?.windows[target]?.events.removeAll()
        }
        return rows
    }
}
