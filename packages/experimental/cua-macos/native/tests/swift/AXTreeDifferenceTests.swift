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

private func tree(_ titles: [String], order: [Int]? = nil, maxElements: Int = 100, missing: Int? = nil) throws -> AXProjection {
    let nodes = (0...titles.count).map { AXUIElementCreateApplication(Int32($0 + 100)) }
    return try AXTreeProjection.project(roots: AXObservedChildren(entries: [nodes[0]]), focusedWindowID: nil, windowScoped: true,
        maxElements: maxElements, maxDepth: 20, includeMenus: false, details: false, checkCancellation: {}) { element in
        let index = try #require(nodes.firstIndex(of: element))
        if index == missing { throw NativeFailure(code: "NATIVE_ERROR", message: "unavailable", accessibilityError: AXError.invalidUIElement.rawValue) }
        let root = index == 0
        return AXReadNode(text: AXTextNode(index: nil, role: root ? "AXWindow" : "AXButton",
            title: root ? "Fixture" : titles[index - 1], value: nil, description: nil, actions: root ? [] : ["AXPress"],
            enabled: true, valueWritable: nil, selectionWritable: nil, selected: nil, selectedRange: nil, selectedText: nil),
            children: AXObservedChildren(entries: root ? (order ?? Array(1...titles.count)).map { nodes[$0] } : []))
    }
}

private let titles = (1...30).map { "Control \($0)" }

private func difference(_ before: AXProjection?, _ after: AXProjection, showDiff: Bool = true,
                        beforeOptions: AXTreeReadOptions? = nil, afterOptions: AXTreeReadOptions? = nil) throws -> String {
    let oldOptions = try beforeOptions ?? options()
    let newOptions = try afterOptions ?? options()
    return try AXTreeDifference.render(projection: after, current: AXTreeBaseline(projection: after, options: newOptions),
        previous: before.flatMap { AXTreeBaseline(projection: $0, options: oldOptions) }, showDiff: showDiff, checkCancellation: {})
}

@Test func axDifferenceStartsFullAndExplicitFullReadsRemainFull() throws {
    let full = try tree(titles)
    #expect(try difference(nil, full) == full.tree)
    #expect(try difference(full, full, showDiff: false) == full.tree)
    #expect(try difference(full, full) == "AX tree unchanged.")
}

@Test func axDifferenceReportsChangedNativeElementsWithCurrentIDsAndParentContext() throws {
    let before = try tree(titles)
    var updated = titles
    updated[4] = "Updated 中文 🧪"
    let after = try tree(updated)
    #expect(try difference(before, after) == """
    AX diff: + added, - removed, ~ changed.
    Current (current IDs):
      - AXWindow "Fixture"
    ~   - [4] AXButton "Updated 中文 🧪"
    """)
    #expect(after.indexed[4] == AXUIElementCreateApplication(105))
}

@Test func axDifferenceUsesNativeIdentityWhenIDsShiftAndLabelsRepeat() throws {
    let sameLabels = Array(repeating: "Same", count: 30)
    let before = try tree(sameLabels, order: Array(1...29))
    let after = try tree(sameLabels, order: Array(1...28) + [30, 29])
    let diff = try difference(before, after)
    #expect(diff.contains("+   - [28] AXButton \"Same\""))
    #expect(diff.contains("~   - [29] AXButton \"Same\""))
    #expect(after.indexed[28] == AXUIElementCreateApplication(130))
    #expect(after.indexed[29] == before.indexed[28])
    let removed = try difference(after, before)
    #expect(removed.contains("Removed (previous IDs):\n  - AXWindow \"Fixture\"\n-   - [28] AXButton \"Same\""))
    #expect(removed.contains("Current (current IDs):"))
}

@Test func axDifferenceReportsReorderedElements() throws {
    let before = try tree(titles)
    let after = try tree(titles, order: Array(1...28) + [30, 29])
    let diff = try difference(before, after)
    #expect(diff.contains("~   - [28] AXButton \"Control 30\""))
    #expect(diff.contains("~   - [29] AXButton \"Control 29\""))
}

@Test func axDifferenceFallsBackWhenFullOutputIsSmaller() throws {
    let before = try tree(["Before"])
    let after = try tree(["After"])
    #expect(try difference(before, after) == after.tree)
}

@Test func axDifferenceDoesNotInferRemovalsFromPartialObservations() throws {
    let full = try tree(titles)
    for partial in [try tree(titles, maxElements: 4), try tree(titles, missing: 5)] {
        #expect(AXTreeBaseline(projection: partial, options: try options()) == nil)
        #expect(try difference(full, partial) == partial.tree)
        #expect(try difference(partial, full) == full.tree)
    }
}

@Test(arguments: [
    ["includeMenus": JSONValue.bool(true)], ["details": .bool(true)],
    ["maxElements": .number(99)], ["maxDepth": .number(19)],
])
func axDifferenceRequiresMatchingReadOptions(_ changed: [String: JSONValue]) throws {
    let full = try tree(titles)
    #expect(try difference(full, full, afterOptions: options(changed)) == full.tree)
}

@Test func axDifferenceStopsOnCancellation() throws {
    let full = try tree(titles)
    let baseline = AXTreeBaseline(projection: full, options: try options())
    #expect(throws: NativeFailure.self) {
        try AXTreeDifference.render(projection: full, current: baseline, previous: baseline, showDiff: true) {
            throw NativeFailure(code: "CANCELLED", message: "Cancelled")
        }
    }
}
