// Compare successive numbered AX observations in traversal order.
import ApplicationServices
import Foundation

struct AXTreeLine {
    let element: AXUIElement
    let parent: AXUIElement?
    let depth: Int
    var id: Int
    let body: String
    let focused: Bool
    let selectedText: String?

    var rendered: String { rendered(at: "") }

    func rendered(at anchor: String) -> String {
        String(repeating: "\t", count: depth) + "\(id)\(anchor) " + body
    }
}

struct AXTreeReadOptions: Equatable {
    let maxElements: Int
    let maxDepth: Int
    let includeMenus: Bool
    let details: Bool

    init(_ params: RequestParameters) throws {
        maxElements = try params.integer("maxElements", in: NativeProtocol.elementRange)
        maxDepth = try params.integer("maxDepth", in: NativeProtocol.depthRange)
        includeMenus = try params.optionalBoolean("includeMenus") ?? false
        details = try params.optionalBoolean("details") ?? false
    }
}

struct AXTreeBaseline {
    let frame: AXTreeFrame
    let options: AXTreeReadOptions
    let lines: [AXTreeLine]

    /// The snapshot's action lookup and structured element records must use the same numbers as the displayed tree.
    static func observe(_ projection: inout AXProjection, options: AXTreeReadOptions,
                        previous: AXTreeBaseline?, windowTitle: String? = nil, checkCancellation: () throws -> Void) throws -> AXTreeBaseline? {
        var lines = projection.lines
        let focus = lines.firstIndex(where: \.focused)
        func focusSummary(_ rows: [AXTreeLine]) -> String {
            guard let focus else { return "" }
            let line = rows[focus]
            if let text = line.selectedText, !text.isEmpty { return "\nSelected text: " + String(reflecting: text) }
            return "\nThe focused UI element is \(line.id) \(line.body)"
        }
        projection.tree += focusSummary(lines)
        guard !projection.truncated, !projection.hasUnreadableElements else { return nil }
        guard let previous, options == previous.options, projection.frame == previous.frame else {
            return AXTreeBaseline(frame: projection.frame, options: options, lines: lines)
        }

        let old = Dictionary(uniqueKeysWithValues: previous.lines.map { ($0.element, $0) })
        let retained = try matches(before: previous.lines, after: lines, checkCancellation: checkCancellation)
        var changes: [String] = []
        var ids: [AXUIElement: Int] = [:]
        var lastChild: [AXUIElement?: Int] = [:]
        var insertionPath: [(depth: Int, id: Int)] = []
        var nextID = (previous.lines.map(\.id).max() ?? -1) + 1
        for i in lines.indices {
            try checkCancellation()
            let line = lines[i]
            let before = old[line.element]
            let id = before?.id ?? nextID
            lines[i].id = id
            ids[line.element] = id

            // Preorder makes both the destination parent and its preceding child available to the reader.
            let sibling = lastChild.updateValue(id, forKey: line.parent)
            if !retained.contains(line.element) {
                let parentID = line.parent.map { ids[$0]! }
                let anchor = sibling.map { ">\($0)" } ?? ("^" + (parentID.map(String.init) ?? "root"))
                if before == nil {
                    nextID += 1
                    // A run of inserted rows uses the same indentation rules as a full subtree.
                    while let last = insertionPath.last, last.depth > line.depth { insertionPath.removeLast() }
                    let last = insertionPath.last
                    let followsSibling = last?.depth == line.depth && last?.id == sibling
                    let startsChildren = last?.depth == line.depth - 1 && last?.id == parentID && sibling == nil
                    let continuation = followsSibling || startsChildren
                    if !continuation { insertionPath.removeAll(keepingCapacity: true) }
                    else if followsSibling { insertionPath.removeLast() }
                    changes.append("+" + lines[i].rendered(at: continuation ? "" : anchor))
                    insertionPath.append((line.depth, id))
                } else {
                    changes.append(">\(id)\(anchor)")
                    insertionPath.removeAll(keepingCapacity: true)
                }
            }
            if let before, !before.body.utf8.elementsEqual(line.body.utf8) {
                changes.append("~" + lines[i].rendered)
                insertionPath.removeAll(keepingCapacity: true)
            }
        }
        let deleted = previous.lines.compactMap { ids[$0.element] == nil ? $0.id : nil }.sorted()
        let target = windowTitle.map { " for Window: " + String(reflecting: $0) } ?? ""
        var delta = "There has been no change in the accessibility tree" + target + "."
        if !deleted.isEmpty || !changes.isEmpty {
            var output = ["The following is a diff from the previous accessibility tree" + target + "."]
            output += changes
            if !deleted.isEmpty { output.append("Removed element IDs: " + ranges(deleted)) }
            delta = output.joined(separator: "\n")
        }

        // Full observations number rows densely. Publish only the remapped IDs for actionable rows.
        var actions: [Int: AXUIElement] = [:]
        var actionIndex = 0
        for (dense, line) in lines.enumerated() where projection.indexed[dense] != nil {
            var record = projection.elements[actionIndex].object!
            actions[line.id] = line.element
            record["elementId"] = .string(String(line.id))
            projection.elements[actionIndex] = .object(record)
            actionIndex += 1
        }
        projection.indexed = actions
        projection.tree = delta + focusSummary(lines)
        return AXTreeBaseline(frame: projection.frame, options: options, lines: lines)
    }

    /// Retain an ordered subsequence of each parent's children. Other surviving children need an explicit move.
    private static func matches(before: [AXTreeLine], after: [AXTreeLine], checkCancellation: () throws -> Void) throws -> Set<AXUIElement> {
        let old = Dictionary(uniqueKeysWithValues: before.enumerated().map { ($0.element.element, ($0.offset, $0.element.parent)) })
        var retained: Set<AXUIElement> = []
        for (_, siblings) in Dictionary(grouping: after, by: \.parent) {
            // Native identities are unique within a projection, so their longest increasing subsequence
            // in the previous order is a longest common subsequence, without a quadratic diff table.
            var tails: [(position: Int, sibling: Int)] = []
            var predecessor = Array(repeating: -1, count: siblings.count)
            // Traversing backwards keeps the first node in the new order when an adjacent swap has two equal matches.
            for i in siblings.indices.reversed() {
                let line = siblings[i]
                try checkCancellation()
                guard let (offset, parent) = old[line.element], parent == line.parent else { continue }
                let position = -offset
                var lo = 0, hi = tails.count
                while lo < hi {
                    let mid = (lo + hi) / 2
                    if tails[mid].position < position { lo = mid + 1 } else { hi = mid }
                }
                if lo > 0 { predecessor[i] = tails[lo - 1].sibling }
                if lo == tails.count { tails.append((position, i)) } else { tails[lo] = (position, i) }
            }
            var i = tails.last?.sibling ?? -1
            while i >= 0 { retained.insert(siblings[i].element); i = predecessor[i] }
        }
        return retained
    }

    private static func ranges(_ sorted: [Int]) -> String {
        var result: [String] = []
        var i = 0
        while i < sorted.count {
            let first = sorted[i]
            while i + 1 < sorted.count && sorted[i + 1] == sorted[i] + 1 { i += 1 }
            result.append(first == sorted[i] ? "\(first)" : "\(first)-\(sorted[i])")
            i += 1
        }
        return result.joined(separator: ", ")
    }
}
