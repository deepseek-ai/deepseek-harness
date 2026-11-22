// Setter discovery, name-only schemas and live writes share the same parameter definitions.
import ApplicationServices
import Foundation

enum AXSetterParameter: Sendable {
    case fixed(AXArgumentKind, String? = nil)
    case live([AXArgumentKind], String)
    case focus
    case strings([String])
    case elementReferences

    // AXAttributeConstants.h defines attribute types. Writability belongs to the individual element.
    static let attributes: [String: Self] = [
        "AXFocused": .focus,
        "AXMain": .fixed(.boolean, "Whether the window is the application's main window."),
        "AXMinimized": .fixed(.boolean, "True to minimize the window; false to restore it."),
        "AXExpanded": .fixed(.boolean, "True to expand the control; false to collapse it."),
        "AXDisclosing": .fixed(.boolean, "True to disclose the row's children; false to hide them."),
        "AXSelected": .fixed(.boolean, "Whether the element is selected."),
        "AXElementBusy": .fixed(.boolean, "Whether the element is busy."),
        "AXEnabled": .fixed(.boolean, "Whether the control is enabled."),
        "AXFrontmost": .fixed(.boolean, "Whether the application is frontmost."),
        "AXHidden": .fixed(.boolean, "Whether the application is hidden."),
        "AXTitle": .fixed(.string, "The element's title."),
        "AXSelectedText": .fixed(.string, "Text to replace the current selection."),
        "AXPosition": .fixed(.point, "Global screen position in macOS points, measured from the upper left of the main display."),
        "AXSize": .fixed(.size, "Width and height in macOS points."),
        "AXSelectedTextRange": .fixed(.range, "Selection in UTF-16 code units. A zero length places the insertion point."),
        "AXVisibleCharacterRange": .fixed(.range, "Text range to make visible, in UTF-16 code units."),
        "AXSelectedTextRanges": .fixed(.ranges, "One or more UTF-16 selections. For multiple selections, use nonempty ranges in increasing order with a gap between them."),
        "AXOrientation": .strings([kAXHorizontalOrientationValue as String, kAXVerticalOrientationValue as String, kAXUnknownOrientationValue as String]),
        "AXSortDirection": .strings([kAXAscendingSortDirectionValue as String, kAXDescendingSortDirectionValue as String, kAXUnknownSortDirectionValue as String]),
        "AXFocusedUIElement": .elementReferences, "AXFocusedWindow": .elementReferences, "AXMainWindow": .elementReferences,
        "AXSelectedChildren": .elementReferences, "AXSelectedRows": .elementReferences, "AXSelectedColumns": .elementReferences,
        "AXSelectedCells": .elementReferences,
    ]

    // AppKit's role protocols further specialize AXValue; a registered role still has to advertise a writable AXValue.
    private static let text = Self.live([.string], "Replacement text for this control.")
    private static let adjustable = Self.live([.number, .string], "Use the control's numeric or string value type. Numeric limits depend on the control.")
    private static let toggle = Self.live([.boolean, .number], "Use the control's boolean or numeric state.")
    static let valueRoles: [String: Self] = [
        "AXTextField": text, "AXTextArea": text, "AXComboBox": text, "AXStaticText": text,
        "AXSlider": adjustable, "AXIncrementor": adjustable, "AXStepper": adjustable,
        "AXCheckBox": toggle, "AXRadioButton": toggle,
        "AXProgressIndicator": .live([.number], "A finite value within the control's current range."),
    ]
    private static let dynamic = Self.live([.string, .boolean, .number, .point, .size, .range],
        "The accepted value type depends on the element's live attribute value type.")

    static func resolve(role: String?, attribute: String) -> Self {
        if attribute == "AXValue", let role { return valueRoles[role] ?? dynamic }
        return attributes[attribute] ?? dynamic
    }

    func schema(attribute: String) throws -> JSONValue {
        switch self {
        case let .fixed(kind, description): return Self.described(kind.schema, description)
        case let .live(kinds, description):
            if kinds.count == 1 { return Self.described(kinds[0].schema, description) }
            return SchemaBuilder.oneOf(kinds.map(\.schema), description: description)
        case .focus: return SchemaBuilder.scalar("boolean", description: "Pass true to request keyboard focus.")
        case let .strings(values): return SchemaBuilder.scalar("string", description: "Accepted values (case-sensitive): " + values.joined(separator: ", ") + ".")
        case .elementReferences: throw Self.unsupportedReferences(attribute)
        }
    }
    private static func described(_ schema: JSONValue, _ description: String?) -> JSONValue {
        guard let description, case .object(var fields) = schema else { return schema }
        fields["description"] = .string([description, fields["description"]?.string].compactMap { $0 }.joined(separator: " "))
        return .object(fields)
    }
    private static func unsupportedReferences(_ attribute: String) -> NativeFailure {
        NativeFailure(code: "UNSUPPORTED", message: "\(attribute) requires accessibility element references that cannot be passed as JSON")
    }

    func canList(attribute: String, read: () throws -> CFTypeRef?) throws -> Bool {
        switch self {
        case .elementReferences: return false
        case let .live(kinds, _):
            do {
                guard let current = try read() else { return true }
                guard let kind = AXArgumentKind.observed(current) else { return false }
                return kinds.contains(kind)
            } catch let error as NativeFailure where error.attribute == attribute && error.accessibilityError == AXError.failure.rawValue {
                return true
            }
        case .fixed, .focus, .strings: return true
        }
    }

    func encode(_ argument: JSONValue, attribute: String, read: () throws -> CFTypeRef?) throws -> CFTypeRef {
        switch self {
        case let .fixed(kind, _): return try kind.encode(argument, attribute: attribute)
        case .focus:
            guard argument == .bool(true) else { throw RequestParameters.invalid("\(attribute) requires true to request keyboard focus") }
            return kCFBooleanTrue!
        case let .strings(values):
            guard let text = argument.string, values.contains(text) else {
                throw RequestParameters.invalid("\(attribute) requires one of: " + values.joined(separator: ", "))
            }
            return text as CFString
        case .elementReferences: throw Self.unsupportedReferences(attribute)
        case let .live(kinds, _):
            let kind: AXArgumentKind
            if let current = try read() {
                guard let observed = AXArgumentKind.observed(current), kinds.contains(observed) else {
                    throw NativeFailure(code: "UNSUPPORTED", message: "Accessibility \(attribute) value type is not supported for attribute-setting arguments")
                }
                kind = observed
            } else {
                switch argument {
                case .string: kind = .string
                case .bool: kind = .boolean
                case .number: kind = .number
                default: throw NativeFailure(code: "UNSUPPORTED", message: "Accessibility \(attribute) has no known value type for this JSON argument")
                }
                guard kinds.contains(kind) else { throw RequestParameters.invalid("\(attribute) does not accept this argument type") }
            }
            return try kind.encode(argument, attribute: attribute)
        }
    }
}
