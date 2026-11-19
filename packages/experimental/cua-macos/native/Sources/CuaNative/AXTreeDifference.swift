// Compare complete observations by native identity while preserving each observation's element IDs.
import ApplicationServices
import Foundation

struct AXTreeLine {
    let element: AXUIElement
    let parent: AXUIElement?
    let previousSibling: AXUIElement?
    let text: String
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
    let focusedWindowID: UInt32?

    init?(projection: AXProjection, options: AXTreeReadOptions) {
        guard !projection.truncated, !projection.hasUnreadableElements else { return nil }
        self.options = options
        lines = projection.lines
        focusedWindowID = projection.focusedWindowID
    }
}

enum AXTreeDifference {
    /// Removed lines retain old IDs; additions, changes and their ancestors carry current IDs.
    static func render(projection: AXProjection, current: AXTreeBaseline?, previous: AXTreeBaseline?,
                       showDiff: Bool, checkCancellation: () throws -> Void) throws -> String {
        guard showDiff, let current, let previous, current.options == previous.options,
              current.focusedWindowID == previous.focusedWindowID else { return projection.tree }
        let old = Dictionary(uniqueKeysWithValues: previous.lines.map { ($0.element, $0) })
        let new = Dictionary(uniqueKeysWithValues: current.lines.map { ($0.element, $0) })
        var removed: [AXUIElement: String] = [:]
        var changed: [AXUIElement: String] = [:]
        for line in previous.lines {
            try checkCancellation()
            if new[line.element] == nil { removed[line.element] = "-" }
        }
        for line in current.lines {
            try checkCancellation()
            guard let before = old[line.element] else { changed[line.element] = "+"; continue }
            if before.text != line.text || before.parent != line.parent || before.previousSibling != line.previousSibling {
                changed[line.element] = "~"
            }
        }
        if removed.isEmpty && changed.isEmpty {
            return projection.tree.isEmpty ? projection.tree : "AX tree unchanged."
        }
        var output = ["AX diff: + added, - removed, ~ changed."]
        if !removed.isEmpty {
            output.append("Removed (previous IDs):")
            output += try context(previous.lines, byElement: old, markers: removed, checkCancellation: checkCancellation)
        }
        if !changed.isEmpty {
            output.append("Current (current IDs):")
            output += try context(current.lines, byElement: new, markers: changed, checkCancellation: checkCancellation)
        }
        let diff = output.joined(separator: "\n")
        return diff.utf8.count < projection.tree.utf8.count ? diff : projection.tree
    }

    private static func context(_ lines: [AXTreeLine], byElement: [AXUIElement: AXTreeLine],
                                markers: [AXUIElement: String], checkCancellation: () throws -> Void) throws -> [String] {
        var included = Set(markers.keys)
        for element in markers.keys {
            var parent = byElement[element]?.parent
            while let ancestor = parent, included.insert(ancestor).inserted {
                try checkCancellation()
                parent = byElement[ancestor]?.parent
            }
        }
        return try lines.compactMap { line in
            try checkCancellation()
            return included.contains(line.element) ? "\(markers[line.element] ?? " ") \(line.text)" : nil
        }
    }
}
