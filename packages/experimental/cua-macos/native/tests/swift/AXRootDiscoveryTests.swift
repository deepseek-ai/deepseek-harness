// Scope discovery must not report an unreadable nested sheet as an absent AX surface.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

private func discoveryWithInvalidChild() throws -> AXRootDiscovery {
    let parent = AXUIElementCreateApplication(1)
    let sheet = AXUIElementCreateApplication(2)
    return try AXRootDiscovery.discover(roots: [parent], maxElements: 20, role: { element in
        if CFEqual(element, sheet) {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility read AXRole failed with error -25202", accessibilityError: AXError.invalidUIElement.rawValue)
        }
        return "AXWindow"
    }, children: { _ in [sheet] })
}

@Test func unreadableNestedSheetDoesNotBecomeAnEmptyCompleteObservation() throws {
    let discovery = try discoveryWithInvalidChild()
    #expect(discovery.roots.count == 1)
    let requestedSheet = AXUIElementCreateApplication(2)
    let hasMatch = discovery.roots.contains { CFEqual($0, requestedSheet) }
    var ownershipChecked = false
    do {
        try discovery.validateWindowSelection(hasMatch: hasMatch) { ownershipChecked = true }
        Issue.record("Unresolved sheet accepted as an absent AX surface")
    } catch let failure as NativeFailure {
        #expect(ownershipChecked)
        #expect(failure.accessibilityError == AXError.invalidUIElement.rawValue)
        let observation = AXWorker.observationFailure(failure)
        #expect(observation.code == "AX_OBSERVATION_UNAVAILABLE")
        #expect(observation.message.contains("read AXRole"))
    }
}

@Test func matchedWindowRemainsUsableAfterAnUnrelatedChildFailsDiscovery() throws {
    let discovery = try discoveryWithInvalidChild()
    let requestedParent = AXUIElementCreateApplication(1)
    let hasMatch = discovery.roots.contains { CFEqual($0, requestedParent) }
    try discovery.validateWindowSelection(hasMatch: hasMatch) {
        Issue.record("Matched windows do not use the missing-surface ownership check")
    }
}

@Test func sheetDiscoveryContinuesAfterAnInvalidSibling() throws {
    let nodes = (1...3).map { AXUIElementCreateApplication(Int32($0)) }
    let discovery = try AXRootDiscovery.discover(roots: [nodes[0]], maxElements: 20, role: { element in
        if CFEqual(element, nodes[1]) {
            throw NativeFailure(code: "NATIVE_ERROR", message: "read AXRole", accessibilityError: AXError.invalidUIElement.rawValue)
        }
        return CFEqual(element, nodes[0]) ? "AXWindow" : "AXSheet"
    }, children: { element in CFEqual(element, nodes[0]) ? [nodes[1], nodes[2]] : [] })
    #expect(discovery.roots.count == 2)
    #expect(CFEqual(discovery.roots[1], nodes[2]))
    let hasMatch = discovery.roots.contains { CFEqual($0, nodes[2]) }
    try discovery.validateWindowSelection(hasMatch: hasMatch) {}
}

@Test func successfulDiscoveryStillAllowsAnOwnedWindowWithoutAnAXSurface() throws {
    let parent = AXUIElementCreateApplication(1)
    let discovery = try AXRootDiscovery.discover(roots: [parent], maxElements: 20,
        role: { _ in "AXWindow" }, children: { _ in [] })
    var ownershipChecked = false
    try discovery.validateWindowSelection(hasMatch: false) { ownershipChecked = true }
    #expect(ownershipChecked)
}

@Test func ownershipFailureTakesPriorityOverAnUnresolvedAXChild() throws {
    let discovery = try discoveryWithInvalidChild()
    do {
        try discovery.validateWindowSelection(hasMatch: false) {
            throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Window is no longer owned")
        }
        Issue.record("Unowned window accepted")
    } catch let failure as NativeFailure {
        #expect(failure.code == "WINDOW_UNAVAILABLE")
    }
}

@Test(arguments: [AXError.apiDisabled, .cannotComplete, .failure, .illegalArgument])
func sheetDiscoveryPropagatesOtherChildReadFailures(error: AXError) throws {
    let nodes = (1...2).map { AXUIElementCreateApplication(Int32($0)) }
    do {
        _ = try AXRootDiscovery.discover(roots: [nodes[0]], maxElements: 20, role: { element in
            if CFEqual(element, nodes[1]) {
                throw NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
                    message: "original child role operation", accessibilityError: error.rawValue)
            }
            return "AXWindow"
        }, children: { _ in [nodes[1]] })
        Issue.record("Unrecoverable child discovery failure was hidden")
    } catch let failure as NativeFailure {
        #expect(failure.accessibilityError == error.rawValue)
        #expect(failure.message == "original child role operation")
    }
}

@Test(arguments: [AXError.invalidUIElement, .cannotComplete])
func laterDiscoveryFailuresDoNotEraseOrHideEarlierEvidence(later: AXError) throws {
    let nodes = (1...3).map { AXUIElementCreateApplication(Int32($0)) }
    do {
        let discovery = try AXRootDiscovery.discover(roots: [nodes[0]], maxElements: 20, role: { element in
            if CFEqual(element, nodes[0]) { return "AXWindow" }
            let first = CFEqual(element, nodes[1])
            let error = first ? AXError.invalidUIElement : later
            throw NativeFailure(code: "NATIVE_ERROR", message: first ? "first child" : "second child", accessibilityError: error.rawValue)
        }, children: { _ in [nodes[1], nodes[2]] })
        try discovery.validateWindowSelection(hasMatch: false) {}
        Issue.record("Discovery failure accepted as an absent surface")
    } catch let failure as NativeFailure {
        #expect(failure.message == (later == .invalidUIElement ? "first child" : "second child"))
        #expect(failure.accessibilityError == later.rawValue)
    }
}

@Test func sheetDiscoveryPreservesDeduplicationAndElementLimits() throws {
    let nodes = (1...3).map { AXUIElementCreateApplication(Int32($0)) }
    let discovery = try AXRootDiscovery.discover(roots: [nodes[0]], maxElements: 2,
        role: { _ in "AXSheet" }, children: { _ in nodes })
    #expect(discovery.roots.count == 2)
    #expect(CFEqual(discovery.roots[0], nodes[0]))
    #expect(CFEqual(discovery.roots[1], nodes[1]))
}
