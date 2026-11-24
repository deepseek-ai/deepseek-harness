// Action schemas describe basic types; conversion enforces action-specific value constraints.
import ApplicationServices
import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

private let nullArgument: JSONValue = .object([
    "type": .string("null"),
    "description": .string("This action accepts no argument; omit argument or pass null."),
])
private let argumentRequired: JSONValue = .array([.string("argument")])
private let finiteNumber: JSONValue = .object(["type": .string("number"), "description": .string("A finite number.")])
private let pointSchema: JSONValue = .object([
    "type": .string("object"),
    "properties": .object([
        "x": .object(["type": .string("number"), "description": .string("A finite x coordinate.")]),
        "y": .object(["type": .string("number"), "description": .string("A finite y coordinate.")]),
    ]),
    "required": .array([.string("x"), .string("y")]),
    "additionalProperties": .bool(false),
])
private let sizeSchema: JSONValue = .object([
    "type": .string("object"),
    "properties": .object([
        "width": .object(["type": .string("number"), "description": .string("A nonnegative finite width.")]),
        "height": .object(["type": .string("number"), "description": .string("A nonnegative finite height.")]),
    ]),
    "required": .array([.string("width"), .string("height")]),
    "additionalProperties": .bool(false),
])
private let rangeField: JSONValue = .object([
    "type": .string("number"),
    "description": .string("A nonnegative integer no greater than \(Int.max)."),
])
private let rangeSchema: JSONValue = .object([
    "type": .string("object"),
    "properties": .object(["location": rangeField, "length": rangeField]),
    "required": .array([.string("location"), .string("length")]),
    "additionalProperties": .bool(false),
    "description": .string("The sum of location and length must be no greater than \(Int.max)."),
])
private let unsupportedKinds: JSONValue = .object([
    "oneOf": .array([
        .object(["type": .string("string")]),
        .object(["type": .string("boolean")]),
        finiteNumber,
        pointSchema, sizeSchema, rangeSchema,
    ]),
    "description": .string("The accepted value type depends on the element's live attribute value type."),
])

private func argumentSchema(_ action: String) throws -> JSONValue {
    let schema = try ActionSchema.parameter(action: action)
    return schema["properties"]["argument"]
}

@Test(arguments: ["AXPress", "AXShowMenu", "AXTextArea.AXValue.set", "AXTextArea.AXValue.Set.Extra"])
func plainActionsAcceptOnlyAnAbsentArgument(action: String) throws {
    let expected: JSONValue = .object([
        "type": .string("object"),
        "properties": .object(["argument": nullArgument]),
        "required": .array([]),
        "additionalProperties": .bool(false),
    ])
    let actual = try ActionSchema.parameter(action: action)
    #expect(actual == expected)
}

@Test func attributeSettersRequireTheArgument() throws {
    for action in ["AXTextArea.AXValue.Set", "AXWindow.AXPosition.Set", "AXButton.AXFocused.Set"] {
        let required = try ActionSchema.parameter(action: action)["required"]
        #expect(required == argumentRequired)
    }
}

@Test func knownAttributesNameTheirDirectValueType() throws {
    let position = try argumentSchema("AXWindow.AXPosition.Set")
    let size = try argumentSchema("AXWindow.AXSize.Set")
    let range = try argumentSchema("AXTextArea.AXSelectedTextRange.Set")
    for (actual, expected) in [(position, pointSchema), (size, sizeSchema), (range, rangeSchema)] {
        for key in ["type", "properties", "required", "additionalProperties"] { #expect(actual[key] == expected[key]) }
    }
    #expect(position["description"].string?.contains("screen") == true)
    #expect(size["description"].string?.contains("points") == true)
    #expect(range["description"].string?.contains("UTF-16") == true)
}

@Test func standardSettersIdentifyTheirArgumentWithoutAControl() throws {
    for attribute in ["AXMain", "AXMinimized", "AXSelected", "AXExpanded"] {
        #expect(try argumentSchema("AXWindow.\(attribute).Set")["type"] == .string("boolean"))
    }
    let focus = try argumentSchema("AXButton.AXFocused.Set")
    #expect(focus["type"] == .string("boolean"))
    #expect(focus["description"].string?.contains("true") == true)
    for attribute in ["AXTitle", "AXSelectedText"] {
        #expect(try argumentSchema("AXTextField.\(attribute).Set")["type"] == .string("string"))
    }
    #expect(try argumentSchema("AXTextField.AXVisibleCharacterRange.Set")["properties"] == rangeSchema["properties"])
    for role in ["AXSlider", "AXIncrementor"] {
        let argument = try argumentSchema("\(role).AXValue.Set")
        #expect(argument["oneOf"] == .array([finiteNumber, .object(["type": .string("string")])]))
    }
}

@Test func unknownAttributesAcceptEverySupportedKind() throws {
    for action in ["AXGroup.AXValue.Set", "AXGroup.AXCustomValue.Set"] {
        let argument = try argumentSchema(action)
        #expect(argument == unsupportedKinds)
    }
}

@Test func attributeAlternativesFormDisjointOneOfBranches() throws {
    let union = try argumentSchema("AXGroup.AXValue.Set")["oneOf"]
    guard case .array(let alternatives) = union else {
        Issue.record("Attribute argument schema is not a oneOf union")
        return
    }
    #expect(alternatives.count == 6)
    var scalarTypes: Set<String> = []
    var objectFields: Set<[String]> = []
    for alternative in alternatives {
        if alternative["type"] == .string("object") {
            #expect(alternative["additionalProperties"] == .bool(false))
            guard case .array(let required) = alternative["required"] else {
                Issue.record("Object alternative has no required fields")
                continue
            }
            // Each object alternative requires its own field names.
            objectFields.insert(required.compactMap { $0.string })
        } else if let type = alternative["type"].string {
            // Each scalar alternative declares a distinct type.
            scalarTypes.insert(type)
        } else {
            Issue.record("Alternative has no declared type")
        }
    }
    let expectedScalarTypes: Set<String> = ["string", "boolean", "number"]
    let expectedObjectFields: Set<[String]> = [["x", "y"], ["width", "height"], ["location", "length"]]
    #expect(scalarTypes == expectedScalarTypes)
    #expect(objectFields == expectedObjectFields)
}

@Test func rejectsAnEmptyActionName() {
    do {
        _ = try ActionSchema.parameter(action: "")
        Issue.record("Empty action name produced a schema")
    } catch let error as NativeFailure {
        #expect(error.code == "INVALID_ARGUMENT")
    } catch { Issue.record("Unexpected error: \(error)") }
}

@Test func advertisedKindsMatchValuesTheConverterAccepts() throws {
    var point = CGPoint(x: 1, y: 2)
    var size = CGSize(width: 3, height: 4)
    var range = CFRange(location: 1, length: 2)
    let pointValue = try #require(AXValueCreate(.cgPoint, &point))
    let sizeValue = try #require(AXValueCreate(.cgSize, &size))
    let rangeValue = try #require(AXValueCreate(.cfRange, &range))
    let accepted: [(attribute: String, current: CFTypeRef?, value: JSONValue)] = [
        ("AXPosition", nil, .object(["x": .number(1), "y": .number(2)])),
        ("AXSize", nil, .object(["width": .number(3), "height": .number(4)])),
        ("AXSelectedTextRange", nil, .object(["location": .number(1), "length": .number(2)])),
        ("AXValue", "text" as CFString, .string("text")),
        ("AXValue", kCFBooleanTrue!, .bool(true)),
        ("AXValue", NSNumber(value: 1.5), .number(1.5)),
        ("AXValue", pointValue, .object(["x": .number(1), "y": .number(2)])),
        ("AXValue", sizeValue, .object(["width": .number(3), "height": .number(4)])),
        ("AXValue", rangeValue, .object(["location": .number(1), "length": .number(2)])),
    ]
    for entry in accepted {
        _ = try encodedAttribute(attribute: entry.attribute, argument: entry.value, current: entry.current)
    }
}

@Test func conversionRetainsValueAndFieldValidation() {
    let rejected: [(attribute: String, current: CFTypeRef?, value: JSONValue)] = [
        ("AXPosition", nil, .object(["x": .number(1)])),
        ("AXPosition", nil, .object(["x": .number(1), "y": .number(2), "z": .number(3)])),
        ("AXSize", nil, .object(["width": .number(-1), "height": .number(1)])),
        ("AXSelectedTextRange", nil, .object(["location": .number(1.5), "length": .number(1)])),
        ("AXSelectedTextRange", nil, .object(["location": .number(Double(Int.max)), "length": .number(0)])),
        ("AXValue", "text" as CFString, .bool(true)),
        ("AXValue", kCFBooleanTrue!, .string("text")),
    ]
    for entry in rejected {
        do {
            _ = try encodedAttribute(attribute: entry.attribute, argument: entry.value, current: entry.current)
            Issue.record("\(entry.attribute) accepted \(entry.value)")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT" || error.code == "UNSUPPORTED")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}

@Test func rangeDescribesNumberFieldsWithoutHardConstraints() throws {
    let properties = try argumentSchema("AXTextArea.AXSelectedTextRange.Set")["properties"]
    #expect(properties["location"] == rangeField)
    #expect(properties["length"] == rangeField)
    _ = try encodedAttribute(attribute: "AXSelectedTextRange",
        argument: .object(["location": .number(Double(Int.max) - 1024), "length": .number(0)]), current: nil)
}

@Test func leavesTheCuaEnvelopeUndescribed() throws {
    for action in ["AXPress", "AXTextArea.AXValue.Set", "AXWindow.AXPosition.Set"] {
        let schema = try ActionSchema.parameter(action: action)
        #expect(schema["description"] == .null)
    }
}

/// Fails the calling test on any desktop session-state read; the locked fallback also fails permission resolution.
private func failOnSessionRead() -> @Sendable () -> Bool? {
    return {
        Issue.record("getActionSchema read the desktop session state")
        return true
    }
}

@Test func returnsTheSchemaWithoutAnApplicationOrAccessibilityRead() async throws {
    // Any session, app, window or AX resolution fails before returning a schema.
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: failOnSessionRead())
    let request = try NativeRequest(data: JSONEncoder().encode(JSONValue.object([
        "id": .string("schema"), "method": .string("getActionSchema"),
        "params": .object(["action": .string("AXWindow.AXPosition.Set")]),
    ])))
    let outcome = try await worker.execute("getActionSchema", deadline: .now + .seconds(30), params: RequestParameters(request),
                                           catalog: ApplicationCatalogSnapshot(applications: [], frontPID: nil))
    guard case .result(let schema) = outcome else {
        throw NativeFailure(code: "TEST", message: "Expected an action schema")
    }
    let expected = try ActionSchema.parameter(action: "AXWindow.AXPosition.Set")
    #expect(schema == expected)
}

@Test func rejectsAnEmptyActionNameBeforeResolvingNativeState() async throws {
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: failOnSessionRead())
    let request = try NativeRequest(data: JSONEncoder().encode(JSONValue.object([
        "id": .string("schema"), "method": .string("getActionSchema"),
        "params": .object(["action": .string("")]),
    ])))
    do {
        _ = try await worker.execute("getActionSchema", deadline: .now + .seconds(30), params: RequestParameters(request),
                                     catalog: ApplicationCatalogSnapshot(applications: [], frontPID: nil))
        Issue.record("Empty action name produced a schema")
    } catch let error as NativeFailure {
        #expect(error.code == "INVALID_ARGUMENT")
    } catch { Issue.record("Unexpected error: \(error)") }
}
