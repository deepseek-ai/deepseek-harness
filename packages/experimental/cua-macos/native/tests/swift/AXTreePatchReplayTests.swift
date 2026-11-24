// A caller reconstructs preorder rows from public text alone. Native references are used only by the oracle.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

private struct Row: Equatable {
    var depth: Int
    let id: Int
    var body: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.depth == rhs.depth && lhs.id == rhs.id && lhs.body.utf8.elementsEqual(rhs.body.utf8)
    }
}
private struct BadPatch: Error {}

private func decodeRow(_ text: Substring) throws -> (Row, Substring) {
    let depth = text.prefix(while: { $0 == "\t" }).count
    let fields = text.dropFirst(depth).split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
    guard fields.count == 2 else { throw BadPatch() }
    let digits = fields[0].prefix(while: \.isNumber)
    guard let id = Int(digits) else { throw BadPatch() }
    return (Row(depth: depth, id: id, body: String(fields[1])), fields[0].dropFirst(digits.count))
}

private func fullRows(_ text: String) throws -> [Row] {
    try text.split(separator: "\n").dropFirst().map {
        let (row, location) = try decodeRow($0)
        guard location.isEmpty else { throw BadPatch() }
        return row
    }
}

private func replay(_ text: String, on original: [Row]) throws -> [Row] {
    var rows = original
    var additions: [Row] = []
    func index(_ id: Int) throws -> Int {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { throw BadPatch() }
        return i
    }
    func subtree(_ start: Int) -> Range<Int> {
        var end = start + 1
        while end < rows.count && rows[end].depth > rows[start].depth { end += 1 }
        return start..<end
    }
    func destination(_ anchor: Substring) throws -> (offset: Int, depth: Int) {
        if anchor == "^root" { return (0, 0) }
        guard let id = Int(anchor.dropFirst()) else { throw BadPatch() }
        let i = try index(id)
        switch anchor.first {
        case "^": return (i + 1, rows[i].depth + 1)
        case ">": return (subtree(i).upperBound, rows[i].depth)
        default: throw BadPatch()
        }
    }

    guard text.hasPrefix("The following is a diff") || text.hasPrefix("There has been no change") else { throw BadPatch() }
    for line in text.split(separator: "\n").dropFirst() {
        switch line.first {
        case "+":
            let (row, anchor) = try decodeRow(line.dropFirst())
            let place: (offset: Int, depth: Int)
            if anchor.isEmpty {
                while let tail = additions.last, tail.depth > row.depth { additions.removeLast() }
                guard let tail = additions.last else { throw BadPatch() }
                let i = try index(tail.id)
                if tail.depth == row.depth {
                    place = (subtree(i).upperBound, tail.depth)
                    additions.removeLast()
                } else {
                    place = (i + 1, tail.depth + 1)
                }
            } else {
                additions = []
                place = try destination(anchor)
            }
            guard place.depth == row.depth, !rows.contains(where: { $0.id == row.id }) else { throw BadPatch() }
            rows.insert(row, at: place.offset)
            additions.append(row)
        case ">":
            let digits = line.dropFirst().prefix(while: \.isNumber)
            guard let id = Int(digits) else { throw BadPatch() }
            let range = subtree(try index(id))
            var moved = Array(rows[range])
            rows.removeSubrange(range)
            additions = []
            let place = try destination(line.dropFirst(1 + digits.count))
            let shift = place.depth - moved[0].depth
            for i in moved.indices { moved[i].depth += shift }
            rows.insert(contentsOf: moved, at: place.offset)
        case "~":
            let (row, anchor) = try decodeRow(line.dropFirst())
            let i = try index(row.id)
            guard anchor.isEmpty, row.depth == rows[i].depth else { throw BadPatch() }
            rows[i] = row
            additions = []
        default:
            let prefix = "Removed element IDs: "
            guard line.hasPrefix(prefix) else { throw BadPatch() }
            for token in line.dropFirst(prefix.count).components(separatedBy: ", ") {
                let bounds = token.split(separator: "-")
                guard (1...2).contains(bounds.count), let first = Int(bounds[0]), let last = Int(bounds.last!), last >= first else { throw BadPatch() }
                for id in first...last { rows.remove(at: try index(id)) }
            }
        }
    }
    return rows
}

private struct Visit: Equatable {
    let key: Int
    let depth: Int
}

private func forests(prefix: [Visit], remaining: [Int]) -> [[Visit]] {
    var values = [prefix]
    for key in remaining {
        for depth in 0...((prefix.last?.depth ?? -1) + 1) {
            values += forests(prefix: prefix + [Visit(key: key, depth: depth)], remaining: remaining.filter { $0 != key })
        }
    }
    return values
}

private func project(_ visits: [Visit], rename: Int? = nil) throws -> AXProjection {
    let refs = (0...12).map { AXUIElementCreateApplication(Int32(900 + $0)) }
    var path: [Int] = [], children: [Int?: [AXUIElement?]] = [:]
    for visit in visits {
        path.removeLast(path.count - visit.depth)
        children[path.last, default: []].append(refs[visit.key])
        path.append(visit.key)
    }
    return try AXTreeProjection.project(roots: AXObservedChildren(entries: children[nil] ?? []), focusedWindowID: nil, windowScoped: true,
        maxElements: 100, maxDepth: 20, includeMenus: false, details: false, numbered: true, checkCancellation: {}) { element in
        let key = try #require(refs.firstIndex(of: element))
        let title = key == rename ? "新行\n+12^root >5" : "Same"
        return AXReadNode(text: AXTextNode(index: nil, role: "AXButton", title: title, value: nil, description: nil, actions: ["AXPress"],
            enabled: true, valueWritable: nil, selectionWritable: nil, selected: nil, selectedRange: nil, selectedText: nil),
            children: AXObservedChildren(entries: children[key] ?? []))
    }
}

private func readOptions() throws -> AXTreeReadOptions {
    let request = try NativeRequest(data: Data(#"{"id":"test","method":"getState","params":{"appHandle":"a","maxElements":100,"maxDepth":20}}"#.utf8))
    return try AXTreeReadOptions(RequestParameters(request))
}

@Test func everyEditBetweenSmallOrderedForestsReplaysToTheNewObservation() throws {
    let options = try readOptions()
    let shapes = forests(prefix: [], remaining: [1, 2, 3])
    let plain = try shapes.map { try project($0) }
    let renamed = try shapes.map { try project($0, rename: 2) }
    for (oldIndex, old) in shapes.enumerated() {
        var first = plain[oldIndex]
        let base = try AXTreeBaseline.observe(&first, options: options, previous: nil, checkCancellation: {})
        let original = try fullRows(first.tree)
        let known = Dictionary(uniqueKeysWithValues: zip(old.map(\.key), original.map(\.id)))
        for (newIndex, new) in shapes.enumerated() {
            var fresh = renamed[newIndex]
            var expected = try fullRows(fresh.tree)
            var next = (known.values.max() ?? -1) + 1
            for i in new.indices {
                let id = known[new[i].key] ?? next
                if known[new[i].key] == nil { next += 1 }
                expected[i] = Row(depth: new[i].depth, id: id, body: expected[i].body)
            }
            _ = try AXTreeBaseline.observe(&fresh, options: options, previous: base, checkCancellation: {})
            let decoded = try replay(fresh.tree, on: original)
            try #require(decoded == expected, "old=\(old), new=\(new), patch=\(fresh.tree)")
            for (visit, row) in zip(new, expected) {
                try #require(fresh.indexed[row.id] == AXUIElementCreateApplication(Int32(900 + visit.key)))
            }
        }
    }
}

@Test func adjacentInsertionsShareOneAnchorAndCanSeedTheNextDelta() throws {
    let options = try readOptions()
    var first = try project([Visit(key: 1, depth: 0), Visit(key: 2, depth: 1)])
    var base = try AXTreeBaseline.observe(&first, options: options, previous: nil, checkCancellation: {})
    let old = try fullRows(first.tree)
    var more = try project([Visit(key: 1, depth: 0), Visit(key: 3, depth: 1), Visit(key: 4, depth: 1), Visit(key: 2, depth: 1)])
    base = try AXTreeBaseline.observe(&more, options: options, previous: base, checkCancellation: {})
    #expect(more.tree.hasSuffix("+\t2^0 AXButton \"Same\"\n+\t3 AXButton \"Same\""))
    let middle = try replay(more.tree, on: old)
    var last = try project([Visit(key: 3, depth: 0), Visit(key: 4, depth: 1), Visit(key: 2, depth: 1)], rename: 2)
    _ = try AXTreeBaseline.observe(&last, options: options, previous: base, checkCancellation: {})
    #expect(try replay(last.tree, on: middle).map(\.id) == [2, 3, 1])
}

@Test func aNewBranchNeedsOnlyOneAnchorUntilItSkipsAnExistingSibling() throws {
    let options = try readOptions()
    let initial = [Visit(key: 1, depth: 0), Visit(key: 2, depth: 1)]
    var first = try project(initial)
    let base = try AXTreeBaseline.observe(&first, options: options, previous: nil, checkCancellation: {})
    let shape = [initial[0], Visit(key: 3, depth: 1), Visit(key: 4, depth: 2), Visit(key: 5, depth: 2),
                 Visit(key: 6, depth: 1), initial[1], Visit(key: 7, depth: 1)]
    var after = try project(shape)
    _ = try AXTreeBaseline.observe(&after, options: options, previous: base, checkCancellation: {})
    let insertions = after.tree.split(separator: "\n").dropFirst()
    #expect(insertions.map { $0.split(separator: " ")[0] } == ["+\t2^0", "+\t\t3", "+\t\t4", "+\t5", "+\t6>1"])
    let result = try replay(after.tree, on: fullRows(first.tree))
    #expect(result.map(\.id) == [0, 2, 3, 4, 5, 1, 6])
    #expect(result.map(\.depth) == shape.map(\.depth))
}

@Test func aChangedMenuDisclosureReplacesTheEntireNumberedObservation() throws {
    let options = try readOptions()
    func withMenu(_ menu: Bool) throws -> AXProjection {
        let window = AXUIElementCreateApplication(700), bar = AXUIElementCreateApplication(701)
        return try AXTreeProjection.project(roots: AXObservedChildren(entries: [window]), focusedWindowID: nil,
            windowScoped: true, maxElements: 100, maxDepth: 20, includeMenus: false, details: false, numbered: true,
            checkCancellation: {}) { element in
            let root = element == window
            return AXReadNode(text: AXTextNode(index: nil, role: root ? "AXWindow" : "AXMenuBarItem",
                title: root ? "App" : "Menu", value: nil, description: nil, actions: [], enabled: true, valueWritable: nil,
                selectionWritable: nil, selected: nil, selectedRange: nil, selectedText: nil),
                children: AXObservedChildren(entries: root && menu ? [bar] : []))
        }
    }
    var original = try withMenu(false)
    var base = try AXTreeBaseline.observe(&original, options: options, previous: nil, checkCancellation: {})
    for menu in [true, false] {
        var current = try withMenu(menu)
        let expected = current.tree
        base = try AXTreeBaseline.observe(&current, options: options, previous: base, checkCancellation: {})
        #expect(current.tree == expected)
        #expect(current.tree.contains("Menu contents omitted") == menu)
    }
}
