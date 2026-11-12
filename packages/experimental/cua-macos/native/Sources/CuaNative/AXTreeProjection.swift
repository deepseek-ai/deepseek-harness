// Bounded AX traversal publishes only fully read nodes and marks unavailable branches.
import ApplicationServices
import Foundation

struct AXReadNode {
    var text: AXTextNode
    let children: [AXUIElement]
}

enum AXTreeProjection {
    static func project(roots: [AXUIElement], focusedWindowID: UInt32?, windowScoped: Bool,
                        maxElements: Int, maxDepth: Int, includeMenus: Bool, details: Bool,
                        checkCancellation: () throws -> Void, read: (AXUIElement) throws -> AXReadNode) throws -> AXProjection {
        var visited: [CFHashCode: [AXUIElement]] = [:]
        var count = 0
        var elementLimitReached = false
        var depthLimitReached = false
        var menusCollapsed = false
        var incomplete = false
        var lines = ["AX scope=\(windowScoped ? "window" : "application") offsets=UTF-16\(details ? " bounds=global-points" : "")"]
        var elements: [JSONValue] = []
        var indexed: [Int: AXUIElement] = [:]
        var pending = roots.enumerated().reversed().map { (element: $0.element, level: 0, depth: 0, path: String($0.offset)) }
        while let (element, level, depth, path) = pending.popLast() {
            try checkCancellation()
            let hash = CFHash(element)
            if visited[hash, default: []].contains(where: { CFEqual($0, element) }) { continue }
            guard count < maxElements else { elementLimitReached = true; break }
            guard depth <= maxDepth else { depthLimitReached = true; continue }
            visited[hash, default: []].append(element)
            count += 1
            let observation: AXReadNode
            do { observation = try read(element) }
            catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                incomplete = true
                lines.append(String(repeating: "  ", count: level) + "- [unavailable branch \(path): invalidUIElement; contents unknown]")
                continue
            }
            var node = observation.text
            let transparent = node.omitted
            if !transparent {
                node.index = node.addressable ? indexed.count : nil
                lines.append(AXTextFormatter.line(node, level: level, details: details))
                if let index = node.index {
                    indexed[index] = element
                    let frame: JSONValue = node.bounds.map { .array([.number($0.x), .number($0.y), .number($0.width), .number($0.height)]) } ?? .null
                    elements.append(.object([
                        "elementId": .string(String(index)), "role": .string(node.role), "title": node.title.map(JSONValue.string) ?? .null,
                        "value": node.value.map(JSONValue.string) ?? .null, "description": node.description.map(JSONValue.string) ?? .null,
                        "identifier": node.identifier.map(JSONValue.string) ?? .null, "bounds": frame,
                        "actions": .array(node.actions.map(JSONValue.string)), "enabled": node.enabled.map(JSONValue.bool) ?? .null,
                        "valueWritable": node.valueWritable.map(JSONValue.bool) ?? .null, "selectionWritable": node.selectionWritable.map(JSONValue.bool) ?? .null,
                        "selected": node.selected.map(JSONValue.bool) ?? .null,
                        "selectedText": node.selectedText.map(JSONValue.string) ?? .null,
                        "selectedRange": node.selectedRange.map { .array([.number(Double($0.location)), .number(Double($0.length))]) } ?? .null,
                    ]))
                }
                if node.role == "AXMenuBarItem" && !includeMenus { menusCollapsed = true; continue }
            }
            for (childIndex, child) in observation.children.enumerated().reversed() {
                pending.append((child, transparent ? level : level + 1, depth + 1, "\(path).\(childIndex)"))
            }
        }
        if menusCollapsed { lines.append("Menu contents omitted; request includeMenus=true to expand.") }
        if incomplete { lines.append("Accessibility observation incomplete: unavailable branches have unknown contents and no element IDs. Use a screenshot to inspect them.") }
        let truncated = elementLimitReached || depthLimitReached
        if truncated { lines.append(AXTextFormatter.truncation(maxElements: elementLimitReached ? maxElements : nil, maxDepth: depthLimitReached ? maxDepth : nil)) }
        return AXProjection(tree: lines.joined(separator: "\n"), elements: elements, indexed: indexed, focusedWindowID: focusedWindowID, truncated: truncated, incomplete: incomplete)
    }
}
