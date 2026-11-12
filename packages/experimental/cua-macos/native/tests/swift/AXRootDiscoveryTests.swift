// Scope discovery must not report an unreadable nested sheet as an absent AX surface.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

@Test(arguments: ["AXRole", "AXChildren"])
func invalidRootDoesNotHideHealthyWindowDuringDiscovery(attribute: String) throws {
    let invalid = AXUIElementCreateApplication(1), healthy = AXUIElementCreateApplication(2)
    let failure = NativeFailure(code: "NATIVE_ERROR", message: "read \(attribute)", accessibilityError: AXError.invalidUIElement.rawValue)
    var discovery = try AXRootDiscovery.discover(roots: [invalid, healthy], maxElements: 20, role: { element in
        if attribute == "AXRole", CFEqual(element, invalid) { throw failure }
        return "AXWindow"
    }, children: { element in
        if attribute == "AXChildren", CFEqual(element, invalid) { throw failure }
        return []
    })
    #expect(discovery.roots.count == 2)
    #expect(CFEqual(discovery.roots[0], invalid))
    #expect(CFEqual(discovery.roots[1], healthy))
    let focusedID: UInt32? = try discovery.readRoot(invalid) {
        Issue.record("Invalid root was queried again for focus")
        return 7
    }
    #expect(focusedID == nil)
    let selected = try discovery.selectWindow(8, attribute: { element, name in
        #expect(CFEqual(element, healthy))
        return name == "AXRole" ? "AXWindow" : nil
    }, windowID: { _ in 8 }, verifyOwnership: { Issue.record("Healthy window was not matched") })
    #expect(selected.count == 1 && CFEqual(selected[0], healthy))
    let projection = try AXTreeProjection.project(roots: AXObservedChildren(entries: discovery.roots.map(Optional.some)),
        focusedWindowID: focusedID, windowScoped: false, maxElements: 20, maxDepth: 10,
        includeMenus: false, details: false, checkCancellation: {}, read: { element in
            if let failure = discovery.invalidRoots[element] { throw failure }
            return AXReadNode(text: AXTextNode(index: nil, role: "AXButton", title: "Healthy window", value: nil,
                description: nil, actions: ["AXPress"], enabled: true, valueWritable: nil, selectionWritable: nil,
                selected: nil, selectedRange: nil, selectedText: nil), children: AXObservedChildren())
        })
    #expect(projection.tree == "AX scope=application offsets=UTF-16\n[One child could not be read.]\n- [0] AXButton \"Healthy window\"")
    #expect(projection.hasUnreadableElements && !projection.truncated)
    let actionable = try #require(projection.indexed[0])
    #expect(projection.indexed.count == 1 && CFEqual(actionable, healthy))
    do {
        try discovery.validateWindowSelection(hasMatch: false) {}
        Issue.record("Invalid root accepted as an absent AX surface")
    } catch let actual as NativeFailure {
        #expect(actual.message == failure.message)
    }
}

@Test(arguments: ["AXRole", "windowID", "focusedWindowID"])
func rootsInvalidatedAfterDiscoveryDoNotPreventHealthyWindowSelection(operation: String) throws {
    let invalid = AXUIElementCreateApplication(1), healthy = AXUIElementCreateApplication(2)
    var discovery = try AXRootDiscovery.discover(roots: [invalid, healthy], maxElements: 20,
        role: { _ in "AXWindow" }, children: { _ in [] })
    let failure = NativeFailure(code: "NATIVE_ERROR", message: operation, accessibilityError: AXError.invalidUIElement.rawValue)
    if operation == "focusedWindowID" {
        let focusedID: UInt32? = try discovery.readRoot(invalid) { throw failure }
        #expect(focusedID == nil)
    }
    let selected = try discovery.selectWindow(8, attribute: { element, name in
        if operation == "AXRole", CFEqual(element, invalid) { throw failure }
        return name == "AXRole" ? "AXWindow" : nil
    }, windowID: { element in
        if operation == "windowID", CFEqual(element, invalid) { throw failure }
        return 8
    }, verifyOwnership: { Issue.record("Healthy window was not matched") })
    #expect(selected.count == 1 && CFEqual(selected[0], healthy))
    #expect(discovery.invalidRoots[invalid]?.message == operation)
    var ownershipChecked = false
    do {
        _ = try discovery.selectWindow(9, attribute: { _, name in name == "AXRole" ? "AXWindow" : nil },
            windowID: { _ in 8 }, verifyOwnership: { ownershipChecked = true })
        Issue.record("Unknown window accepted after a root failed")
    } catch let actual as NativeFailure {
        #expect(ownershipChecked)
        #expect(actual.message == operation)
    }
}

@Test(arguments: ["AXRole", "AXChildren", "windowID", "focusedWindowID"], [AXError.apiDisabled, .cannotComplete, .failure, .illegalArgument])
func rootReadFailuresOtherThanInvalidElementsStillRejectObservation(operation: String, error: AXError) throws {
    let root = AXUIElementCreateApplication(1)
    let failure = NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
        message: operation, accessibilityError: error.rawValue)
    do {
        var discovery = try AXRootDiscovery.discover(roots: [root], maxElements: 20, role: { _ in
            if operation == "AXRole" { throw failure }
            return "AXWindow"
        }, children: { _ in
            if operation == "AXChildren" { throw failure }
            return []
        })
        if operation == "focusedWindowID" {
            let _: UInt32? = try discovery.readRoot(root) { throw failure }
        } else {
            _ = try discovery.selectWindow(7, attribute: { _, name in name == "AXRole" ? "AXWindow" : nil },
                windowID: { _ in throw failure }, verifyOwnership: {})
        }
        Issue.record("Fatal root error was hidden")
    } catch let actual as NativeFailure {
        #expect(actual.message == operation)
        #expect(actual.code == failure.code)
        #expect(actual.accessibilityError == error.rawValue)
    }
}

@Test(arguments: [false, true])
func selectedWindowKeepsApplicationControlsAccordingToDialogScope(dialog: Bool) throws {
    let nodes = (1...4).map { AXUIElementCreateApplication(Int32($0)) }
    func attribute(_ element: AXUIElement, _ name: String) -> String? {
        if name == "AXSubrole", CFEqual(element, nodes[0]) { return dialog ? "AXDialog" : nil }
        guard name == "AXRole" else { return nil }
        return ["AXWindow", "AXMenuBar", "AXSheet", "AXButton"][nodes.firstIndex { CFEqual($0, element) }!]
    }
    var discovery = try AXRootDiscovery.discover(roots: nodes, maxElements: 20,
        role: { attribute($0, "AXRole") }, children: { _ in [] })
    let selected = try discovery.selectWindow(7, attribute: attribute,
        windowID: { CFEqual($0, nodes[0]) ? 7 : nil }, verifyOwnership: {})
    let expected = dialog ? [nodes[0], nodes[3]] : [nodes[0], nodes[1], nodes[3], nodes[2]]
    #expect(selected.count == expected.count)
    #expect(zip(selected, expected).allSatisfy { CFEqual($0, $1) })
}

@Test func selectedWindowInvalidatedDuringDialogReadStaysAnExplicitUnreadableRoot() throws {
    let root = AXUIElementCreateApplication(1), menu = AXUIElementCreateApplication(2)
    var discovery = try AXRootDiscovery.discover(roots: [root, menu], maxElements: 20,
        role: { CFEqual($0, root) ? "AXWindow" : "AXMenuBar" }, children: { _ in [] })
    let selected = try discovery.selectWindow(7, attribute: { element, name in
        if name == "AXSubrole" {
            throw NativeFailure(code: "NATIVE_ERROR", message: "read AXSubrole", accessibilityError: AXError.invalidUIElement.rawValue)
        }
        return CFEqual(element, root) ? "AXWindow" : "AXMenuBar"
    }, windowID: { _ in 7 }, verifyOwnership: {})
    #expect(selected.count == 1 && CFEqual(selected[0], root))
    #expect(discovery.invalidRoots[root]?.message == "read AXSubrole")
}

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
    var discovery = try AXRootDiscovery.discover(roots: [parent], maxElements: 20,
        role: { _ in "AXWindow" }, children: { _ in [] })
    var ownershipChecked = false
    let selected = try discovery.selectWindow(9, attribute: { _, _ in "AXWindow" },
        windowID: { _ in 7 }, verifyOwnership: { ownershipChecked = true })
    #expect(ownershipChecked)
    #expect(selected.isEmpty)
}

@Test func unmatchedOwnedWindowRemainsUnknownWhenAnotherWindowsChildCannotBeIdentified() throws {
    var discovery = try discoveryWithInvalidChild()
    var ownershipChecked = false
    do {
        _ = try discovery.selectWindow(9, attribute: { _, _ in "AXWindow" },
            windowID: { _ in 7 }, verifyOwnership: { ownershipChecked = true })
        Issue.record("An unidentified child could be the requested window's nested sheet")
    } catch let failure as NativeFailure {
        #expect(ownershipChecked)
        #expect(failure.accessibilityError == AXError.invalidUIElement.rawValue)
        #expect(failure.message.contains("AXRole"))
    }
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
