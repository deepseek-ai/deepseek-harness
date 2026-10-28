// Model-facing AX text; native references and snapshot indices remain owned by AXAccess.
import Foundation

struct AXTextNode {
    var index: Int?
    var role: String
    var title: String?
    var value: String?
    var description: String?
    var actions: [String]
    var enabled: Bool?
    var valueWritable: Bool?
    var selectionWritable: Bool?
    var selected: Bool?
    var selectedRange: CFRange?
    var selectedText: String?
    var subrole: String? = nil
    var placeholder: String? = nil
    var help: String? = nil
    var identifier: String? = nil
    var url: String? = nil
    var focused: Bool? = nil
    var expanded: Bool? = nil
    var bounds: WindowBounds? = nil
    var invalidSelection = false

    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXStaticText"]
    static let valueRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXStepper", "AXIncrementor", "AXCheckBox", "AXRadioButton"]

    mutating func validateSelection() {
        guard let range = selectedRange, let value else { return }
        let length = value.utf16.count
        if range.location > length || range.length > length - range.location {
            selectedRange = nil
            selectedText = nil
            invalidSelection = true
        }
    }

    var hasMeaning: Bool {
        [title, value, description, placeholder, help, identifier, url, ["AXUnknown", "AXHostingView"].contains(subrole ?? "") ? nil : subrole].contains { !($0?.isEmpty ?? true) }
            || enabled == false || selected == true || focused == true || expanded != nil
    }
    var transparent: Bool {
        guard role == "AXGroup" || role == "AXScrollArea" else { return false }
        return !hasMeaning && valueWritable != true && selectionWritable != true
            && actions.allSatisfy { ["AXShowMenu", "AXScrollToVisible", "AXCancel"].contains($0) }
    }
}

enum AXTextFormatter {
    // AppKit embeds target pointers in custom action names. The executor resolves
    // the displayed name against current actions and rejects ambiguous aliases.
    static func actionName(_ raw: String) -> String {
        if raw.hasPrefix("Name:"), let end = raw.range(of: "\nTarget:") {
            return String(raw[raw.index(raw.startIndex, offsetBy: 5)..<end.lowerBound])
        }
        return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
    }

    static func line(_ node: AXTextNode, level: Int, details: Bool = false) -> String {
        var line = String(repeating: "  ", count: level) + "- "
        if let index = node.index { line += "[\(index)] " }
        line += node.role
        if let subrole = node.subrole, !subrole.isEmpty, subrole != "AXUnknown", subrole != node.role,
           details || !["AXStandardWindow", "AXHostingView"].contains(subrole) { line += " subrole=\(subrole)" }
        if node.enabled == false { line += " disabled" }
        if node.focused == true { line += " focused" }
        if let expanded = node.expanded { line += " expanded=\(expanded)" }
        if node.selected == true { line += " selected" }
        else if details, let selected = node.selected { line += " selected=\(selected)" }
        if AXTextNode.valueRoles.contains(node.role) {
            line += " valueWritable=\(node.valueWritable.map(String.init) ?? "unknown")"
        }
        if AXTextNode.textRoles.contains(node.role), node.role != "AXStaticText" || node.selectionWritable == true || details {
            line += " selectionWritable=\(node.selectionWritable.map(String.init) ?? "unknown")"
        }
        var seen: Set<String> = []
        func field(_ value: String?, prefix: String, deduplicate: Bool = true) {
            guard let value, !value.isEmpty else { return }
            let unique = seen.insert(value).inserted
            guard !deduplicate || unique else { return }
            line += prefix + String(reflecting: value)
        }
        field(node.title, prefix: " ")
        if node.title?.isEmpty != false && !details { field(node.description, prefix: " ") }
        // Empty values distinguish an unfilled input from its placeholder.
        if let value = node.value, value.isEmpty, AXTextNode.valueRoles.contains(node.role) { line += " value=\"\"" }
        else if node.value == nil && AXTextNode.valueRoles.contains(node.role) { line += " value=unavailable" }
        else { field(node.value, prefix: " = ", deduplicate: false) }
        field(node.placeholder, prefix: " placeholder=", deduplicate: false)
        field(node.description, prefix: " description=")
        field(node.help, prefix: " help=")
        field(node.url, prefix: " url=", deduplicate: false)
        if details || seen.isEmpty { field(node.identifier, prefix: " id=") }
        if node.invalidSelection { line += " selection=unavailable" }
        else if let range = node.selectedRange { line += " selection=[\(range.location),\(range.length)]" }
        if let text = node.selectedText, !text.isEmpty { line += " selectedText=\(String(reflecting: text))" }
        var actions: [String] = []
        for raw in node.actions {
            let name = actionName(raw)
            if !details && ["Press", "Pick", "ShowMenu", "ScrollToVisible"].contains(name) { continue }
            let displayed = details ? String(reflecting: raw) : String(reflecting: name)
            if !actions.contains(displayed) { actions.append(displayed) }
        }
        if !actions.isEmpty { line += " actions=[\(actions.joined(separator: ","))]" }
        if details, node.index != nil {
            if let bounds = node.bounds { line += " bounds=[\(bounds.x),\(bounds.y),\(bounds.width),\(bounds.height)]" }
            else { line += " bounds=unavailable" }
        }
        return line
    }

    static func truncation(maxElements: Int?, maxDepth: Int?) -> String {
        var limits: [String] = []
        if let maxElements { limits.append("maxElements=\(maxElements)") }
        if let maxDepth { limits.append("maxDepth=\(maxDepth)") }
        return "Accessibility tree truncated (\(limits.joined(separator: ", "))). Select a narrower window or increase these provider limits before reading again."
    }
}
