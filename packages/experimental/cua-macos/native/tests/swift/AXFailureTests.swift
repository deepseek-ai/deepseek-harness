// Optional control values do not hide permission, communication or discovery failures.
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

@Test func optionalMetadataFailuresDoNotHideStructuralOrPermissionFailures() {
    for name in ["AXValue", "AXTitle", "AXDescription", "AXIdentifier", "AXPlaceholderValue", "AXSubrole",
                 "AXEnabled", "AXPosition", "AXSize", "AXMain", "AXMinimized"] {
        #expect(AXAccess.optionalAttributeUnavailable(.failure, attribute: name))
    }
    for name in ["AXChildren", "AXWindows", "AXFocusedWindow", "AXRole", "AXParent"] {
        #expect(!AXAccess.optionalAttributeUnavailable(.failure, attribute: name))
    }
    for error in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        #expect(!AXAccess.optionalAttributeUnavailable(error, attribute: "AXValue"))
    }
}

@Test func unavailableActionMetadataDoesNotInterruptObservation() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    #expect(try access.actionNames(nil, error: .failure, requireKnown: false).isEmpty)
    #expect(throws: NativeFailure.self) { try access.actionNames(nil, error: .failure, requireKnown: true) }
    for strict in [false, true] {
        #expect(try access.actionNames(nil, error: .actionUnsupported, requireKnown: strict).isEmpty)
        for error in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
            #expect(throws: NativeFailure.self) { try access.actionNames(nil, error: error, requireKnown: strict) }
        }
    }
}

@Test func listingSkipsOnlyTheAttributeWhoseWritabilityIsUnknown() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    let writable = try AXAccess.writableAttributeNames(["AXValue", "AXFocused"]) { name in
        try access.attributeWritability(true, error: name == "AXValue" ? .failure : .success, name: name, forDiscovery: true)
    }
    #expect(writable == ["AXFocused"])
    #expect(throws: NativeFailure.self) { try access.attributeWritability(false, error: .failure, name: "AXValue", forDiscovery: false) }
    #expect(throws: NativeFailure.self) { try access.attributeWritability(false, error: .apiDisabled, name: "AXValue", forDiscovery: true) }
}

private func wrappedAXError(_ code: AXError) throws -> AXValue {
    var error = code
    return try #require(AXValueCreate(.axError, &error))
}

@Test func batchValuesRetainScalarArrayAndGeometryTypes() throws {
    var point = CGPoint(x: 20, y: 40)
    let position = try #require(AXValueCreate(.cgPoint, &point))
    let values: [CFTypeRef] = ["Title" as CFString, kCFBooleanTrue, NSNumber(value: 7), [] as CFArray, position]
    for value in values {
        let decoded = try #require(try AXAccess.batchAttribute(value, name: "AXValue"))
        #expect(CFGetTypeID(decoded) == CFGetTypeID(value))
        #expect(CFEqual(decoded, value))
    }
    #expect(try AXAccess.batchAttribute(NSNull(), name: "AXValue") == nil)
}

@Test func batchUnavailableValuesKeepIndividualAttributeRules() throws {
    for error in [AXError.attributeUnsupported, .noValue, .notImplemented] {
        #expect(try AXAccess.batchAttribute(wrappedAXError(error), name: "AXChildren") == nil)
    }
    #expect(try AXAccess.batchAttribute(wrappedAXError(.failure), name: "AXTitle") == nil)
    #expect(throws: NativeFailure.self) {
        try AXAccess.batchAttribute(wrappedAXError(.failure), name: "AXChildren")
    }
}

@Test func batchFailuresPreservePermissionCommunicationAndStaleElementErrors() throws {
    for code in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        let value = try wrappedAXError(code)
        do {
            _ = try AXAccess.batchAttribute(value, name: "AXTitle")
            Issue.record("Batch attribute accepted an accessibility failure")
        } catch let error as NativeFailure {
            #expect(error.code == (code == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR"))
            #expect(error.attribute == "AXTitle")
            #expect(error.accessibilityError == code.rawValue)
            #expect(error.message.contains("AXTitle"))
            #expect(error.message.contains(String(code.rawValue)))
        }
    }
}

@Test func observationFailuresPreserveNativeDetailsWithoutReclassifyingInputOrStaleSnapshots() {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    for (error, attribute) in [(AXError.invalidUIElement, "AXRole"), (.cannotComplete, "AXChildren")] {
        let original = access.failure(error, "read \(attribute)", attribute: attribute)
        #expect(original.code == "NATIVE_ERROR")
        let observed = AXWorker.observationFailure(original)
        #expect(observed.code == "AX_OBSERVATION_UNAVAILABLE")
        #expect(observed.message.contains("read \(attribute) failed with error \(error.rawValue)"))
        #expect(observed.accessibilityError == error.rawValue)
        #expect(observed.attribute == attribute)
    }
    for code in [AXError.apiDisabled, .failure, .illegalArgument] {
        let original = access.failure(code, "read AXRole")
        let observed = AXWorker.observationFailure(original)
        #expect(observed.code == original.code)
        #expect(observed.message == original.message)
        #expect(observed.accessibilityError == code.rawValue)
    }
    for other in [NativeFailure(code: "NATIVE_ERROR", message: "Unrelated failure with -25202 in text"),
                  NativeFailure(code: "STALE_SNAPSHOT", message: "Snapshot expired; read fresh getAccessibilityTree")] {
        #expect(AXWorker.observationFailure(other).code == other.code)
        #expect(AXWorker.observationFailure(other).message == other.message)
    }
}

@Test func batchRejectsSuccessEncodedAsAnAttributeError() throws {
    let value = try wrappedAXError(.success)
    #expect(throws: NativeFailure.self) {
        try AXAccess.batchAttribute(value, name: "AXTitle")
    }
}

@Test func nodeRoleAndMetadataUseTheSameBatchWithoutFallbackReads() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    let observation = try access.nodeObservation(attributes: ["AXRole": "AXWindow" as CFString, "AXTitle": "Window" as CFString]) { name in
        Issue.record("Unexpected fallback read: \(name)")
        return nil
    }
    let (role, attribute) = (observation.role, observation.attribute)
    #expect(role == "AXWindow")
    #expect(CFEqual(try #require(try attribute("AXTitle")), "Window" as CFString))
}

@Test(arguments: ["AXGroup", "AXScrollArea"])
func containersRetainTheirOwnMetadata(role: String) throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    let observation = try access.nodeObservation(attributes: ["AXRole": role as CFString, "AXTitle": "Results" as CFString]) { _ in nil }
    #expect(observation.role == role)
    #expect(CFEqual(try #require(try observation.attribute("AXTitle")), "Results" as CFString))
}

@Test(arguments: ["AXGroup", "AXScrollArea"])
func consumedContainerMetadataPreservesStaleAndCommunicationErrors(role: String) throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    for error in [AXError.invalidUIElement, .cannotComplete] {
        let observation = try access.nodeObservation(attributes: ["AXRole": role as CFString, "AXTitle": try wrappedAXError(error)]) { _ in nil }
        #expect(throws: NativeFailure.self) { try observation.attribute("AXTitle") }
    }
}

@Test func ordinaryNodeFallbackRetainsIndividualAttributeReads() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    var reads: [String] = []
    let observation = try access.nodeObservation(attributes: nil) { name in
        reads.append(name)
        return name == "AXRole" ? "AXButton" as CFString : "Title" as CFString
    }
    let (role, attribute) = (observation.role, observation.attribute)
    #expect(role == "AXButton")
    #expect(reads == ["AXRole"])
    #expect(CFEqual(try #require(try attribute("AXTitle")), "Title" as CFString))
    #expect(reads == ["AXRole", "AXTitle"])
}

@Test func nodeRoleAbsenceAndTypeErrorsRetainTheirMeaning() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    for missing in [NSNull() as CFTypeRef, try wrappedAXError(.noValue)] {
        let observation = try access.nodeObservation(attributes: ["AXRole": missing]) { _ in nil }
        #expect(observation.role == "AXUnknown")
    }
    do {
        _ = try access.nodeObservation(attributes: ["AXRole": kCFBooleanTrue]) { _ in nil }
        Issue.record("Non-string role was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "NATIVE_ERROR")
        #expect(error.message == "Accessibility AXRole is not a string")
    }
}

@Test func nodeRoleAndContainerChildrenRetainStructuralFailures() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    for name in ["AXRole", "AXChildren"] {
        for code in [AXError.invalidUIElement, .cannotComplete, .apiDisabled, .failure] {
            var attributes: [String: CFTypeRef] = ["AXRole": "AXGroup" as CFString, "AXChildren": [] as CFArray]
            attributes[name] = try wrappedAXError(code)
            do {
                let observation = try access.nodeObservation(attributes: attributes) { _ in nil }
                _ = try observation.attribute("AXChildren")
                Issue.record("Structural node error was ignored")
            } catch let error as NativeFailure {
                #expect(error.accessibilityError == code.rawValue)
                #expect(error.code == (code == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR"))
                if code == .invalidUIElement { #expect(AXWorker.observationFailure(error).code == "AX_OBSERVATION_UNAVAILABLE") }
            }
        }
    }
    #expect(throws: NativeFailure.self) {
        try access.nodeObservation(attributes: ["AXRole": "AXGroup" as CFString, "AXChildren": try wrappedAXError(.illegalArgument)]) { _ in nil }.attribute("AXChildren")
    }
}

@Test(arguments: ["AXValue", "AXSelectedTextRange"])
func observationRetainsUnknownWritabilityAndFollowingNodes(failedAttribute: String) throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    var lines: [String] = []
    for title in ["Affected control", "Following control"] {
        let writable = try AXAccess.observationWritability(role: "AXTextField") { name, discovery in
            try access.attributeWritability(true, error: title == "Affected control" && name == failedAttribute ? .failure : .success,
                                           name: name, forDiscovery: discovery)
        }
        let node = AXTextNode(index: nil, role: "AXTextField", title: title, value: "Text", description: nil,
                              actions: [], enabled: true, valueWritable: writable.value, selectionWritable: writable.selection,
                              selected: nil, selectedRange: nil, selectedText: nil)
        lines.append(AXTextFormatter.line(node, level: 0))
    }
    let unknown = failedAttribute == "AXValue" ? "valueWritable" : "selectionWritable"
    #expect(lines[0].contains("\(unknown)=unknown"))
    #expect(!lines[0].contains("\(unknown)=true"))
    #expect(lines[0].contains("Affected control"))
    #expect(lines[1].contains("Following control"))
    #expect(lines[1].contains("valueWritable=true selectionWritable=true"))
    do {
        _ = try access.attributeWritability(true, error: .failure, name: failedAttribute, forDiscovery: false)
        Issue.record("Mutation admitted unknown writability")
    } catch let error as NativeFailure {
        #expect(error.accessibilityError == -25200)
        #expect(error.code == "NATIVE_ERROR")
    }
}

@Test(arguments: ["AXValue", "AXSelectedTextRange"])
func observationWritabilityPreservesPermissionCommunicationAndInvalidElementErrors(attribute: String) {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    for code in [AXError.apiDisabled, .cannotComplete, .invalidUIElement, .illegalArgument] {
        do {
            _ = try AXAccess.observationWritability(role: "AXTextField") { name, discovery in
                try access.attributeWritability(true, error: name == attribute ? code : .success, name: name, forDiscovery: discovery)
            }
            Issue.record("Observation hid an actionable AX error")
        } catch let error as NativeFailure {
            #expect(error.accessibilityError == code.rawValue)
            #expect(error.code == (code == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR"))
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}
