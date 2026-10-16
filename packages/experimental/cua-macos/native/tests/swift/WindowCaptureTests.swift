// A cancelled caller releases desktop scheduling without creating another outstanding SDK capture.
import Foundation
import Testing
@testable import CuaNative

private final class HeldCapture: @unchecked Sendable {
    typealias Completion = @Sendable (Result<CapturedPNG, NativeFailure>) -> Void
    private let lock = NSLock()
    private var callbacks: [Completion?] = []
    let starts: AsyncStream<Int>.Continuation

    init(starts: AsyncStream<Int>.Continuation) { self.starts = starts }
    var count: Int { lock.withLock { callbacks.count } }
    func begin(_ completion: @escaping Completion) {
        let count = lock.withLock { callbacks.append(completion); return callbacks.count }
        starts.yield(count)
    }
    func finish(_ index: Int, width: Int) throws {
        let callback = try #require(lock.withLock {
            let callback = callbacks[index]
            callbacks[index] = nil
            return callback
        })
        callback(.success(CapturedPNG(bytes: Data([1, 2, 3]), width: width, height: 1)))
    }
}

@MainActor @Test(.timeLimit(.minutes(1))) func captureCancellationKeepsOneOutstandingRPCAndLeavesAXAvailable() async throws {
    let (events, starts) = AsyncStream<Int>.makeStream()
    let source = HeldCapture(starts: starts)
    let capture = WindowCapture { _, _, _, _, finish in source.begin(finish) }
    let scheduler = RequestScheduler()
    let cancellation = CancellationLatch()
    let worker = AXWorker(cancellation: cancellation, axTimeout: 1, textEventInterval: 0)
    let target = CaptureTarget(appHandle: "fixture", process: ProcessIdentity(pid: 1, startedSeconds: 1, startedMicroseconds: 0),
        window: WindowInfo(windowID: 1, pid: 1, appName: "fixture", title: "fixture",
                           bounds: WindowBounds(x: 0, y: 0, width: 1, height: 1), isOnScreen: true, onCurrentSpace: true))
    func request() -> Task<JSONValue, any Error> {
        Task {
            try await scheduler.perform(cancellation: cancellation) {
                let image = try await capture.capture(target, cancellation: cancellation)
                return .number(Double(image.width))
            }
        }
    }
    var observed = events.makeAsyncIterator()
    let first = request()
    #expect(await observed.next() == 1)
    first.cancel()
    do {
        _ = try await first.value
        Issue.record("Cancelled capture unexpectedly returned its pending image")
    } catch let failure as NativeFailure { #expect(failure.code == "NATIVE_CANCELLED") }
    #expect(!cancellation.isCancelled)
    do {
        _ = try await request().value
        Issue.record("Second capture started before the first SDK callback")
    } catch let failure as NativeFailure { #expect(failure.code == "CAPTURE_BUSY") }
    #expect(source.count == 1)

    let axAvailable = try await scheduler.perform(cancellation: cancellation) {
        do {
            _ = try await worker.validateIdentity("missing")
            Issue.record("Missing AX handle was accepted")
            return JSONValue.bool(false)
        } catch let failure as NativeFailure {
            #expect(failure.code == "STALE_APP")
            return .bool(true)
        }
    }
    #expect(axAvailable == .bool(true))
    try source.finish(0, width: 2)
    let next = request()
    #expect(await observed.next() == 2)
    try source.finish(1, width: 7)
    #expect(try await next.value == .number(7))
    #expect(source.count == 2)
    await worker.shutdown()
    starts.finish()
}
