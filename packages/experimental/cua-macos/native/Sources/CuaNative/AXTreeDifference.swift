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

    var rendered: String { String(repeating: "\t", count: depth) + "\(id) " + body }
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
    let options: AXTreeReadOptions
    let lines: [AXTreeLine]

    /// The snapshot's action lookup and structured element records must use the same numbers as the displayed tree.
    static func observe(_ projection: inout AXProjection, options: AXTreeReadOptions,
                        previous: AXTreeBaseline?, windowTitle: String? = nil, checkCancellation: () throws -> Void) throws -> AXTreeBaseline? {
        guard !projection.truncated, !projection.hasUnreadableElements else { return nil }
        var lines = projection.lines
        let full = AXTreeBaseline(options: options, lines: lines)
        let focus = lines.firstIndex(where: \.focused)
        func focusSummary(_ rows: [AXTreeLine]) -> String {
            guard let focus else { return "" }
            let line = rows[focus]
            return "\nThe focused UI element is \(line.id) \(line.body)"
        }
        projection.tree += focusSummary(lines)
        guard let previous, options == previous.options else { return full }

        let old = Dictionary(uniqueKeysWithValues: previous.lines.map { ($0.element, $0) })
        let retained = try matches(before: previous.lines, after: lines, checkCancellation: checkCancellation)
        var changes: [String] = []
        var live: Set<AXUIElement> = []
        var nextID = (previous.lines.map(\.id).max() ?? -1) + 1
        for i in lines.indices {
            try checkCancellation()
            let line = lines[i]
            if retained.contains(line.element), line.parent.map(live.contains) ?? true, let before = old[line.element] {
                live.insert(line.element)
                lines[i].id = before.id
                if before.body != line.body { changes.append("~" + lines[i].rendered) }
            } else {
                lines[i].id = nextID
                nextID += 1
                changes.append("+" + lines[i].rendered)
            }
        }
        let deleted = previous.lines.compactMap { live.contains($0.element) ? nil : $0.id }.sorted()
        let target = windowTitle.map { " for Window: " + String(reflecting: $0) } ?? ""
        var delta = "There has been no change in the accessibility tree" + target + "."
        if !deleted.isEmpty || !changes.isEmpty {
            var output = ["The following is a diff from the previous accessibility tree" + target + " with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range."]
            if !deleted.isEmpty { output.append("Removed element IDs: " + ranges(deleted)) }
            output += changes
            guard output.count <= lines.count else { return full }
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
        return AXTreeBaseline(options: options, lines: lines)
    }

    /// Retain an ordered subsequence of each parent's children. A move removes the old subtree and inserts the new one.
    private static func matches(before: [AXTreeLine], after: [AXTreeLine], checkCancellation: () throws -> Void) throws -> Set<AXUIElement> {
        let old = Dictionary(uniqueKeysWithValues: before.enumerated().map { ($0.element.element, ($0.offset, $0.element.parent)) })
        var retained: Set<AXUIElement> = []
        for (_, siblings) in Dictionary(grouping: after, by: \.parent) {
            // Native identities are unique within a projection, so their longest increasing subsequence
            // in the previous order is a longest common subsequence, without a quadratic diff table.
            var tails: [(position: Int, sibling: Int)] = []
            var predecessor = Array(repeating: -1, count: siblings.count)
            for (i, line) in siblings.enumerated() {
                try checkCancellation()
                guard let (position, parent) = old[line.element], parent == line.parent else { continue }
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
