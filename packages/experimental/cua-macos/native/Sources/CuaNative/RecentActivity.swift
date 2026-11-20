// Shared input history with per-connection delivery cursors; operations never acquire a reservation.
import Foundation
import Dispatch

struct ActivityTarget: Hashable, Sendable {
    let process: ProcessIdentity
    let windowID: UInt32?
}

@MainActor final class RecentActivity {
    private struct Record {
        let sequence: UInt64
        let target: ActivityTarget
        let owner: UUID?
        let operation: String
        let time: Double
    }
    private struct Client {
        let lookbackMs: Int
        var processes: Set<ProcessIdentity> = []
        var delivered: Set<UInt64> = []
        var monitoring: String?
    }
    private var clients: [UUID: Client] = [:]
    private var records: [Record] = []
    private var sequence: UInt64 = 0
    private let now: () -> Double

    init(now: @escaping () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000 }) {
        self.now = now
    }
    func connect(_ owner: UUID, lookbackMs: Int) { clients[owner] = Client(lookbackMs: lookbackMs) }
    var hasEnabledClients: Bool { !clients.isEmpty }
    func disconnect(_ owner: UUID) { clients.removeValue(forKey: owner); prune() }
    func watch(_ target: ActivityTarget, owner: UUID) { clients[owner]?.processes.insert(target.process) }
    func isTracked(_ process: ProcessIdentity) -> Bool {
        clients.values.contains { $0.processes.contains(process) }
    }
    func record(_ target: ActivityTarget, owner: UUID?, operation: String) {
        prune()
        guard isTracked(target.process) else { return }
        sequence += 1
        records.removeAll { $0.target == target && $0.owner == owner }
        records.append(Record(sequence: sequence, target: target, owner: owner, operation: operation, time: now()))
    }
    /// Nil means this connection has no new activity or monitoring transition to report.
    func report(_ target: ActivityTarget, owner: UUID, monitoring: String) -> JSONValue? {
        prune()
        guard let client = clients[owner] else { preconditionFailure("Activity reports require a connected client") }
        let timestamp = now()
        let matching = records.filter {
            $0.owner != owner && $0.target.process == target.process &&
                (target.windowID == nil || $0.target.windowID == nil || $0.target.windowID == target.windowID) &&
                timestamp - $0.time <= Double(client.lookbackMs) / 1000
        }
        // Pick the latest matching event before filtering delivery, so old events do not trickle out on repeated reads.
        let recent = [matching.last { $0.owner != nil }, matching.last { $0.owner == nil }]
            .compactMap { $0 }.filter { !client.delivered.contains($0.sequence) }
        let changed = client.monitoring != monitoring && (client.monitoring != nil || monitoring != "listening")
        clients[owner]?.monitoring = monitoring
        clients[owner]?.delivered.formUnion(recent.map(\.sequence))
        guard !recent.isEmpty || changed else { return nil }
        return .object([
            "lookbackMs": .number(Double(client.lookbackMs)),
            "externalInputMonitoring": .string(monitoring),
            "events": .array(recent.map { record in .object([
                "source": .string(record.owner == nil ? "external-input" : "agent"),
                "windowId": record.target.windowID.map { .string(String($0)) } ?? .null,
                "ageMs": .number(max(0, (timestamp - record.time) * 1000).rounded(.down)),
                "operation": .string(record.operation),
            ]) }),
        ])
    }
    private func prune() {
        let cutoff = now() - Double(clients.values.map(\.lookbackMs).max() ?? 0) / 1000
        let processes = Set(clients.values.flatMap(\.processes))
        records.removeAll { $0.time < cutoff || !processes.contains($0.target.process) }
        let retained = Set(records.map(\.sequence))
        for owner in clients.keys { clients[owner]?.delivered.formIntersection(retained) }
    }
}
