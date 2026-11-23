// Native identities and deterministic projections exercise differences without desktop permissions.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

private func options(_ overrides: [String: JSONValue] = [:]) throws -> AXTreeReadOptions {
    let values: [String: JSONValue] = ["appHandle": .string("app"), "maxElements": .number(100), "maxDepth": .number(20)]
    let request = JSONValue.object(["id": .string("read"), "method": .string("getState"),
        "params": .object(values.merging(overrides) { _, new in new })])
    return try AXTreeReadOptions(RequestParameters(NativeRequest(data: JSONEncoder().encode(request))))
}

private func tree(_ titles: [String], order: [Int]? = nil, maxElements: Int = 100, missing: Int? = nil, focused: Int? = nil, selectedText: String? = nil) throws -> AXProjection {
    let nodes = (0...titles.count).map { AXUIElementCreateApplication(Int32($0 + 100)) }
    return try AXTreeProjection.project(roots: AXObservedChildren(entries: [nodes[0]]), focusedWindowID: nil, windowScoped: true,
        maxElements: maxElements, maxDepth: 20, includeMenus: false, details: false, numbered: true, checkCancellation: {}) { element in
        let index = try #require(nodes.firstIndex(of: element))
        if index == missing { throw NativeFailure(code: "NATIVE_ERROR", message: "unavailable", accessibilityError: AXError.invalidUIElement.rawValue) }
        let root = index == 0
        return AXReadNode(text: AXTextNode(index: nil, role: root ? "AXWindow" : "AXButton",
            title: root ? "Fixture" : titles[index - 1], value: nil, description: nil, actions: root ? [] : ["AXPress"],
            enabled: true, valueWritable: nil, selectionWritable: nil, selected: nil, selectedRange: nil,
            selectedText: index == focused ? selectedText : nil, focused: index == focused),
            children: AXObservedChildren(entries: root ? (order ?? Array(1...titles.count)).map { nodes[$0] } : []))
    }
}

private let titles = (1...30).map { "Control \($0)" }

private struct Reader {
    var baseline: AXTreeBaseline?
    mutating func read(_ input: AXProjection, options custom: AXTreeReadOptions? = nil) throws -> AXProjection {
        var out = input
        let resolved = try custom ?? options()
        baseline = try AXTreeBaseline.observe(&out, options: resolved, previous: baseline, checkCancellation: {})
        return out
    }
}

@Test func changesUseOnlyTheNumberedRowsThatChanged() throws {
    var r = Reader(), updated = titles
    let first = try r.read(tree(titles))
    #expect(first.tree.contains("0 AXWindow"))
    #expect(first.indexed[0] == nil)
    updated[4] = "Renamed"
    let delta = try r.read(tree(updated))
    #expect(delta.tree.split(separator: "\n").dropFirst() == ["~\t5 AXButton \"Renamed\""])
    #expect(delta.indexed[5] == AXUIElementCreateApplication(105))
    #expect(try r.read(tree(updated)).tree == "There has been no change in the accessibility tree.")
}

@Test func insertsAndRemovalsUseTheIDsTheCallerReceived() throws {
    var r = Reader()
    let initial = Array(1...25)
    _ = try r.read(tree(titles, order: initial))
    let plus = try r.read(tree(titles, order: [26] + initial))
    #expect(plus.tree.split(separator: "\n").dropFirst() == ["+\t26^0 AXButton \"Control 26\""])
    #expect(plus.indexed[26] == AXUIElementCreateApplication(126))
    #expect(plus.elements[0]["elementId"] == .string("26"))
    let minus = try r.read(tree(titles, order: initial.filter { ![2, 3, 7].contains($0) }))
    #expect(minus.tree.contains("Removed element IDs: 2-3, 7, 26"))
    #expect(minus.indexed[2] == nil && minus.indexed[26] == nil)
    #expect(minus.indexed[4] == AXUIElementCreateApplication(104))
}

@Test func movingTwoSameLabelledButtonsPreservesTheirActionIDs() throws {
    var r = Reader()
    let labels = Array(repeating: "Duplicate", count: 30)
    var order = Array(1...30)
    _ = try r.read(tree(labels, order: order))
    order.swapAt(2, 8)
    let delta = try r.read(tree(labels, order: order))
    #expect(delta.tree.components(separatedBy: "\n").dropFirst() == [">9>2", ">3>8"])
    #expect(delta.indexed[9] == AXUIElementCreateApplication(109))
    #expect(delta.indexed[3] == AXUIElementCreateApplication(103))
}

@Test func cutoffAndUnreadableReadsCannotImplyRemovals() throws {
    let full = try tree(titles)
    for partial in [try tree(titles, maxElements: 4), try tree(titles, missing: 5)] {
        var r = Reader()
        _ = try r.read(full)
        #expect(try r.read(partial).tree == partial.tree)
        #expect(r.baseline == nil)
        #expect(try r.read(full).tree == full.tree)
    }
}

@Test func incompleteNumberedReadsKeepObservedFocusAndSelection() throws {
    var r = Reader()
    let truncated = try r.read(tree(titles, maxElements: 2, focused: 1))
    #expect(truncated.truncated)
    #expect(truncated.tree.hasSuffix("The focused UI element is 1 AXButton \"Control 1\""))
    #expect(r.baseline == nil)

    let unreadable = try r.read(tree(titles, missing: 2, focused: 1, selectedText: "sample"))
    #expect(unreadable.hasUnreadableElements)
    #expect(unreadable.tree.hasSuffix("Selected text: \"sample\""))
    #expect(r.baseline == nil)

    let outside = try r.read(tree(titles, maxElements: 2, focused: 3))
    #expect(!outside.tree.contains("The focused UI element"))
}

@Test(arguments: [
    ["includeMenus": JSONValue.bool(true)], ["details": .bool(true)],
    ["maxElements": .number(99)], ["maxDepth": .number(19)],
])
func changingReadOptionsStartsANewNumberedTree(_ changed: [String: JSONValue]) throws {
    var r = Reader()
    let full = try tree(titles)
    _ = try r.read(full)
    #expect(try r.read(full, options: options(changed)).tree == full.tree)
}

@Test func axDifferenceStopsOnCancellation() throws {
    var r = Reader(), full = try tree(titles)
    _ = try r.read(full)
    #expect(throws: NativeFailure.self) {
        try AXTreeBaseline.observe(&full, options: options(), previous: r.baseline) {
            throw NativeFailure(code: "CANCELLED", message: "Cancelled")
        }
    }
}

@Test(arguments: ["NATIVE_CANCELLED", "NATIVE_TIMEOUT"])
func cancelledReadDiscardsThePublishedWindowBeforeAnotherRequest(code: String) throws {
    let control = NativeRequestControl()
    let request = try NativeRequest(data: Data(#"{"id":"read","method":"getState","params":{"appHandle":"fixture","windowId":"7"}}"#.utf8))
    let delivery = try #require(AXReadDelivery(request, control: control))
    control.startOperation()
    defer { control.finish() }
    let full = try tree(titles)
    var reader = Reader()
    _ = try reader.read(full)
    var published = [delivery.scope: try #require(reader.baseline)]
    #expect(delivery.scopeToDiscard == nil)
    control.cancel(NativeFailure(code: code, message: "Read interrupted"), grace: 1, axTimeout: 1,
                   unresponsive: {}, blockedReply: {})
    let scope = try #require(delivery.scopeToDiscard)
    #expect(scope == SnapshotScope(appHandle: "fixture", windowID: 7))
    published.removeValue(forKey: scope)
    reader.baseline = published[scope]
    #expect(try reader.read(full).tree == full.tree)
}

private func toolbars(_ children: [[Int]], labels: [Int: String] = [:], focused: Int? = nil, selectedText: String? = nil, field: Int? = nil) throws -> AXProjection {
    let refs = (0...50).map { AXUIElementCreateApplication(Int32($0 + 500)) }
    return try AXTreeProjection.project(roots: AXObservedChildren(entries: [refs[0]]), focusedWindowID: 7, windowScoped: true,
        maxElements: 100, maxDepth: 10, includeMenus: false, details: false, numbered: true, checkCancellation: {}) { element in
        let key = try #require(refs.firstIndex(of: element))
        let group = key == 1 || key == 2
        let role = key == 0 ? "AXWindow" : group ? "AXToolbar" : key == field ? "AXTextField" : "AXButton"
        let title = key == 0 ? "Document" : group ? "Actions" : labels[key] ?? "Save"
        let nodes = key == 0 ? [1, 2] : group ? children[key - 1] : []
        return AXReadNode(text: AXTextNode(index: nil, role: role, title: title, value: nil, description: nil,
            actions: role == "AXButton" ? ["AXPress"] : [], enabled: true, valueWritable: nil, selectionWritable: key == field ? focused == key : nil,
            selected: nil, selectedRange: nil, selectedText: key == focused ? selectedText : nil, focused: focused == key),
            children: AXObservedChildren(entries: nodes.map { refs[$0] }))
    }
}

@Test func duplicateToolbarsIdentifyTheRenamedLeafWithoutRepeatingEitherAncestor() throws {
    let children = [[3, 4], [5, 6]]
    var r = Reader()
    let first = try r.read(toolbars(children))
    #expect(first.tree.contains("\t4 AXToolbar \"Actions\"\n\t\t5 AXButton \"Save\""))
    let changed = try r.read(toolbars(children, labels: [5: "Save Copy"]))
    #expect(changed.tree.components(separatedBy: "\n").dropFirst() == ["~\t\t5 AXButton \"Save Copy\""])
    #expect(changed.indexed[5] == AXUIElementCreateApplication(505))
}

@Test func reparentKeepsTheActionIDButReplacementInvalidatesIt() throws {
    var r = Reader()
    _ = try r.read(toolbars([[3, 4], [5, 6]]))
    let moved = try r.read(toolbars([[3, 4, 5], [6]]))
    #expect(moved.tree.hasSuffix("\n>5>3"))
    #expect(moved.indexed[5] == AXUIElementCreateApplication(505))
    let replaced = try r.read(toolbars([[3, 4, 8], [6]]))
    #expect(replaced.tree.hasSuffix("+\t\t7>3 AXButton \"Save\"\nRemoved element IDs: 5"))
    #expect(replaced.indexed[5] == nil && replaced.indexed[7] == AXUIElementCreateApplication(508))
}

@Test func focusIsReportedSeparatelyEvenWhenNoTreeRowsChange() throws {
    var r = Reader()
    let children = [[3], [4]]
    _ = try r.read(toolbars(children, focused: 3, field: 4))
    let changed = try r.read(toolbars(children, focused: 4, field: 4))
    #expect(changed.tree == "There has been no change in the accessibility tree.\nThe focused UI element is 4 AXTextField valueWritable=unknown \"Save\" value=unavailable")
    let selected = try r.read(toolbars(children, focused: 4, selectedText: "Selection", field: 4))
    #expect(selected.tree == "There has been no change in the accessibility tree.\nSelected text: \"Selection\"")
}

@Test func swappingAdjacentSiblingsMovesOnlyTheSecondNodeInTheNewOrder() throws {
    var r = Reader()
    _ = try r.read(tree(["Left", "Right"]))
    let swapped = try r.read(tree(["Left", "Right"], order: [2, 1]))
    #expect(swapped.tree.hasSuffix("\n>1>2"))
    #expect(swapped.indexed[2] == AXUIElementCreateApplication(102))
    let restored = try r.read(tree(["Left", "Right"]))
    #expect(restored.tree.hasSuffix("\n>2>1"))
}

@Test func deletionOfAdjacentNodesUsesOneRange() throws {
    var r = Reader()
    _ = try r.read(tree(["A", "B", "C"]))
    let full = try tree(["A", "B", "C"], order: [3])
    let delta = try r.read(full)
    #expect(delta.tree.contains("Removed element IDs: 1-2"))
    #expect(delta.tree.hasPrefix("The following is a diff"))
}

@Test func equivalentUnicodeSpellingsStillReproduceTheCurrentRowBytes() throws {
    var reader = Reader()
    _ = try reader.read(tree(["Caf\u{e9}"]))
    let current = try tree(["Cafe\u{301}"])
    let diff = try reader.read(current)
    let row = try #require(current.tree.split(separator: "\n").last)
    #expect(diff.tree.split(separator: "\n").last?.utf8.elementsEqual(("~" + row).utf8) == true)
}
