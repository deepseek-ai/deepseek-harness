// Synthetic AX references distinguish siblings without access to a desktop process.
import ApplicationServices
import Testing
@testable import CuaNative

@Suite struct AXObservedChildrenTests {
    @Test func aFailingChildPreservesReadableSiblingsInOrder() {
        let nodes = (1...32).map { AXUIElementCreateApplication(Int32($0)) }
        var requests = 32
        let children = AXObservedChildren.readRanges(count: nodes.count, limit: nodes.count, requests: &requests) { range in
            range.contains(17) ? .unreadable : .values(Array(nodes[range]))
        }
        #expect(children.hasUnreadableElements)
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
        #expect(limited.hasUnreadableElements)
        #expect(requests == 0)

        let exhausted = AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { _ in
            Issue.record("Recovery called AX after exhausting the observation budget")
            return .unreadable
        }
        #expect(exhausted.entries.isEmpty)
        #expect(exhausted.hasUnreadableElements)
    }

    @Test func aChangedRangeRetainsReadableReferencesAndOtherErrorsPropagate() {
        let node = AXUIElementCreateApplication(1)
        var requests = 10
        let changed = AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { range in
            if range.count == 2 { return .unreadable }
            return range.lowerBound == 0 ? .values([node]) : .positionsUnknown
        }
        #expect(changed.hasUnreadableElements)
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
        #expect(!recovered.hasUnreadableElements)
    }

    @Test(arguments: [1, 5, 6])
    func failingListsUpToFiveReadIndividualItemsAndLongerListsSplitFirst(count: Int) {
        let element = AXUIElementCreateApplication(1)
        let failed = count - 1
        var ranges: [Range<Int>] = []
        var requests = 20
        let result = AXObservedChildren.readRanges(count: count, limit: count, requests: &requests) { range in
            ranges.append(range)
            return range.contains(failed) ? .unreadable : .values(Array(repeating: element, count: range.count))
        }
        let expected = count <= 5 ? (0..<count).map { $0..<($0 + 1) } : [0..<3, 3..<6, 3..<4, 4..<5, 5..<6]
        #expect(ranges == expected)
        #expect(result.entries == Array(repeating: Optional(element), count: failed) + [nil])
        #expect(!result.parentIncomplete)
    }

    @Test func zeroChildrenAndAnEntirelyReadablePrefixDistinguishLimitsFromMissingValues() {
        let node = AXUIElementCreateApplication(1)
        var requests = 3
        let empty = AXObservedChildren.readRanges(count: 0, limit: 1, requests: &requests) { _ in
            Issue.record("An empty list has no ranges")
            return .unreadable
        }
        #expect(!empty.hasUnreadableElements && !empty.elementLimitReached)
        for limit in [0, 1] {
            let limited = AXObservedChildren.readRanges(count: 3, limit: limit, requests: &requests) { range in
                #expect(range == 0..<1)
                return .values([node])
            }
            #expect(limited.elementLimitReached && !limited.hasUnreadableElements)
            #expect(limited.entries.count == limit)
        }
        #expect(requests == 2)
    }

    @Test func onlyAChildrenFailureCanReuseDiscovery() throws {
        let ref = AXUIElementCreateApplication(24)
        let equivalent = AXUIElementCreateApplication(24)
        let retained = [ref: AXObservedChildren(entries: [nil, ref])]
        func prior() throws -> AXObservedChildren { try #require(retained[equivalent]) }
        func failure(_ name: String, _ code: AXError) -> NativeFailure {
            NativeFailure(code: "NATIVE_ERROR", message: name, accessibilityError: code.rawValue, attribute: name)
        }
        let fresh = try AXObservedChildren.observing({ [ref] }, recover: prior)
        #expect(!fresh.hasUnreadableElements)
        let repeated = try AXObservedChildren.observing({ throw failure("AXChildren", .failure) }, recover: prior)
        #expect(repeated.entries == [nil, ref])
        for (name, code) in [("AXRole", AXError.failure), ("AXChildren", .invalidUIElement),
                             ("AXChildren", .cannotComplete), ("AXChildren", .apiDisabled)] {
            do {
                _ = try AXObservedChildren.observing({ throw failure(name, code) }, recover: prior)
                Issue.record("A current AX failure was hidden by window discovery")
            } catch let error as NativeFailure {
                #expect(error.attribute == name && error.accessibilityError == code.rawValue)
            }
        }
    }

    @Test func onlyASuccessfulCountCanConfirmAnEmptyChildList() throws {
        let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
        #expect(try access.recoveryChildCount(0, error: .success) == 0)
        for error in [AXError.failure, .attributeUnsupported, .noValue, .notImplemented, .illegalArgument] {
            #expect(try access.recoveryChildCount(0, error: error) == nil)
        }
        for error in [AXError.cannotComplete, .invalidUIElement, .apiDisabled] {
            do {
                _ = try access.recoveryChildCount(0, error: error)
                Issue.record("An AX failure was interpreted as a child count")
            } catch let failure as NativeFailure {
                #expect(failure.accessibilityError == error.rawValue)
            }
        }
    }
}
