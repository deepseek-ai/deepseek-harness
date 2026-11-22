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
    let listed = try AXAccess.writableAttributeNames(["AXValue", "AXFocused", "AXTitle"]) { name in
        if name == "AXValue" { return true }
        if name == "AXFocused" { return nil }
        return false
    }
    #expect(listed.writable == ["AXValue"])
    #expect(listed.unknown == ["AXFocused"])
}

@Test func preservesDistinctNativeNamesWithTheSameDisplayLabel() throws {
    let names = ["Name:Move previous\nTarget:0x123\nSelector:(null)", "Name:Move previous\nTarget:0x456\nSelector:(null)"]
    #expect(try AXAccess.listActionNames(actions: names, role: "AXButton", writableAttributes: []) == names)
}

@Test func nativeActionDescriptionFailuresPreserveTheElementAndPermissionErrors() throws {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    #expect(try access.actionDescription("Press" as CFString, error: .success) == "Press")
    for code in [AXError.success, .actionUnsupported, .notImplemented, .noValue, .failure] {
        #expect(try access.actionDescription(nil, error: code) == nil)
    }
    #expect(try access.actionDescription("" as CFString, error: .success) == nil)
    for code in [AXError.apiDisabled, .invalidUIElement, .cannotComplete, .illegalArgument] {
        #expect(throws: NativeFailure.self) { try access.actionDescription(nil, error: code) }
    }
}

@Test func setterDetailsSeparateMissingValuesFromUnsupportedTypes() throws {
    #expect(AXAccess.setterArgument("AXValue") { "private text" as CFString } == .object(["type": .string("string")]))
    #expect(AXAccess.setterArgument("AXValue") { nil } == .string("unknown"))
    #expect(AXAccess.setterArgument("AXSections") { [] as CFArray } == .string("unsupported"))
    let position = AXAccess.setterArgument("AXPosition") { Issue.record("Read a name-defined attribute"); return nil }
    #expect(position["required"] == .array([.string("x"), .string("y")]))
}
