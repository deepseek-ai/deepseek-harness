// Shared recent input history; records describe attempts, never exclusive ownership or verified effects.
import Foundation
import Dispatch

struct ActivityTarget: Hashable, Sendable {
    let process: ProcessIdentity
    let windowID: UInt32?
}

@MainActor final class RecentActivity {
    private struct Record {
        let target: ActivityTarget
        let owner: UUID?
        let operation: String
        let time: Double
    }
    private struct Client {
        let lookback: Double
        var processes: Set<ProcessIdentity> = []
    }
    private var clients: [UUID: Client] = [:]
    private var records: [Record] = []
    private let now: () -> Double

    init(now: @escaping () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000 }) {
        self.now = now
    }
    func connect(_ owner: UUID, lookback: Double) { clients[owner] = Client(lookback: lookback) }
    func disconnect(_ owner: UUID) { clients.removeValue(forKey: owner); prune() }
    func watch(_ target: ActivityTarget, owner: UUID) { clients[owner]?.processes.insert(target.process) }
    func trackedProcess(_ pid: Int32) -> ProcessIdentity? {
        clients.values.lazy.flatMap(\.processes).first { $0.pid == pid }
    }
    func record(_ target: ActivityTarget, owner: UUID?, operation: String) {
        prune()
        guard clients.values.contains(where: { $0.processes.contains(target.process) }) else { return }
        records.removeAll { $0.target == target && $0.owner == owner }
        records.append(Record(target: target, owner: owner, operation: operation, time: now()))
    }
    func report(_ target: ActivityTarget, owner: UUID, monitoring: String) -> JSONValue {
        prune()
        guard let client = clients[owner] else { return .null }
        let timestamp = now()
        let matching = records.filter {
            $0.owner != owner && $0.target.process == target.process &&
                (target.windowID == nil || $0.target.windowID == nil || $0.target.windowID == target.windowID) &&
                timestamp - $0.time <= client.lookback
        }
        // One latest record per source bounds model output independently of input frequency.
        let recent = [matching.last { $0.owner != nil }, matching.last { $0.owner == nil }].compactMap { $0 }
        return .object([
            "lookbackMs": .number(client.lookback * 1000),
            "externalInputMonitoring": .string(monitoring),
            "events": .array(recent.map { record in .object([
                "source": .string(record.owner == nil ? "external-input" : "other-agent"),
                "windowId": record.target.windowID.map { .number(Double($0)) } ?? .null,
                "ageMs": .number(max(0, (timestamp - record.time) * 1000).rounded(.down)),
                "operation": .string(record.operation),
            ]) }),
        ])
    }
    private func prune() {
        let cutoff = now() - (clients.values.map(\.lookback).max() ?? 0)
        let processes = Set(clients.values.flatMap(\.processes))
        records.removeAll { $0.time < cutoff || !processes.contains($0.target.process) }
    }
}
