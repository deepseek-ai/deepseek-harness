// Record button transitions without posting input or requiring desktop permissions.
import Testing
@testable import CuaNative

@Test @MainActor func completedClickReleasesExactlyOnce() async throws {
    var events: [String] = []
    try await WindowPointerInput.postPair(downInterval: .zero, checkCancellation: {},
        down: { events.append("down") }, up: { events.append("up") })
    #expect(events == ["down", "up"])
}

@Test @MainActor func cancelledHeldClickReleasesExactlyOnce() async throws {
    var events: [String] = []
    let (pressed, signal) = AsyncStream<Void>.makeStream()
    let operation = Task { @MainActor in
        defer { signal.finish() }
        try await WindowPointerInput.postPair(downInterval: .seconds(60), checkCancellation: { try Task.checkCancellation() },
            down: { events.append("down"); signal.yield(()) }, up: { events.append("up") })
    }
    var iterator = pressed.makeAsyncIterator()
    let observed = await iterator.next()
    operation.cancel()
    let result = await operation.result
    #expect(observed != nil)
    if case .failure(let error) = result { #expect(error is CancellationError) }
    else { Issue.record("Cancelled click completed successfully") }
    #expect(events == ["down", "up"])
}

@Test @MainActor func cancellationBeforeClickDoesNotPostInput() async {
    var events: [String] = []
    do {
        try await WindowPointerInput.postPair(downInterval: .zero, checkCancellation: { throw CancellationError() },
            down: { events.append("down") }, up: { events.append("up") })
        Issue.record("Cancelled click was admitted")
    } catch { #expect(error is CancellationError) }
    #expect(events.isEmpty)
}
