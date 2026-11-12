// Bounded AX traversal publishes read nodes and marks unavailable nodes or child-list entries.
import ApplicationServices
import Foundation

struct AXReadNode {
    var text: AXTextNode
    let children: AXObservedChildren
}

enum AXTreeProjection {
    static func project(roots: AXObservedChildren, focusedWindowID: UInt32?, windowScoped: Bool,
                        maxElements: Int, maxDepth: Int, includeMenus: Bool, details: Bool,
                        checkCancellation: () throws -> Void, read: (AXUIElement) throws -> AXReadNode) throws -> AXProjection {
        var visited: [CFHashCode: [AXUIElement]] = [:]
        var count = 0
        var elementLimitReached = roots.elementLimitReached
        var depthLimitReached = false
        var menusCollapsed = false
        var hasUnreadableElements = roots.hasUnreadableElements
        var lines = ["AX scope=\(windowScoped ? "window" : "application") offsets=UTF-16\(details ? " bounds=global-points" : "")"]
        if roots.parentIncomplete {
            lines.append(windowScoped ? AXTextFormatter.incompleteDiscovery : AXTextFormatter.unreadableChildLine(level: 0, positioned: false))
        }
        var elements: [JSONValue] = []
        var indexed: [Int: AXUIElement] = [:]
        var pending = roots.entries.reversed().map { (element: $0, level: 0, depth: 0) }
        while let (entry, level, depth) = pending.popLast() {
            try checkCancellation()
            let hash = entry.map { CFHash($0) }
            if let element = entry, let hash, visited[hash, default: []].contains(where: { CFEqual($0, element) }) { continue }
            guard count < maxElements else { elementLimitReached = true; break }
            guard depth <= maxDepth else { depthLimitReached = true; continue }
            count += 1
            guard let element = entry, let hash else {
                hasUnreadableElements = true
                lines.append(AXTextFormatter.unreadableChildLine(level: level, positioned: true))
                continue
            }
            visited[hash, default: []].append(element)
            let observation: AXReadNode
            do { observation = try read(element) }
            catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                hasUnreadableElements = true
                lines.append(AXTextFormatter.unreadableChildLine(level: level, positioned: true))
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
            let childLevel = transparent ? level : level + 1
            let children = observation.children
            if children.hasUnreadableElements { hasUnreadableElements = true }
            if children.elementLimitReached { elementLimitReached = true }
            if children.parentIncomplete { lines.append(AXTextFormatter.unreadableChildLine(level: childLevel, positioned: false)) }
            for child in children.entries.reversed() {
                pending.append((child, childLevel, depth + 1))
            }
        }
        if menusCollapsed { lines.append("Menu contents omitted; request includeMenus=true to expand.") }
        if elementLimitReached || depthLimitReached { lines.append(AXTextFormatter.truncation(maxElements: elementLimitReached ? maxElements : nil, maxDepth: depthLimitReached ? maxDepth : nil)) }
        return AXProjection(tree: lines.joined(separator: "\n"), elements: elements, indexed: indexed,
                            focusedWindowID: focusedWindowID, truncated: elementLimitReached || depthLimitReached, hasUnreadableElements: hasUnreadableElements)
    }
}
