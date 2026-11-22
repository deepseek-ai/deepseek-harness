// Action listing includes attribute-setting operations.
import ApplicationServices
import Testing
@testable import CuaNative

@Test func appendsAttributeSettingActionsAfterNativeActions() throws {
    #expect(try AXAccess.listActionNames(actions: ["AXPress"], role: "AXTextArea",
                                          writableAttributes: ["AXValue", "AXSelectedTextRange"])
        == ["AXPress", "AXTextArea.AXValue.Set", "AXTextArea.AXSelectedTextRange.Set"])
}

@Test func omitsAttributeSettingActionsWithoutWritableAttributes() throws {
    #expect(try AXAccess.listActionNames(actions: ["AXPress"], role: nil, writableAttributes: []) == ["AXPress"])
}

@Test func rejectsWritableAttributesWithoutAnObservedRole() {
    let roles: [String?] = [nil, ""]
    for role in roles {
        do {
            _ = try AXAccess.listActionNames(actions: [], role: role, writableAttributes: ["AXValue"])
            Issue.record("Attribute-setting names were composed without a role")
        } catch let error as NativeFailure {
            #expect(error.code == "NATIVE_ERROR")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}

@Test func keepsOnlyAttributesReportedAsWritable() throws {
    #expect(try AXAccess.writableAttributeNames(["AXValue", "AXFocused", "AXTitle"]) { name in
        if name == "AXValue" { return true }
        if name == "AXFocused" { return nil }
        return false
    } == ["AXValue"])
}

@Test func preservesDistinctNativeNamesWithTheSameDisplayLabel() throws {
    let names = ["Name:Move previous\nTarget:0x123\nSelector:(null)", "Name:Move previous\nTarget:0x456\nSelector:(null)"]
    #expect(try AXAccess.listActionNames(actions: names, role: "AXButton", writableAttributes: []) == names)
}

@Test func setterDiscoveryUsesTheSameValueTypesAsConversion() throws {
    #expect(try AXAccess.canEncodeSetter("AXPosition") { Issue.record("Unnecessary type probe"); return nil })
    #expect(try AXAccess.canEncodeSetter("AXValue") { nil })
    #expect(try AXAccess.canEncodeSetter("AXValue") { "text" as CFString })
    #expect(try !AXAccess.canEncodeSetter("AXSections") { [] as CFArray })
    #expect(throws: NativeFailure.self) {
        try AXAccess.attributeValue(attribute: "AXSections", argument: .array([]), current: [] as CFArray)
    }
}

@Test func aMissingTypeDoesNotHideActionsOrMaskFatalAXErrors() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    #expect(try AXAccess.canEncodeSetter("AXCustom") { throw access.failure(.failure, "read AXCustom", attribute: "AXCustom") })
    for code in [AXError.apiDisabled, .invalidUIElement, .cannotComplete] {
        #expect(throws: NativeFailure.self) {
            try AXAccess.canEncodeSetter("AXCustom") { throw access.failure(code, "read AXCustom", attribute: "AXCustom") }
        }
    }
}
