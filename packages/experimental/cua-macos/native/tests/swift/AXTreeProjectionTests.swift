// Synthetic AX references isolate traversal from application timing and system permissions.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

private func readNode(_ role: String, title: String? = nil, children: [AXUIElement] = []) -> AXReadNode {
    AXReadNode(text: AXTextNode(index: nil, role: role, title: title, value: nil, description: nil,
        actions: role == "AXButton" ? ["AXPress"] : [], enabled: true, valueWritable: nil,
        selectionWritable: nil, selected: nil, selectedRange: nil, selectedText: nil), children: children)
}

private func project(_ roots: [AXUIElement], maxElements: Int = 20, maxDepth: Int = 10,
                     check: () throws -> Void = {}, read: (AXUIElement) throws -> AXReadNode) throws -> AXProjection {
    try AXTreeProjection.project(roots: roots, focusedWindowID: nil, windowScoped: true,
        maxElements: maxElements, maxDepth: maxDepth, includeMenus: false, details: false,
        checkCancellation: check, read: read)
}

@Test func unavailableBranchesKeepReadableSiblingsWithoutAllocatingElementIDs() throws {
    let nodes = (1...5).map { AXUIElementCreateApplication(Int32($0)) }
    var visited: [Int] = []
    let result = try project([nodes[0]]) { element in
        let index = try #require(nodes.firstIndex { CFEqual($0, element) })
        visited.append(index)
        switch index {
        case 0: return readNode("AXWindow", title: "Window", children: [nodes[1], nodes[2], nodes[3]])
        case 1: return readNode("AXButton", title: "Before")
        case 2: throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility read AXChildren failed with error -25202", accessibilityError: AXError.invalidUIElement.rawValue)
        case 3: return readNode("AXGroup", children: [nodes[4]])
        default: return readNode("AXButton", title: "After")
        }
    }
    #expect(visited == [0, 1, 2, 3, 4])
    #expect(result.incomplete)
    #expect(!result.truncated)
    #expect(result.tree == """
    AX scope=window offsets=UTF-16
    - AXWindow "Window"
      - [0] AXButton "Before"
      - [unavailable branch 0.1: invalidUIElement; contents unknown]
      - [1] AXButton "After"
    Accessibility observation incomplete: unavailable branches have unknown contents and no element IDs. Use a screenshot to inspect them.
    """)
    #expect(result.elements.map { $0["elementId"].string } == ["0", "1"])
    #expect(result.indexed.count == 2)
    let before = try #require(result.indexed[0])
    let after = try #require(result.indexed[1])
    #expect(CFEqual(before, nodes[1]))
    #expect(CFEqual(after, nodes[4]))
}

@Test func entirelyUnavailableTreesStayExplicitlyIncomplete() throws {
    let result = try project([AXUIElementCreateApplication(1)]) { _ in
        throw NativeFailure(code: "NATIVE_ERROR", message: "read AXRole", accessibilityError: AXError.invalidUIElement.rawValue)
    }
    #expect(result.incomplete)
    #expect(result.tree.contains("[unavailable branch 0: invalidUIElement; contents unknown]"))
    #expect(result.indexed.isEmpty)
    #expect(result.elements.isEmpty)
}

@Test(arguments: [AXError.apiDisabled, .cannotComplete, .failure, .illegalArgument])
func otherAXFailuresStillRejectTheObservation(code: AXError) throws {
    let nodes = [AXUIElementCreateApplication(1), AXUIElementCreateApplication(2)]
    do {
        _ = try project(nodes) { element in
            if CFEqual(element, nodes[0]) { return readNode("AXButton", title: "Already read") }
            throw NativeFailure(code: code == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR", message: "original operation", accessibilityError: code.rawValue)
        }
        Issue.record("Observation accepted an unrecoverable AX failure")
    } catch let failure as NativeFailure {
        #expect(failure.accessibilityError == code.rawValue)
        #expect(failure.message == "original operation")
    }
}

@Test func cancellationAndUnclassifiedFailuresAreNotUnavailableBranches() throws {
    let root = AXUIElementCreateApplication(1)
    let failure = NativeFailure(code: "CANCELLED", message: "cancelled")
    #expect(throws: NativeFailure.self) {
        try project([root], check: { throw failure }) { _ in
            Issue.record("Read after cancellation")
            return readNode("AXWindow")
        }
    }
    #expect(throws: NativeFailure.self) {
        try project([root]) { _ in throw NativeFailure(code: "NATIVE_ERROR", message: "-25202 text is not an AX error code") }
    }
}

@Test func failedNodesConsumeLimitsAndRepeatedReferencesAreNotRetried() throws {
    let root = AXUIElementCreateApplication(1), missing = AXUIElementCreateApplication(2), later = AXUIElementCreateApplication(3)
    var reads = 0
    let result = try project([root], maxElements: 2) { element in
        reads += 1
        if CFEqual(element, root) { return readNode("AXWindow", children: [missing, missing, later]) }
        throw NativeFailure(code: "NATIVE_ERROR", message: "read AXRole", accessibilityError: AXError.invalidUIElement.rawValue)
    }
    #expect(reads == 2)
    #expect(result.incomplete && result.truncated)
    #expect(result.tree.components(separatedBy: "[unavailable branch").count == 2)
    #expect(result.tree.contains("maxElements=2"))
}

@Test func normalTreesRetainDepthAndMenuOmissionsWithoutClaimingFailure() throws {
    let root = AXUIElementCreateApplication(1), child = AXUIElementCreateApplication(2)
    let result = try project([root], maxDepth: 0) { _ in readNode("AXWindow", children: [child]) }
    #expect(result.truncated && !result.incomplete)
    #expect(result.tree.contains("maxDepth=0"))
    let menu = try project([root]) { _ in readNode("AXMenuBarItem", title: "File", children: [child]) }
    #expect(!menu.truncated && !menu.incomplete)
    #expect(menu.tree.contains("Menu contents omitted; request includeMenus=true to expand."))
}

@Test func completeProjectionPreservesElementDiagnosticsAndExpandedMenus() throws {
    let root = AXUIElementCreateApplication(1), field = AXUIElementCreateApplication(2)
    var reads = 0
    let result = try AXTreeProjection.project(roots: [root, root], focusedWindowID: 7, windowScoped: false,
        maxElements: 10, maxDepth: 10, includeMenus: true, details: true, checkCancellation: {}) { element in
        reads += 1
        if CFEqual(element, root) { return readNode("AXMenuBarItem", title: "File", children: [field]) }
        return AXReadNode(text: AXTextNode(index: nil, role: "AXTextField", title: "Name", value: "abc", description: "Label",
            actions: [], enabled: true, valueWritable: true, selectionWritable: true, selected: false,
            selectedRange: CFRange(location: 1, length: 1), selectedText: "b", identifier: "name",
            bounds: WindowBounds(x: 10, y: 20, width: 100, height: 30)), children: [root])
    }
    #expect(reads == 2)
    #expect(!result.incomplete && !result.truncated)
    #expect(result.focusedWindowID == 7)
    #expect(result.tree.hasPrefix("AX scope=application offsets=UTF-16 bounds=global-points"))
    #expect(result.tree.contains("selection=[1,1] selectedText=\"b\""))
    #expect(!result.tree.contains("Menu contents omitted"))
    #expect(result.elements == [.object([
        "elementId": .string("0"), "role": .string("AXTextField"), "title": .string("Name"), "value": .string("abc"),
        "description": .string("Label"), "identifier": .string("name"), "bounds": .array([10, 20, 100, 30].map { .number(Double($0)) }),
        "actions": .array([]), "enabled": .bool(true), "valueWritable": .bool(true), "selectionWritable": .bool(true),
        "selected": .bool(false), "selectedText": .string("b"), "selectedRange": .array([.number(1), .number(1)]),
    ])])
}
