// JSON schema and Core Foundation encoding for macOS accessibility setter arguments.
import ApplicationServices
import Foundation

enum AXArgumentKind: Sendable {
    case string, boolean, number, point, size, range, ranges

    var schema: JSONValue {
        switch self {
        case .string: return SchemaBuilder.scalar("string")
        case .boolean: return SchemaBuilder.scalar("boolean")
        case .number: return SchemaBuilder.scalar("number", description: "A finite number.")
        case .point:
            return SchemaBuilder.object([
                "x": SchemaBuilder.scalar("number", description: "A finite x coordinate."),
                "y": SchemaBuilder.scalar("number", description: "A finite y coordinate."),
            ], required: ["x", "y"])
        case .size:
            return SchemaBuilder.object([
                "width": SchemaBuilder.scalar("number", description: "A nonnegative finite width."),
                "height": SchemaBuilder.scalar("number", description: "A nonnegative finite height."),
            ], required: ["width", "height"])
        case .ranges:
            return .object(["type": .string("array"), "items": Self.range.schema])
        case .range:
            return SchemaBuilder.object([
                "location": SchemaBuilder.scalar("number", description: "A nonnegative integer no greater than \(Int.max)."),
                "length": SchemaBuilder.scalar("number", description: "A nonnegative integer no greater than \(Int.max)."),
            ], required: ["location", "length"],
                description: "The sum of location and length must be no greater than \(Int.max).")
        }
    }

    /// Convert one direct JSON argument to the Core Foundation value expected by the attribute's live type.
    func encode(_ argument: JSONValue, attribute: String) throws -> CFTypeRef {
        switch self {
        case .string:
            guard case .string(let text) = argument else { throw RequestParameters.invalid("\(attribute) requires a string value") }
            return text as CFString
        case .boolean:
            guard case .bool(let flag) = argument else { throw RequestParameters.invalid("\(attribute) requires a boolean value") }
            return flag ? kCFBooleanTrue! : kCFBooleanFalse!
        case .number:
            guard case .number(let number) = argument, number.isFinite else {
                throw RequestParameters.invalid("\(attribute) requires a finite number")
            }
            return NSNumber(value: number)
        case .point:
            let values = try Self.fields(argument, attribute: attribute, keys: ["x", "y"])
            var point = CGPoint(x: try Self.finite(values["x"], name: "x", attribute: attribute),
                                y: try Self.finite(values["y"], name: "y", attribute: attribute))
            guard let value = AXValueCreate(.cgPoint, &point) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        case .size:
            let values = try Self.fields(argument, attribute: attribute, keys: ["width", "height"])
            var size = CGSize(width: try Self.dimension(values["width"], name: "width", attribute: attribute),
                              height: try Self.dimension(values["height"], name: "height", attribute: attribute))
            guard let value = AXValueCreate(.cgSize, &size) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        case .ranges:
            guard case .array(let items) = argument, !items.isEmpty else { throw RequestParameters.invalid("\(attribute) requires at least one text range") }
            var previousEnd: Int?
            let ranges: [AXValue] = try items.map { item in
                var range = try Self.textRange(item, attribute: attribute)
                guard items.count == 1 || range.length > 0, previousEnd.map({ $0 < range.location }) ?? true else {
                    throw RequestParameters.invalid("\(attribute) requires separate, ordered, nonempty ranges for multiple selections")
                }
                previousEnd = range.location + range.length
                return try Self.rangeValue(&range, attribute: attribute)
            }
            return ranges as CFArray
        case .range:
            var range = try Self.textRange(argument, attribute: attribute)
            return try Self.rangeValue(&range, attribute: attribute)
        }
    }
    private static func textRange(_ argument: JSONValue, attribute: String) throws -> CFRange {
        let values = try fields(argument, attribute: attribute, keys: ["location", "length"])
        let location = try nonnegativeInteger(values["location"], name: "location", attribute: attribute)
        let length = try nonnegativeInteger(values["length"], name: "length", attribute: attribute)
        guard location <= Int.max - length else { throw RequestParameters.invalid("\(attribute) range is too large") }
        return CFRange(location: location, length: length)
    }
    private static func rangeValue(_ range: inout CFRange, attribute: String) throws -> AXValue {
        guard let value = AXValueCreate(.cfRange, &range) else { throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)") }
        return value
    }

    static func observed(_ value: CFTypeRef) -> Self? {
        let type = CFGetTypeID(value)
        if type == CFStringGetTypeID() { return .string }
        if type == CFBooleanGetTypeID() { return .boolean }
        if type == CFNumberGetTypeID() { return .number }
        if type == AXValueGetTypeID() {
            switch AXValueGetType(unsafeDowncast(value, to: AXValue.self)) {
            case .cgPoint: return .point
            case .cgSize: return .size
            case .cfRange: return .range
            default: break
            }
        }
        return nil
    }
    private static func fields(_ argument: JSONValue, attribute: String, keys: Set<String>) throws -> [String: JSONValue] {
        guard case .object(let values) = argument, Set(values.keys) == keys else {
            throw RequestParameters.invalid("\(attribute) requires exactly \(keys.sorted().joined(separator: ", "))")
        }
        return values
    }
    private static func finite(_ value: JSONValue?, name: String, attribute: String) throws -> Double {
        guard let value, case .number(let number) = value, number.isFinite else {
            throw RequestParameters.invalid("\(attribute) \(name) must be a finite number")
        }
        return number
    }
    private static func dimension(_ value: JSONValue?, name: String, attribute: String) throws -> Double {
        let number = try finite(value, name: name, attribute: attribute)
        guard number >= 0 else { throw RequestParameters.invalid("\(attribute) \(name) must be nonnegative") }
        return number
    }
    private static func nonnegativeInteger(_ value: JSONValue?, name: String, attribute: String) throws -> Int {
        guard let value, case .number(let number) = value, number.isFinite,
              number.rounded(.towardZero) == number, number >= 0, number <= Double(Int.max),
              let integer = Int(exactly: number) else {
            throw RequestParameters.invalid("\(attribute) \(name) must be a nonnegative integer")
        }
        return integer
    }
}
