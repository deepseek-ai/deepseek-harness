// JSON schema and Core Foundation encoding for macOS accessibility setter arguments.
import ApplicationServices
import Foundation

enum AXArgumentKind: Sendable {
    case string, boolean, number, point, size, range, ranges

    private static let pointFields = AXFieldPair(
        first: ("x", "A finite x coordinate."), second: ("y", "A finite y coordinate."), parse: finite)
    private static let sizeFields = AXFieldPair(
        first: ("width", "A nonnegative finite width."), second: ("height", "A nonnegative finite height."), parse: dimension)
    private static let rangeFieldDescription = "A nonnegative integer no greater than \(Int.max)."
    private static let rangeFields = AXFieldPair(
        first: ("location", rangeFieldDescription), second: ("length", rangeFieldDescription),
        description: "The sum of location and length must be no greater than \(Int.max).", parse: nonnegativeInteger)

    var schema: JSONValue {
        switch self {
        case .string: return SchemaBuilder.scalar("string")
        case .boolean: return SchemaBuilder.scalar("boolean")
        case .number: return SchemaBuilder.scalar("number", description: "A finite number.")
        case .point: return Self.pointFields.schema
        case .size: return Self.sizeFields.schema
        case .range: return Self.rangeFields.schema
        case .ranges: return .object(["type": .string("array"), "items": Self.rangeFields.schema])
        }
    }

    /// Convert a direct JSON argument to this AX value type before sending it to the element.
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
            let (x, y) = try Self.pointFields.decode(argument, attribute: attribute)
            var point = CGPoint(x: x, y: y)
            guard let value = AXValueCreate(.cgPoint, &point) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        case .size:
            let (width, height) = try Self.sizeFields.decode(argument, attribute: attribute)
            var size = CGSize(width: width, height: height)
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
        let (location, length) = try rangeFields.decode(argument, attribute: attribute)
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

/// Two required numeric fields with a shared scalar parser; the names also define the JSON object schema.
private struct AXFieldPair<Value>: Sendable {
    let first: (name: String, description: String)
    let second: (name: String, description: String)
    var description: String? = nil
    let parse: @Sendable (JSONValue?, String, String) throws -> Value

    var schema: JSONValue {
        SchemaBuilder.object([
            first.name: SchemaBuilder.scalar("number", description: first.description),
            second.name: SchemaBuilder.scalar("number", description: second.description),
        ], required: [first.name, second.name], description: description)
    }

    func decode(_ argument: JSONValue, attribute: String) throws -> (Value, Value) {
        guard case .object(let fields) = argument, fields.count == 2,
              let a = fields[first.name], let b = fields[second.name] else {
            throw RequestParameters.invalid("\(attribute) requires exactly \([first.name, second.name].sorted().joined(separator: ", "))")
        }
        return try (parse(a, first.name, attribute), parse(b, second.name, attribute))
    }
}
