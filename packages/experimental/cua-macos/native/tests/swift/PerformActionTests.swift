// Attribute-setting dispatch accepts only complete Role.Attribute.Set names and direct JSON values.
import ApplicationServices
import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

@Test func parsesOnlyCompleteAttributeSetActions() {
    let target = AXAttributeSetTarget("AXTextArea.AXValue.Set")
    #expect(target?.role == "AXTextArea")
    #expect(target?.attribute == "AXValue")
    for action in [
        "AXPress",
        "AXTextArea.AXValue.set",
        "AXTextArea.AXValue.SET",
        "AXTextArea.AXValue.Set.Extra",
        "AXTextArea..Set",
        ".AXValue.Set",
        "AXTextArea.AXValue.",
    ] {
        #expect(AXAttributeSetTarget(action) == nil)
    }
}

@Test func selectsPressBeforePickForDefaultInvocation() {
    #expect(AXWorker.defaultAction(["AXPick", "AXShowMenu"]) == "AXPick")
    #expect(AXWorker.defaultAction(["AXPick", "AXPress"]) == "AXPress")
    #expect(AXWorker.defaultAction(["AXShowMenu"]) == nil)
    #expect(AXWorker.defaultAction([]) == nil)
}

@Test func mapsScalarsToTheirDirectCoreFoundationTypes() throws {
    #expect(CFGetTypeID(try AXAccess.attributeValue(attribute: "AXValue", argument: .string("hello"), current: nil)) == CFStringGetTypeID())
    #expect(CFGetTypeID(try AXAccess.attributeValue(attribute: "AXValue", argument: .bool(true), current: nil)) == CFBooleanGetTypeID())
    #expect(CFGetTypeID(try AXAccess.attributeValue(attribute: "AXValue", argument: .number(2.5), current: nil)) == CFNumberGetTypeID())
}

@Test func mapsPositionSizeAndRangeObjectsToAccessibilityValues() throws {
    let position = unsafeDowncast(try AXAccess.attributeValue(attribute: "AXPosition",
        argument: .object(["x": .number(10), "y": .number(20)]), current: nil), to: AXValue.self)
    var point = CGPoint.zero
    #expect(AXValueGetType(position) == .cgPoint)
    #expect(AXValueGetValue(position, .cgPoint, &point))
    #expect(point == CGPoint(x: 10, y: 20))

    let size = unsafeDowncast(try AXAccess.attributeValue(attribute: "AXSize",
        argument: .object(["width": .number(640), "height": .number(480)]), current: nil), to: AXValue.self)
    var dimensions = CGSize.zero
    #expect(AXValueGetType(size) == .cgSize)
    #expect(AXValueGetValue(size, .cgSize, &dimensions))
    #expect(dimensions == CGSize(width: 640, height: 480))

    let range = unsafeDowncast(try AXAccess.attributeValue(attribute: "AXSelectedTextRange",
        argument: .object(["location": .number(2), "length": .number(3)]), current: nil), to: AXValue.self)
    var value = CFRange()
    #expect(AXValueGetType(range) == .cfRange)
    #expect(AXValueGetValue(range, .cfRange, &value))
    #expect(value.location == 2)
    #expect(value.length == 3)
}

@Test func rejectsArgumentsForPlainActionsAndMissingAttributeValues() {
    let access = AXAccess(timeout: 1, cancellation: CancellationLatch())
    let element = AXUIElementCreateApplication(0)
    for argument in [JSONValue.string("value"), .bool(true), .number(1), .array([]), .object([:])] {
        do {
            try access.performAction(element, action: "AXPress", argument: argument)
            Issue.record("AXPress accepted an argument")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
    let absent: [JSONValue?] = [nil, .null]
    for argument in absent {
        do {
            try access.performAction(element, action: "AXTextArea.AXValue.Set", argument: argument)
            Issue.record("Attribute setting accepted no value")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT")
        } catch { Issue.record("Unexpected error: \(error)") }
        do {
            try access.setAttribute(element, "AXValue", argument)
            Issue.record("AXValue accepted no value")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}

@Test func rejectsUnsupportedOrMalformedAttributeValues() {
    let cases: [(String, JSONValue, CFTypeRef?)] = [
        ("AXPosition", .object(["x": .number(1)]), nil),
        ("AXSize", .object(["width": .number(-1), "height": .number(1)]), nil),
        ("AXSelectedTextRange", .object(["location": .number(0.5), "length": .number(1)]), nil),
        ("AXChildren", .object(["value": .string("x")]), nil),
        ("AXChildren", .array([]), [String]() as CFArray),
    ]
    for (attribute, argument, current) in cases {
        do {
            _ = try AXAccess.attributeValue(attribute: attribute, argument: argument, current: current)
            Issue.record("\(attribute) accepted \(argument)")
        } catch let error as NativeFailure {
            #expect(error.code == "INVALID_ARGUMENT" || error.code == "UNSUPPORTED")
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}
