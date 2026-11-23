// Exercise the name-only query and live argument binding for every registered setter.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

private let cursor: JSONValue = .object(["location": .number(2), "length": .number(0)])

@Test func eachStandardAttributeUsesItsDeclaredArgumentForDiscoverySchemaAndBinding() throws {
    let point: JSONValue = .object(["x": .number(-10), "y": .number(20)])
    let size: JSONValue = .object(["width": .number(0), "height": .number(40)])
    let groups: [([String], String, JSONValue)] = [
        (["AXFocused", "AXMain", "AXMinimized", "AXExpanded", "AXSelected", "AXDisclosing",
          "AXElementBusy", "AXEnabled", "AXFrontmost", "AXHidden"], "boolean", .bool(true)),
        (["AXTitle", "AXSelectedText"], "string", .string("text")),
        (["AXPosition"], "object", point), (["AXSize"], "object", size),
        (["AXVisibleCharacterRange", "AXSelectedTextRange"], "object", cursor),
        (["AXSelectedTextRanges"], "array", .array([cursor])),
        (["AXOrientation"], "string", .string("AXHorizontalOrientation")),
        (["AXSortDirection"], "string", .string("AXDescendingSortDirection")),
    ]
    let refs = ["AXFocusedUIElement", "AXFocusedWindow", "AXMainWindow", "AXSelectedChildren", "AXSelectedRows", "AXSelectedColumns", "AXSelectedCells"]
    #expect(Set(groups.flatMap { $0.0 } + refs) == Set(AXSetterParameter.attributes.keys))
    func noRead() -> CFTypeRef? { Issue.record("Read a live value for a name-defined parameter"); return nil }
    for (attributes, type, value) in groups {
        for attribute in attributes {
            let parameter = AXSetterParameter.resolve(role: "AXGroup", attribute: attribute)
            #expect(try parameter.canList(attribute: attribute, read: noRead))
            let schema = try ActionSchema.parameter(action: "AXGroup.\(attribute).Set")
            #expect(schema["required"] == .array([.string("argument")]))
            #expect(schema["properties"]["argument"]["type"] == .string(type))
            _ = try parameter.encode(value, attribute: attribute, read: noRead)
            #expect(throws: NativeFailure.self) { try parameter.encode(.null, attribute: attribute, read: noRead) }
        }
    }
    for attribute in refs {
        let parameter = AXSetterParameter.resolve(role: "AXTable", attribute: attribute)
        #expect(try !parameter.canList(attribute: attribute, read: noRead))
        #expect(throws: NativeFailure.self) { try ActionSchema.parameter(action: "AXTable.\(attribute).Set") }
        #expect(throws: NativeFailure.self) { try parameter.encode(.string("0"), attribute: attribute, read: noRead) }
    }
}

@Test func exactValuesAreCheckedBeforeDispatch() throws {
    let focus = AXSetterParameter.resolve(role: "AXButton", attribute: "AXFocused")
    #expect(throws: NativeFailure.self) { try focus.encode(.bool(false), attribute: "AXFocused") { nil } }
    for (attribute, accepted) in [("AXOrientation", ["AXHorizontalOrientation", "AXVerticalOrientation", "AXUnknownOrientation"]),
                                  ("AXSortDirection", ["AXAscendingSortDirection", "AXDescendingSortDirection", "AXUnknownSortDirection"])] {
        let parameter = AXSetterParameter.resolve(role: "AXColumn", attribute: attribute)
        let schema = try parameter.schema(attribute: attribute)
        for value in accepted {
            #expect(schema["description"].string?.contains(value) == true)
            let result = try parameter.encode(.string(value), attribute: attribute) { nil }
            #expect(result as? String == value)
            #expect(throws: NativeFailure.self) { try parameter.encode(.string(value.lowercased()), attribute: attribute) { nil } }
        }
    }
}

@Test func roleDependentValuesRespectTheObservedTypeAndStatelessAlternatives() throws {
    let roles = [
        (["AXTextField", "AXTextArea", "AXComboBox", "AXStaticText"], ["string"]),
        (["AXSlider", "AXIncrementor", "AXStepper"], ["number", "string"]),
        (["AXCheckBox", "AXRadioButton"], ["boolean", "number"]),
        (["AXProgressIndicator"], ["number"]),
    ]
    #expect(Set(roles.flatMap { $0.0 }) == Set(AXSetterParameter.valueRoles.keys))
    let samples: [(String, JSONValue, CFTypeRef)] = [("number", .number(4), NSNumber(value: 4)),
        ("boolean", .bool(true), kCFBooleanTrue!), ("string", .string("four"), "four" as CFString)]
    for (roleNames, types) in roles {
        for role in roleNames {
            let rule = AXSetterParameter.resolve(role: role, attribute: "AXValue")
            let schema = try ActionSchema.parameter(action: "\(role).AXValue.Set")["properties"]["argument"]
            let advertised: [String]
            if case .array(let alternatives) = schema["oneOf"] {
                advertised = try alternatives.map { try #require($0["type"].string) }
            } else {
                advertised = [try #require(schema["type"].string)]
            }
            #expect(advertised == types)
            for (type, argument, value) in samples {
                #expect(try rule.canList(attribute: "AXValue") { value } == types.contains(type))
                if types.contains(type) {
                    #expect(try CFEqual(rule.encode(argument, attribute: "AXValue") { value }, value))
                    #expect(try CFEqual(rule.encode(argument, attribute: "AXValue") { nil }, value))
                } else {
                    #expect(throws: NativeFailure.self) { try rule.encode(argument, attribute: "AXValue") { value } }
                    #expect(throws: NativeFailure.self) { try rule.encode(argument, attribute: "AXValue") { nil } }
                }
            }
        }
    }
}

@Test func selectionArraysEncodeEveryRangeAndRejectInvalidCombinations() throws {
    func span(_ start: Double, _ length: Double) -> JSONValue {
        .object(["location": .number(start), "length": .number(length)])
    }
    let p = AXSetterParameter.resolve(role: "AXTextArea", attribute: "AXSelectedTextRanges")
    let schema = try p.schema(attribute: "AXSelectedTextRanges")
    #expect(schema["items"]["required"] == .array([.string("location"), .string("length")]))
    let encoded = try p.encode(.array([span(0, 2), span(5, 1)]), attribute: "AXSelectedTextRanges") { nil }
    let values = try #require(encoded as? [AXValue])
    #expect(values.count == 2)
    for (value, range) in zip(values, [CFRange(location: 0, length: 2), CFRange(location: 5, length: 1)]) {
        var actual = CFRange()
        #expect(AXValueGetValue(value, .cfRange, &actual))
        #expect(actual.location == range.location && actual.length == range.length)
    }
    for invalid in [[], [span(-1, 0)], [span(0.5, 1)], [span(0, 2), span(1, 2)], [span(0, 2), span(2, 1)],
                    [span(4, 1), span(1, 1)], [cursor, span(4, 1)], [.object(["location": .number(0)])]] {
        #expect(throws: NativeFailure.self) { try p.encode(.array(invalid), attribute: "AXSelectedTextRanges") { nil } }
    }
}
