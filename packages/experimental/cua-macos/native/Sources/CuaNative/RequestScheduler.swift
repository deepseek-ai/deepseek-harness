// Desktop operations hold one process-wide slot; socket writes do not hold it.
import Foundation
import Dispatch

@MainActor final class RequestScheduler {
    private struct Waiting {
        let id: UUID
        let continuation: CheckedContinuation<Void, any Error>
    }
    private var owner: UUID?
    private var waiting: [Waiting] = []

    func perform(cancellation: CancellationLatch,
                 operation: @MainActor () async throws -> JSONValue) async throws -> JSONValue {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if cancellation.isCancelled || Task.isCancelled {
                    continuation.resume(throwing: NativeFailure(code: "NATIVE_CANCELLED", message: "Queued operation cancelled"))
                } else if owner == nil {
                    owner = id
                    continuation.resume()
                } else {
                    waiting.append(Waiting(id: id, continuation: continuation))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id) }
        }
        defer { release(id) }
        try cancellation.check()
        return try await operation()
    }

    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(throwing: NativeFailure(code: "NATIVE_CANCELLED", message: "Queued operation cancelled"))
    }

    private func release(_ id: UUID) {
        precondition(owner == id)
        if waiting.isEmpty { owner = nil }
        else {
            let next = waiting.removeFirst()
            owner = next.id
            next.continuation.resume()
        }
    }
}

final class NativeDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = true

    init(seconds: Double, expired: @escaping @Sendable () -> Void) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + seconds) { [self] in
            if take() { expired() }
        }
    }
    func cancel() { _ = take() }
    private func take() -> Bool {
        lock.withLock {
            guard pending else { return false }
            pending = false
            return true
        }
    }
}

final class NativeRequestControl: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var reason: NativeFailure?
    private var operationStarted = false
    private var operationDone = false
    private var completed = false

    var failure: NativeFailure? { lock.withLock { reason } }
    func attach(_ task: Task<Void, Never>) {
        let cancel = lock.withLock { self.task = task; return reason != nil }
        if cancel { task.cancel() }
    }
    func finishOperation() { lock.withLock { operationDone = true } }
    func startOperation() { lock.withLock { operationStarted = true } }
    func finish() { lock.withLock { completed = true; task = nil } }

    func cancel(_ failure: NativeFailure, grace: Double, axTimeout: Double,
                unresponsive: @escaping @Sendable () -> Void, blockedReply: @escaping @Sendable () -> Void) {
        let cancellation: (Bool, Task<Void, Never>?) = lock.withLock {
            guard !completed, reason == nil else { return (false, nil) }
            reason = failure
            return (true, task)
        }
        guard cancellation.0 else { return }
        cancellation.1?.cancel()
        _ = NativeDeadline(seconds: grace) { [self] in
            let state = lock.withLock { (completed, operationStarted, operationDone) }
            if !state.0 && (!state.1 || state.2) { blockedReply() }
        }
        _ = NativeDeadline(seconds: axTimeout + grace) { [self] in
            let state = lock.withLock { (completed, operationStarted, operationDone) }
            guard !state.0 else { return }
            if state.1 && !state.2 { unresponsive() }
            else { blockedReply() }
        }
    }
}
