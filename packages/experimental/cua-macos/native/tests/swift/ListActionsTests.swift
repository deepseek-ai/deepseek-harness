// Action listing includes attribute-setting operations.
import ApplicationServices
import Testing
@testable import CuaNative

@Test func appendsAttributeSettingActionsAfterNativeActions() throws {
    #expect(try AXAccess.listActionNames(actions: ["AXPress"], role: "AXTextArea",
                                          writableAttributes: ["AXValue", "AXSelectedTextRange"], read: { _ in nil })
        == ["AXPress", "AXTextArea.AXValue.Set", "AXTextArea.AXSelectedTextRange.Set"])
}

@Test func omitsAttributeSettingActionsWithoutWritableAttributes() throws {
    #expect(try AXAccess.listActionNames(actions: ["AXPress"], role: nil, writableAttributes: [], read: { _ in nil }) == ["AXPress"])
}

@Test func rejectsWritableAttributesWithoutAnObservedRole() {
    let roles: [String?] = [nil, ""]
    for role in roles {
        do {
            _ = try AXAccess.listActionNames(actions: [], role: role, writableAttributes: ["AXValue"], read: { _ in nil })
            Issue.record("Attribute-setting names were composed without a role")
        } catch let error as NativeFailure {
            #expect(error.code == "NATIVE_ERROR")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}

@Test func keepsOnlyAttributesReportedAsWritable() {
    #expect(AXAccess.writableAttributeNames(["AXValue", "AXFocused", "AXTitle"]) { name in
        if name == "AXValue" { return true }
        if name == "AXFocused" { return nil }
        return false
    } == ["AXValue"])
}

@Test func preservesDistinctNativeNamesWithTheSameDisplayLabel() throws {
    let names = ["Name:Move previous\nTarget:0x123\nSelector:(null)", "Name:Move previous\nTarget:0x456\nSelector:(null)"]
    #expect(try AXAccess.listActionNames(actions: names, role: "AXButton", writableAttributes: [], read: { _ in nil }) == names)
}

private func canList(_ attribute: String, read: () throws -> CFTypeRef?) throws -> Bool {
    try AXSetterParameter.resolve(role: nil, attribute: attribute).canList(attribute: attribute, read: read)
}

@Test func setterDiscoveryUsesTheSameValueTypesAsConversion() throws {
    #expect(try canList("AXPosition") { Issue.record("Unnecessary type probe"); return nil })
    #expect(try canList("AXValue") { nil })
    #expect(try canList("AXValue") { "text" as CFString })
    #expect(try !canList("AXSections") { [] as CFArray })
    #expect(throws: NativeFailure.self) {
        try encodedAttribute(attribute: "AXSections", argument: .array([]), current: [] as CFArray)
    }
}

@Test func aMissingTypeDoesNotHideActionsOrMaskFatalAXErrors() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    #expect(try canList("AXCustom") { throw access.failure(.failure, "read AXCustom", attribute: "AXCustom") })
    for code in [AXError.apiDisabled, .invalidUIElement, .cannotComplete] {
        #expect(throws: NativeFailure.self) {
            try canList("AXCustom") { throw access.failure(code, "read AXCustom", attribute: "AXCustom") }
        }
    }
}

@Test func listingPreservesCustomNamesAndOmitsUnrepresentableReferenceSetters() throws {
    let names = try AXAccess.listActionNames(actions: ["AXPress", "Custom.Action"], role: "AXTable",
        writableAttributes: ["AXSelectedRows", "AXFocused", "AXCustom"]) { key in
            #expect(key == "AXCustom")
            return "value" as CFString
        }
    #expect(names == ["AXPress", "Custom.Action", "AXTable.AXFocused.Set", "AXTable.AXCustom.Set"])
}

@Test func everyListedNameRoundTripsThroughTheActionGrammar() throws {
    let output = try AXAccess.listActionNames(actions: ["AXGroup.AXTitle.Set", "Custom.Action", "AXOther.AXTitle.Set"],
        role: "AXGroup", writableAttributes: ["", "Vendor.Dotted", "AXTitle"]) { _ in
            Issue.record("Probed an unrepresentable or fixed-type setter"); return nil
        }
    #expect(output == ["Custom.Action", "AXGroup.AXTitle.Set"])
    let namesOnly = try AXAccess.listActionNames(actions: ["AXOther.AXTitle.Set"], role: nil, writableAttributes: []) { _ in nil }
    #expect(namesOnly.isEmpty)
}
