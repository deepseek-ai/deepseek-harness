// Wire validation and nullable observations do not require desktop access.
import Foundation
import Testing
@testable import CuaNative

@Test func preservesJSONKindsAndNulls() throws {
    let value = JSONValue.object([
        "missing": .null,
        "flags": .array([.bool(true), .bool(false)]),
        "number": .number(1),
        "text": .string("中文 🧪"),
    ])
    let encoded = try JSONEncoder().encode(value)
    #expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == value)
    #expect(value["absent"] == .null)
    #expect(value["flags"].number == nil)
    #expect(value["number"].string == nil)
}

@Test(arguments: [
    "{}", "[]", "null", "true",
    #"{"id":7,"method":"listApps","params":{}}"#,
    #"{"id":"a","method":null,"params":{}}"#,
    #"{"id":"a","method":"listApps"}"#,
    #"{"id":"a","method":"listApps","params":{},"extra":true}"#,
    #"{"id":"a","id":"b","method":"listApps","params":{}}"#,
    #"{"id":"a","method":"listApps","params":{},"params":{}}"#,
])
func refusesInvalidRequestEnvelopes(_ source: String) {
    #expect(throws: NativeFailure.self) {
        try NativeRequest(data: Data(source.utf8))
    }
}

@Test func retainsTheRequestIDForMethodLevelParameterErrors() throws {
    let request = try NativeRequest(data: Data(#"{"id":"call-7","method":"listApps","params":[]}"#.utf8))
    #expect(request.id == "call-7")
    #expect(request.method == "listApps")
    #expect(request.params == .array([]))
}

@Test func emitsUnknownWindowSpaceAsExplicitNull() throws {
    let window = WindowInfo(
        windowID: 7, pid: 42, appName: "Fixture", title: "Canvas",
        bounds: WindowBounds(x: -100, y: 40, width: 320, height: 200),
        isOnScreen: true, onCurrentSpace: nil
    )
    let encoded = try JSONEncoder().encode(window.json)
    let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(object["onCurrentSpace"] is NSNull)
    #expect(window.json["windowId"] == .number(7))
    #expect(window.json["bounds"]["x"] == .number(-100))
    #expect(window.json["isOnScreen"] == .bool(true))
}

@Test func separatesUnsupportedMethodsFromInvalidParameters() throws {
    let unsupported = try NativeRequest(data: Data(#"{"id":"call","method":"absent","params":{}}"#.utf8))
    do {
        _ = try RequestParameters(unsupported)
        Issue.record("Unsupported operation was admitted")
    } catch let error as NativeFailure {
        #expect(error.code == "UNSUPPORTED")
    }
    for source in [
        #"{"id":"call","method":"listApps","params":[]}"#,
        #"{"id":"call","method":"listApps","params":{"launch":true}}"#,
    ] {
        do {
            _ = try RequestParameters(NativeRequest(data: Data(source.utf8)))
            Issue.record("Invalid operation parameters were admitted")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT")
        }
    }
}

@Test(arguments: ["true", "1.5", "0", "4294967296", "\"7\""])
func rejectsInvalidWindowIDs(_ value: String) throws {
    let request = try NativeRequest(data: Data("{\"id\":\"call\",\"method\":\"screenshot\",\"params\":{\"windowId\":\(value)}}".utf8))
    let params = try RequestParameters(request)
    #expect(throws: NativeFailure.self) { try params.windowID() }
}

@Test func rejectsRoundedIntegerOverflowWithoutTrapping() throws {
    let request = try NativeRequest(data: Data(#"{"id":"call","method":"click","params":{"elementIndex":9223372036854775808}}"#.utf8))
    let params = try RequestParameters(request)
    #expect(throws: NativeFailure.self) { try params.integer("elementIndex", in: 0...Int.max) }
}

@Test func nestedSeparatorsAndEscapedQuotesDoNotChangeEnvelopeFieldCount() throws {
    let request = try NativeRequest(data: Data(#"{"id":"call","method":"typeText","params":{"text":"comma, quote\" braces{}[] slash\\","nested":[1,{"x":2,"y":3}]}}"#.utf8))
    #expect(request.id == "call")
    #expect(request.params["nested"] == .array([.number(1), .object(["x": .number(2), "y": .number(3)])]))
}

@Test func resolvesTextEventIntervalFromHelperArguments() throws {
    #expect(try HelperConfiguration(arguments: []).textEventIntervalSeconds == 0.00025)
    #expect(try HelperConfiguration(arguments: ["--text-event-interval-ms", "0.5"]).textEventIntervalSeconds == 0.0005)
    #expect(try HelperConfiguration(arguments: ["--text-event-interval-ms", "0"]).textEventIntervalSeconds == 0)
    #expect(try HelperConfiguration(arguments: ["--text-event-interval-ms", "1000"]).textEventIntervalSeconds == 1)
    for invalid in ["-1", "1000.1", "nan", "inf", "absent"] {
        #expect(throws: NativeFailure.self) {
            try HelperConfiguration(arguments: ["--text-event-interval-ms", invalid])
        }
    }
}

@Test func disclosureFlagsRejectNonBooleanWireValues() throws {
    for source in ["true", "false"] {
        let params = try RequestParameters(NativeRequest(data: Data("{\"id\":\"read\",\"method\":\"getState\",\"params\":{\"details\":\(source)}}".utf8)))
        #expect(try params.optionalBoolean("details") == (source == "true"))
        #expect(try params.optionalBoolean("includeMenus") == nil)
    }
    for source in ["1", "null", "\"true\""] {
        let params = try RequestParameters(NativeRequest(data: Data("{\"id\":\"read\",\"method\":\"getState\",\"params\":{\"includeMenus\":\(source)}}".utf8)))
        #expect(throws: NativeFailure.self) { try params.optionalBoolean("includeMenus") }
    }
}

@Test(arguments: ["null", "true", "[1]", "[\"\"]"])
func rejectsMalformedApplicationIconPaths(_ value: String) throws {
    let request = try NativeRequest(data: Data("{\"id\":\"icons\",\"method\":\"applicationIcons\",\"params\":{\"paths\":\(value)}}".utf8))
    #expect(throws: NativeFailure.self) { try RequestParameters(request).strings("paths") }
}
