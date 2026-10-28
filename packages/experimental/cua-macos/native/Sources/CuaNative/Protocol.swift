// JSON values and immutable process/window data exchanged between helper executors.
import Foundation

indirect enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let flag = try? value.decode(Bool.self) { self = .bool(flag) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let text = try? value.decode(String.self) { self = .string(text) }
        else if let values = try? value.decode([JSONValue].self) { self = .array(values) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let flag): try value.encode(flag)
        case .number(let number): try value.encode(number)
        case .string(let text): try value.encode(text)
        case .array(let values): try value.encode(values)
        case .object(let values): try value.encode(values)
        }
    }

    var object: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }
    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
    var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }
    subscript(_ key: String) -> JSONValue { object?[key] ?? .null }
}

struct NativeFailure: Error, Sendable {
    let code: String
    let message: String
    let accessibilityError: Int32?

    init(code: String, message: String, accessibilityError: Int32? = nil) {
        self.code = code
        self.message = message
        self.accessibilityError = accessibilityError
    }
}

struct NativeRequest: Sendable {
    let id: String
    let method: String
    let params: JSONValue

    init(data: Data) throws {
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let object = decoded.object, Set(object.keys) == ["id", "method", "params"],
              Self.envelopeSeparatorCount(data) == 2,
              let id = object["id"]?.string, let method = object["method"]?.string,
              let params = object["params"] else {
            throw NativeFailure(code: "INVALID_REQUEST", message: "Expected exactly id, method and params")
        }
        self.id = id
        self.method = method
        self.params = params
    }

    // Foundation collapses repeated object keys. A validated three-field envelope
    // must have exactly two separators outside strings and nested values.
    private static func envelopeSeparatorCount(_ data: Data) -> Int {
        var depth = 0
        var quoted = false
        var escaped = false
        var separators = 0
        for byte in data {
            if quoted {
                if escaped { escaped = false }
                else if byte == 92 { escaped = true }
                else if byte == 34 { quoted = false }
                continue
            }
            switch byte {
            case 34: quoted = true
            case 123, 91: depth += 1
            case 125, 93: depth -= 1
            case 44: if depth == 1 { separators += 1 }
            default: break
            }
        }
        return separators
    }
}

struct ProcessIdentity: Equatable, Sendable {
    let pid: Int32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
}

struct WindowBounds: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var json: JSONValue {
        .object(["x": .number(x), "y": .number(y), "width": .number(width), "height": .number(height)])
    }
}

struct WindowRoute: Sendable {
    let owner: ProcessIdentity
    let windowID: UInt32
    let bounds: WindowBounds
}

struct WindowPoint: Sendable {
    let x: Double
    let y: Double
}

struct WindowInfo: Sendable {
    let windowID: UInt32
    let pid: Int32
    let appName: String
    let title: String
    let bounds: WindowBounds
    let isOnScreen: Bool
    let onCurrentSpace: Bool?

    var json: JSONValue {
        .object([
            "windowId": .number(Double(windowID)), "pid": .number(Double(pid)),
            "appName": .string(appName), "title": .string(title), "bounds": bounds.json,
            "isOnScreen": .bool(isOnScreen), "onCurrentSpace": onCurrentSpace.map(JSONValue.bool) ?? .null,
        ])
    }
}
