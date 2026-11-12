// Synthetic AX references distinguish siblings without access to a desktop process.
import ApplicationServices
import Testing
@testable import CuaNative

@Test func aFailingChildPreservesReadableSiblingsInOrder() {
    let nodes = (1...32).map { AXUIElementCreateApplication(Int32($0)) }
    var requests = 32
    let children = AXObservedChildren.readRanges(count: nodes.count, limit: nodes.count, requests: &requests) { range in
        range.contains(17) ? .unreadable : .values(Array(nodes[range]))
    }
    #expect(children.incomplete)
    var expected = nodes.map(Optional.some)
    expected[17] = nil
    #expect(children.entries == expected)
    #expect(requests > 0)
}

@Test func recoveryHonorsBothTheRequestAndElementLimits() {
    let node = AXUIElementCreateApplication(1)
    var requests = 3
    let limited = AXObservedChildren.readRanges(count: Int.max, limit: 4, requests: &requests) { range in
        #expect(range.upperBound <= 4)
        return range.upperBound > 2 ? .unreadable : .values(Array(repeating: node, count: range.count))
    }
    #expect(limited.entries == [node, node])
    #expect(limited.incomplete)
    #expect(requests == 0)

    let exhausted = AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { _ in
        Issue.record("Recovery called AX after exhausting the observation budget")
        return .unreadable
    }
    #expect(exhausted.entries.isEmpty)
    #expect(exhausted.incomplete)
}

@Test func aChangedRangeRetainsReadableReferencesAndOtherErrorsPropagate() {
    let node = AXUIElementCreateApplication(1)
    var requests = 10
    let changed = AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { range in
        if range.count == 2 { return .unreadable }
        return range.lowerBound == 0 ? .values([node]) : .unavailable
    }
    #expect(changed.incomplete)
    #expect(changed.entries == [node])
    #expect(changed.parentIncomplete)
    #expect(throws: CancellationError.self) {
        try AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { _ in throw CancellationError() }
    }
}

@Test func completeRangeRecoveryPublishesACompleteObservation() {
    let node = AXUIElementCreateApplication(1)
    var requests = 1
    let recovered = AXObservedChildren.readRanges(count: 1, limit: 1, requests: &requests) { _ in .values([node]) }
    #expect(recovered.entries == [node])
    #expect(!recovered.incomplete)
}
