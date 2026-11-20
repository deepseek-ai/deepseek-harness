// Window interests and input metadata belong to the observing helper connection for one turn.
import Foundation
import Dispatch

struct ActivityTarget: Hashable, Sendable {
    let process: ProcessIdentity
    let windowID: UInt32
}

@MainActor final class RecentActivity {
    private struct Observation {
        let handle: String
        let since: UInt64
        var armed = true
        var events: [String: UInt64] = [:]
    }
    private struct Client {
        let lookback: UInt64
        var windows: [ActivityTarget: Observation] = [:]
    }
    private var clients: [UUID: Client] = [:]
    private let now: () -> UInt64

    init(now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) { self.now = now }
    func connect(_ owner: UUID, lookbackMs: Int) { clients[owner] = Client(lookback: UInt64(lookbackMs) * 1_000_000) }
    var hasInterests: Bool { clients.values.contains { $0.windows.values.contains(where: \.armed) } }
    func disconnect(_ owner: UUID) { clients.removeValue(forKey: owner) }
    func clear(_ owner: UUID) { clients[owner]?.windows.removeAll() }
    func observe(_ target: ActivityTarget, handle: String, owner: UUID) {
        clients[owner]?.windows[target] = Observation(handle: handle, since: now())
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
                if !window.armed { clients[id]?.windows[target] = Observation(handle: window.handle, since: time) }
            } else if window.armed && time > window.since && time >= (window.events[source] ?? 0) {
                clients[id]?.windows[target]?.events[source] = time
            }
        }
    }
    /// Poll only windows observed on this connection under the authorized application handle.
    func take(owner: UUID, handle: String, windowIDs: [String]) -> [JSONValue] {
        guard let client = clients[owner] else { return [] }
        let ids = Set(windowIDs)
        let time = now()
        var rows: [JSONValue] = []
        for (target, window) in client.windows.sorted(by: { $0.key.windowID < $1.key.windowID }) {
            guard window.armed, window.handle == handle, ids.contains(String(target.windowID)) else { continue }
            for source in ["agent", "external-input"] {
                guard let input = window.events[source], time >= input, time - input <= client.lookback else { continue }
                rows.append(.object(["windowId": .string(String(target.windowID)), "source": .string(source),
                                     "ageSeconds": .number(Double((time - input) / 1_000_000_000))]))
                clients[owner]?.windows[target]?.armed = false
            }
            clients[owner]?.windows[target]?.events.removeAll()
        }
        return rows
    }
}
