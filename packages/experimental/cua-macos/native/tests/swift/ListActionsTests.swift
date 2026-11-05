// Action listing includes attribute-setting operations.
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
