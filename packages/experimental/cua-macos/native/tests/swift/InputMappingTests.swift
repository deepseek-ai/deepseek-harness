// Native input identities retain keypad keys and button/modifier distinctions.
import CoreGraphics
import Testing
@testable import CuaNative

@Test(arguments: [("KP_0", 82), ("KP_1", 83), ("KP_9", 92), ("KP_Enter", 76),
                  ("KP_Add", 69), ("KP_Subtract", 78), ("KP_Multiply", 67), ("KP_Divide", 75),
                  ("KP_Decimal", 65), ("KP_Separator", 95), ("KP_Equal", 81), ("KP_Clear", 71)])
func keypadKeysRetainTheirPhysicalIdentity(_ key: String, _ code: UInt16) throws {
    #expect(try KeyboardInput.keyCode(key) == code)
}

@Test func keypadEnterDiffersFromReturnAndKeypadZeroDiffersFromZero() throws {
    #expect(try KeyboardInput.keyCode("KP_Enter") != KeyboardInput.keyCode("Return"))
    #expect(try KeyboardInput.keyCode("KP_0") != KeyboardInput.keyCode("0"))
    #expect(try KeyboardInput.modifierFlags(["shift", "cmd"]) == [.maskShift, .maskCommand])
    #expect(throws: NativeFailure.self) { try KeyboardInput.modifierFlags(["unsupported"]) }
}

@Test func middleGestureRetainsItsButtonAndEventFamily() throws {
    let button = try WindowPointerInput.button("middle")
    #expect(button == .center)
    #expect(WindowPointerInput.down(button) == .otherMouseDown)
    #expect(WindowPointerInput.dragged(button) == .otherMouseDragged)
    #expect(WindowPointerInput.up(button) == .otherMouseUp)
    #expect(throws: NativeFailure.self) { try WindowPointerInput.button("unsupported") }
}

@Test func everyDeclaredPointerButtonAndModifierHasANativeMapping() throws {
    let buttons = try #require(NativeProtocol.stringEnums["click"]?["mouseButton"])
    let modifiers = try #require(NativeProtocol.stringEnums["click"]?["modifiers"])
    for button in buttons { _ = try WindowPointerInput.button(button) }
    for modifier in modifiers { _ = try KeyboardInput.modifierFlags([modifier]) }
}
