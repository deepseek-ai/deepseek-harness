// Checked AX access and tree projection. Behavioral reference: native/upstream.json (MIT Cua Driver).
import Foundation
import ApplicationServices
import Darwin

private typealias AXWindowFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

struct AXProjection {
    let tree: String
    let elements: [JSONValue]
    let indexed: [Int: AXUIElement]
    let focusedWindowID: UInt32?
    let truncated: Bool
    let hasUnreadableElements: Bool
}

struct AXNodeObservation {
    let role: String
    let attribute: (String) throws -> CFTypeRef?
}

/// Attribute-setting action names are exactly `Role.Attribute.Set`; every other name is a native action.
struct AXAttributeSetTarget: Sendable {
    let role: String
    let attribute: String

    init?(_ action: String) {
        let parts = action.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2] == "Set", !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        role = String(parts[0])
        attribute = String(parts[1])
    }
}

/// Retains invalid roots for partial projection and rejects unresolved windows after incomplete discovery.
struct AXRootDiscovery {
    private(set) var roots: [AXUIElement]
    private(set) var invalidRoots: [AXUIElement: NativeFailure] = [:]
    private var invalidFailure: NativeFailure?

    static func discover(roots initial: [AXUIElement], maxElements: Int,
                         role: (AXUIElement) throws -> String?,
                         children: (AXUIElement) throws -> [AXUIElement]) throws -> AXRootDiscovery {
        var discovery = AXRootDiscovery(roots: initial)
        var cursor = 0
        while cursor < discovery.roots.count && cursor < maxElements {
            let root = discovery.roots[cursor]
            cursor += 1
            do {
                let rootRole = try role(root)
                guard rootRole == "AXWindow" || rootRole == "AXSheet" else { continue }
                for child in try children(root) where discovery.roots.count < maxElements {
                    do {
                        if try role(child) == "AXSheet", !discovery.roots.contains(where: { CFEqual($0, child) }) {
                            discovery.roots.append(child)
                        }
                    } catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                        if discovery.invalidFailure == nil { discovery.invalidFailure = failure }
                    }
                }
            } catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                discovery.recordInvalidRoot(root, failure: failure)
            }
        }
        return discovery
    }

    /// Preserve the root's failure for projection and the first discovery failure for an unresolved window.
    mutating func recordInvalidRoot(_ root: AXUIElement, failure: NativeFailure) {
        invalidRoots[root] = failure
        if invalidFailure == nil { invalidFailure = failure }
    }

    /// Only a successful discovery can establish that an owned window has no AX surface.
    func validateWindowSelection(hasMatch: Bool, verifyOwnership: () throws -> Void) throws {
        guard !hasMatch else { return }
        try verifyOwnership()
        if let invalidFailure { throw invalidFailure }
    }
}

final class AXAccess {
    let timeout: Float
    let cancellation: CancellationLatch
    private let framework: UnsafeMutableRawPointer?
    private let windowFunction: AXWindowFunction?
    private var enabledProcesses: Set<ProcessIdentityKey> = []

    init(timeout: Float, cancellation: CancellationLatch) {
        self.timeout = timeout
        self.cancellation = cancellation
        framework = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL)
        if let framework, let symbol = dlsym(framework, "_AXUIElementGetWindow") {
            windowFunction = unsafeBitCast(symbol, to: AXWindowFunction.self)
        } else { windowFunction = nil }
    }
    deinit { if let framework { dlclose(framework) } }

    private func prepare(_ element: AXUIElement) throws {
        try cancellation.check()
        let error = AXUIElementSetMessagingTimeout(element, timeout)
        guard error == .success else { throw failure(error, "set AX messaging timeout") }
    }
    func failure(_ error: AXError, _ operation: String, attribute: String? = nil) -> NativeFailure {
        NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
                      message: "Accessibility \(operation) failed with error \(error.rawValue)", accessibilityError: error.rawValue, attribute: attribute)
    }
    private func absent(_ error: AXError) -> Bool { error == .attributeUnsupported || error == .noValue || error == .notImplemented }
    static func optionalAttributeUnavailable(_ error: AXError, attribute: String) -> Bool {
        // File-panel controls can lack descriptive metadata while their role
        // and accessibility children remain readable.
        guard error == .failure else { return false }
        let optional: Set<String> = ["AXValue", "AXTitle", "AXDescription", "AXIdentifier", "AXPlaceholderValue",
                                     "AXSubrole", "AXHelp", "AXURL", "AXFocused", "AXExpanded", "AXEnabled", "AXSelected", "AXSelectedText", "AXSelectedTextRange", "AXPosition", "AXSize", "AXMain", "AXMinimized"]
        return optional.contains(attribute)
    }
    func attribute(_ element: AXUIElement, _ name: String, allowMissingMetadata: Bool = true) throws -> CFTypeRef? {
        try prepare(element)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if absent(error) || (allowMissingMetadata && Self.optionalAttributeUnavailable(error, attribute: name)) { return nil }
        guard error == .success else { throw failure(error, "read \(name)", attribute: name) }
        guard let value else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) returned no value after success") }
        return value
    }
    func string(_ element: AXUIElement, _ name: String) throws -> String? {
        try stringValue(try attribute(element, name), attribute: name)
    }
    private func stringValue(_ raw: CFTypeRef?, attribute name: String) throws -> String? {
        guard let value = raw else { return nil }
        guard CFGetTypeID(value) == CFStringGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not a string") }
        return value as? String
    }
    func boolean(_ element: AXUIElement, _ name: String) throws -> Bool? {
        try booleanValue(try attribute(element, name), attribute: name)
    }
    private func booleanValue(_ raw: CFTypeRef?, attribute name: String) throws -> Bool? {
        guard let value = raw else { return nil }
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not a boolean") }
        return (value as? NSNumber)?.boolValue
    }
    func elementValue(_ value: CFTypeRef, _ name: String) throws -> AXUIElement {
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not an element") }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
    func element(_ element: AXUIElement, _ name: String) throws -> AXUIElement? {
        guard let value = try attribute(element, name) else { return nil }
        return try elementValue(value, name)
    }
    func element(at point: CGPoint, owner: ProcessIdentity) throws -> AXUIElement? {
        let app = AXUIElementCreateApplication(owner.pid)
        try prepare(app)
        var hit: AXUIElement?
        let error = AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit)
        if absent(error) { return nil }
        guard error == .success else { throw failure(error, "find element at hover point") }
        return hit
    }
    func children(_ element: AXUIElement, _ name: String = "AXChildren") throws -> [AXUIElement] {
        try childValues(try attribute(element, name), attribute: name)
    }
    private func childValues(_ raw: CFTypeRef?, attribute name: String) throws -> [AXUIElement] {
        guard let value = raw else { return [] }
        guard CFGetTypeID(value) == CFArrayGetTypeID(), let array = value as? [AnyObject] else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility \(name) is not an array")
        }
        return try array.map { try elementValue($0, name) }
    }
    func recoveryChildCount(_ count: Int, error: AXError) throws -> Int? {
        if error == .success { return count }
        if absent(error) || error == .failure || error == .illegalArgument { return nil }
        throw failure(error, "count AXChildren")
    }
    private func readChildren(_ parent: AXUIElement, budget: inout AXChildRecoveryBudget,
                              cached: AXObservedChildren? = nil, onRecovery: (AXObservedChildren) -> Void = { _ in },
                              read: () throws -> [AXUIElement]) throws -> AXObservedChildren {
        try AXObservedChildren.observing(read) {
            if let cached { return cached }
            let start = ContinuousClock.now
            defer { budget.time -= start.duration(to: .now) }
            let result = try recoverChildren(parent, limit: budget.limit, requests: &budget.requests, deadline: start + budget.time)
            onRecovery(result)
            return result
        }
    }
    private func readChildren(_ parent: AXUIElement, budget: inout AXChildRecoveryBudget) throws -> AXObservedChildren {
        try readChildren(parent, budget: &budget) { try children(parent) }
    }
    private func recoverChildren(_ element: AXUIElement, limit: Int, requests: inout Int, deadline: ContinuousClock.Instant) throws -> AXObservedChildren {
        try cancellation.check()
        guard requests > 0, ContinuousClock.now < deadline else { return .unavailable }
        requests -= 1
        try prepare(element)
        var count = 0
        let error = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        guard let childCount = try recoveryChildCount(count, error: error) else { return .unavailable }
        return try AXObservedChildren.readRanges(count: childCount, limit: limit, requests: &requests) { range in
            try cancellation.check()
            guard ContinuousClock.now < deadline else { return .positionsUnknown }
            var values: CFArray?
            let error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString,
                                                       range.lowerBound, range.count, &values)
            if error == .failure { return .unreadable }
            if absent(error) || error == .illegalArgument { return .positionsUnknown }
            guard error == .success else { throw failure(error, "read AXChildren range") }
            guard let values, CFArrayGetCount(values) <= range.count else { return .positionsUnknown }
            return .values((values as [AnyObject]).map { value in
                CFGetTypeID(value) == AXUIElementGetTypeID() ? unsafeDowncast(value, to: AXUIElement.self) : nil
            })
        }
    }
    private func processID(_ element: AXUIElement) throws -> pid_t {
        try cancellation.check()
        var pid: pid_t = 0
        let error = AXUIElementGetPid(element, &pid)
        guard error == .success else { throw failure(error, "identify element owner") }
        return pid
    }
    func windowID(_ element: AXUIElement) throws -> UInt32? {
        try prepare(element)
        guard let windowFunction else { return nil }
        var id: UInt32 = 0
        let error = windowFunction(element, &id)
        if absent(error) { return nil }
        guard error == .success else { throw failure(error, "resolve window ID") }
        return id == 0 ? nil : id
    }
    func focusedWindowID(_ pid: Int32) throws -> UInt32? {
        guard let focused = try element(AXUIElementCreateApplication(pid), "AXFocusedWindow") else { return nil }
        return try windowID(focused)
    }
    /// Restore a selected or unambiguous window without raising it or requesting application activation.
    func restoreWindow(_ requested: UInt32?, owner: ProcessIdentity) throws -> UInt32? {
        let app = AXUIElementCreateApplication(owner.pid)
        try clearBooleanAttribute(app, "AXHidden")
        let windows = try children(app, "AXWindows")
        let selected: AXUIElement?
        if let requested {
            _ = try NativePlatform.ownedWindow(owner.pid, requested)
            selected = try windows.first { try windowID($0) == requested }
            guard selected != nil else { throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Window is not exposed for restoration; read fresh state before deciding whether to activate") }
        } else {
            selected = try element(app, "AXFocusedWindow") ?? element(app, "AXMainWindow") ?? (windows.count == 1 ? windows[0] : nil)
        }
        guard let selected else { return nil }
        try clearBooleanAttribute(selected, "AXMinimized")
        return try windowID(selected)
    }
    private func clearBooleanAttribute(_ element: AXUIElement, _ name: String) throws {
        guard try boolean(element, name) == true else { return }
        guard try writable(element, name) == true else {
            throw NativeFailure(code: "UNSUPPORTED", message: "Cannot restore \(name) without activation; read fresh state before deciding whether to activate")
        }
        try prepare(element)
        let error = AXUIElementSetAttributeValue(element, name as CFString, kCFBooleanFalse)
        guard error == .success else { throw failure(error, "clear \(name)") }
    }
    func actions(_ element: AXUIElement, requireKnown: Bool = false) throws -> [String] {
        try prepare(element)
        var names: CFArray?
        let error = AXUIElementCopyActionNames(element, &names)
        return try actionNames(names, error: error, requireKnown: requireKnown)
    }
    func actionNames(_ names: CFArray?, error: AXError, requireKnown: Bool) throws -> [String] {
        if absent(error) || error == .actionUnsupported || (!requireKnown && error == .failure) { return [] }
        guard error == .success else { throw failure(error, "read actions") }
        guard let names else { return [] }
        guard let result = names as? [String] else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility actions are not strings") }
        return result
    }
    func listActions(_ element: AXUIElement) throws -> [String] {
        let advertised = try actions(element)
        let attributes = try writableAttributes(element)
        guard !attributes.isEmpty else { return advertised }
        let role = try string(element, "AXRole")
        return try Self.listActionNames(actions: advertised, role: role, writableAttributes: attributes)
    }
    static func listActionNames(actions: [String], role: String?, writableAttributes: [String]) throws -> [String] {
        guard !writableAttributes.isEmpty else { return actions }
        guard let role, !role.isEmpty else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Cannot name attribute-setting operations without an accessibility role")
        }
        return actions + writableAttributes.map { "\(role).\($0).Set" }
    }
    func writableAttributes(_ element: AXUIElement) throws -> [String] {
        try prepare(element)
        var names: CFArray?
        let error = AXUIElementCopyAttributeNames(element, &names)
        if absent(error) { return [] }
        guard error == .success else { throw failure(error, "read attribute names") }
        guard let names else { return [] }
        guard let result = names as? [String] else { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility attributes are not strings") }
        return try Self.writableAttributeNames(result) { try writable(element, $0, forDiscovery: true) }
    }
    static func writableAttributeNames(_ names: [String], isWritable: (String) throws -> Bool?) rethrows -> [String] {
        try names.filter { try isWritable($0) == true }
    }
    func writable(_ element: AXUIElement, _ name: String, forDiscovery: Bool = false) throws -> Bool? {
        try prepare(element)
        var result: DarwinBoolean = false
        let error = AXUIElementIsAttributeSettable(element, name as CFString, &result)
        return try attributeWritability(result.boolValue, error: error, name: name, forDiscovery: forDiscovery)
    }
    func attributeWritability(_ value: Bool, error: AXError, name: String, forDiscovery: Bool) throws -> Bool? {
        if absent(error) || (forDiscovery && error == .failure) { return nil }
        guard error == .success else { throw failure(error, "read writability of \(name)") }
        return value
    }
    /// Observation keeps unsupported writability unknown; mutation callers use strict writable checks.
    static func observationWritability(role: String, probe: (String, Bool) throws -> Bool?) rethrows -> (value: Bool?, selection: Bool?) {
        let value = AXTextNode.valueRoles.contains(role) ? try probe("AXValue", true) : nil
        let selection = AXTextNode.textRoles.contains(role) ? try probe("AXSelectedTextRange", true) : nil
        return (value, selection)
    }
    func requireEnabled(_ element: AXUIElement) throws {
        if try boolean(element, "AXEnabled") == false { throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility element is disabled") }
    }
    func perform(_ element: AXUIElement, _ action: String) throws {
        try requireEnabled(element)
        func dispatch() throws -> AXError {
            try prepare(element)
            return AXUIElementPerformAction(element, action as CFString)
        }
        let result: AXError
        if action == "AXZoomWindow" {
            let role = try? string(element, "AXRole")
            let window = role == "AXWindow" ? element : try? self.element(element, "AXWindow")
            result = try Self.performZoom(readSize: {
                guard let window else { return nil }
                return Self.dimensions(try? self.attribute(window, "AXSize"))
            }, dispatch: dispatch)
        } else {
            result = try dispatch()
        }
        guard result == .success else { throw failure(result, "perform \(action)") }
    }
    /// Dispatch once. Only an observed resize of the same window can override attributeUnsupported.
    static func performZoom(readSize: () -> CGSize?, dispatch: () throws -> AXError) rethrows -> AXError {
        let before = readSize()
        let result = try dispatch()
        guard result == .attributeUnsupported, let before, before.width > 0, before.height > 0,
              let after = readSize(), after.width > 0, after.height > 0, before != after else { return result }
        return .success
    }
    func setAttribute(_ element: AXUIElement, _ attributeName: String, _ value: JSONValue?, expectedRole: String? = nil) throws {
        guard let value, value != .null else {
            throw RequestParameters.invalid("\(attributeName) requires a value")
        }
        if let expectedRole {
            guard let role = try string(element, "AXRole") else {
                throw RequestParameters.invalid("Cannot verify an attribute-setting action without an element role")
            }
            guard role == expectedRole else {
                throw RequestParameters.invalid("Action role \(expectedRole) does not match element role \(role)")
            }
        }
        guard try writable(element, attributeName) == true else {
            throw RequestParameters.invalid("\(attributeName) is not writable on this element")
        }
        let current = try attribute(element, attributeName)
        let converted = try Self.attributeValue(attribute: attributeName, argument: value, current: current)
        try requireEnabled(element)
        try prepare(element)
        let error = AXUIElementSetAttributeValue(element, attributeName as CFString, converted)
        guard error == .success else { throw failure(error, "set \(attributeName)") }
    }
    /// Perform an action, including attribute-setting operations.
    func performAction(_ element: AXUIElement, action: String, argument: JSONValue?) throws {
        guard let target = AXAttributeSetTarget(action) else {
            guard argument == nil || argument == .null else {
                throw RequestParameters.invalid("\(action) is not an attribute-setting action and accepts no argument")
            }
            try perform(element, action)
            return
        }
        try setAttribute(element, target.attribute, argument, expectedRole: target.role)
    }
    private enum AttributeValueKind {
        case string, boolean, number, point, size, range
    }
    /// Convert one direct JSON argument to the Core Foundation value expected by the attribute's live type.
    static func attributeValue(attribute: String, argument: JSONValue, current: CFTypeRef?) throws -> CFTypeRef {
        let kind = try valueKind(attribute: attribute, argument: argument, current: current)
        switch kind {
        case .string:
            guard case .string(let text) = argument else { throw RequestParameters.invalid("\(attribute) requires a string value") }
            return text as CFString
        case .boolean:
            guard case .bool(let flag) = argument else { throw RequestParameters.invalid("\(attribute) requires a boolean value") }
            return flag ? kCFBooleanTrue! : kCFBooleanFalse!
        case .number:
            guard case .number(let number) = argument, number.isFinite else {
                throw RequestParameters.invalid("\(attribute) requires a finite number")
            }
            return NSNumber(value: number)
        case .point:
            let values = try fields(argument, attribute: attribute, keys: ["x", "y"])
            var point = CGPoint(x: try finite(values["x"], name: "x", attribute: attribute),
                                y: try finite(values["y"], name: "y", attribute: attribute))
            guard let value = AXValueCreate(.cgPoint, &point) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        case .size:
            let values = try fields(argument, attribute: attribute, keys: ["width", "height"])
            var size = CGSize(width: try dimension(values["width"], name: "width", attribute: attribute),
                              height: try dimension(values["height"], name: "height", attribute: attribute))
            guard let value = AXValueCreate(.cgSize, &size) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        case .range:
            let values = try fields(argument, attribute: attribute, keys: ["location", "length"])
            let location = try nonnegativeInteger(values["location"], name: "location", attribute: attribute)
            let length = try nonnegativeInteger(values["length"], name: "length", attribute: attribute)
            guard location <= Int.max - length else { throw RequestParameters.invalid("\(attribute) range is too large") }
            var range = CFRange(location: location, length: length)
            guard let value = AXValueCreate(.cfRange, &range) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create \(attribute)")
            }
            return value
        }
    }
    private static func valueKind(attribute: String, argument: JSONValue, current: CFTypeRef?) throws -> AttributeValueKind {
        switch attribute {
        case "AXPosition": return .point
        case "AXSize": return .size
        case "AXSelectedTextRange": return .range
        default: break
        }
        if let current { return try inferredKind(current, attribute: attribute) }
        switch argument {
        case .string: return .string
        case .bool: return .boolean
        case .number: return .number
        default:
            throw NativeFailure(code: "UNSUPPORTED", message: "Accessibility \(attribute) has no known value type for this JSON argument")
        }
    }
    private static func inferredKind(_ value: CFTypeRef, attribute: String) throws -> AttributeValueKind {
        let type = CFGetTypeID(value)
        if type == CFStringGetTypeID() { return .string }
        if type == CFBooleanGetTypeID() { return .boolean }
        if type == CFNumberGetTypeID() { return .number }
        if type == AXValueGetTypeID() {
            switch AXValueGetType(unsafeDowncast(value, to: AXValue.self)) {
            case .cgPoint: return .point
            case .cgSize: return .size
            case .cfRange: return .range
            default: break
            }
        }
        throw NativeFailure(code: "UNSUPPORTED", message: "Accessibility \(attribute) value type is not supported for attribute-setting arguments")
    }
    private static func fields(_ argument: JSONValue, attribute: String, keys: Set<String>) throws -> [String: JSONValue] {
        guard case .object(let values) = argument, Set(values.keys) == keys else {
            throw RequestParameters.invalid("\(attribute) requires exactly \(keys.sorted().joined(separator: ", "))")
        }
        return values
    }
    private static func finite(_ value: JSONValue?, name: String, attribute: String) throws -> Double {
        guard let value, case .number(let number) = value, number.isFinite else {
            throw RequestParameters.invalid("\(attribute) \(name) must be a finite number")
        }
        return number
    }
    private static func dimension(_ value: JSONValue?, name: String, attribute: String) throws -> Double {
        let number = try finite(value, name: name, attribute: attribute)
        guard number >= 0 else { throw RequestParameters.invalid("\(attribute) \(name) must be nonnegative") }
        return number
    }
    private static func nonnegativeInteger(_ value: JSONValue?, name: String, attribute: String) throws -> Int {
        guard let value, case .number(let number) = value, number.isFinite,
              number.rounded(.towardZero) == number, number >= 0, number <= Double(Int.max),
              let integer = Int(exactly: number) else {
            throw RequestParameters.invalid("\(attribute) \(name) must be a nonnegative integer")
        }
        return integer
    }
    func pasteCommand(_ pid: Int32, maxElements: Int, maxDepth: Int) throws -> AXUIElement {
        guard let menu = try element(AXUIElementCreateApplication(pid), "AXMenuBar") else {
            throw NativeFailure(code: "UNSUPPORTED", message: "The application does not expose a Paste menu command")
        }
        var budget = AXChildRecoveryBudget(maxElements: maxElements, timeout: timeout)
        return try Self.pasteCommand(in: menu, maxElements: maxElements, maxDepth: maxDepth, matches: { node in
            guard try string(node, "AXRole") == "AXMenuItem", try string(node, "AXMenuItemCmdChar")?.lowercased() == "v",
                  let raw = try attribute(node, "AXMenuItemCmdModifiers"), CFGetTypeID(raw) == CFNumberGetTypeID(),
                  let number = raw as? NSNumber, number.intValue == 0, try actions(node, requireKnown: true).contains("AXPress") else { return false }
            guard try processID(node) == pid else { throw Self.beforeInput("UNSUPPORTED", "Paste command belongs to another process.") }
            return true
        }, children: { try readChildren($0, budget: &budget) })
    }

    private static func beforeInput(_ code: String, _ reason: String) -> NativeFailure {
        NativeFailure(code: code, message: reason + " No input was dispatched. Read fresh state before retrying.")
    }

    /// A second command or an unexamined branch prevents selecting a unique Paste command.
    static func pasteCommand(in menu: AXUIElement, maxElements: Int, maxDepth: Int,
                             matches: (AXUIElement) throws -> Bool, children: (AXUIElement) throws -> AXObservedChildren) throws -> AXUIElement {
        var pending = [(menu, 0)]
        var found: AXUIElement?
        var seen = Set<AXUIElement>()
        var incomplete = false
        while let (node, depth) = pending.popLast() {
            guard seen.insert(node).inserted else { continue }
            guard seen.count <= maxElements, depth <= maxDepth else {
                throw beforeInput("UNSUPPORTED", "Paste menu discovery exceeded its observation limits.")
            }
            if try matches(node) {
                guard found == nil else { throw beforeInput("UNSUPPORTED", "The application exposes ambiguous Paste commands.") }
                found = node
            }
            let list = try children(node)
            incomplete = incomplete || list.incomplete
            for case let child? in list.entries { pending.append((child, depth + 1)) }
        }
        guard !incomplete else { throw beforeInput("UNSUPPORTED", "Paste menu discovery is incomplete.") }
        guard let found else { throw NativeFailure(code: "UNSUPPORTED", message: "No standard Paste command is available") }
        return found
    }
    func selectText(_ element: AXUIElement, text: String, prefix: String?, suffix: String?, mode: String) throws {
        try requireEnabled(element)
        guard try writable(element, "AXSelectedTextRange") == true, let original = try string(element, "AXValue") else {
            throw NativeFailure(code: "UNSUPPORTED", message: "This control does not expose writable text selection")
        }
        var range = try TextSelection.range(in: original, text: text, prefix: prefix, suffix: suffix, mode: mode)
        guard let value = AXValueCreate(.cfRange, &range) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Could not create the text selection range")
        }
        guard try string(element, "AXValue") == original else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Text changed before selection; read fresh state")
        }
        try prepare(element)
        let error = AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, value)
        guard error == .success else { throw failure(error, "set text selection") }
        let actual = try textRange(attribute(element, "AXSelectedTextRange"))
        guard actual?.location == range.location, actual?.length == range.length, try string(element, "AXValue") == original else {
            throw NativeFailure(code: "SELECTION_CHANGED", message: "The requested selection was not retained; read fresh state before input")
        }
    }
    private func textRange(_ raw: CFTypeRef?) throws -> CFRange? {
        guard let raw else { return nil }
        guard CFGetTypeID(raw) == AXValueGetTypeID() else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "AXSelectedTextRange is not an accessibility value")
        }
        let value = unsafeDowncast(raw, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range), range.location >= 0, range.length >= 0 else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "AXSelectedTextRange is not a valid range")
        }
        return range
    }
    func bounds(_ element: AXUIElement) throws -> WindowBounds? {
        guard let position = try attribute(element, "AXPosition") else { return nil }
        return try bounds(position: position, size: attribute(element, "AXSize"))
    }
    func coordinateWindow(_ identity: ProcessIdentity, _ windowID: UInt32, budget: inout AXChildRecoveryBudget, forClick: Bool = false,
                                  trace: ScreenshotTrace? = nil) throws -> (window: WindowInfo, element: AXUIElement?) {
        var element: AXUIElement?
        let window = try WindowGeometry.resolve(owner: identity, windowID: windowID, readWindow: { pid, id in
            trace?.mark("window-info.begin")
            let window = try NativePlatform.ownedWindow(pid, id)
            trace?.mark("window-info.end")
            return window
        }) {
            // Capture without Accessibility permission retains its CG/SCK checks.
            guard forClick || AXIsProcessTrusted() else { return nil }
            trace?.mark("ax-geometry.begin")
            element = try windowElement(windowID, owner: identity, budget: &budget, requireComplete: forClick)
            let bounds = try element.flatMap { try self.bounds($0) }
            trace?.mark("ax-geometry.end")
            return bounds
        }
        return (window, element)
    }
    /// WindowServer IDs identify a window or sheet even when other branches are incomplete.
    func windowElement(_ id: UInt32, owner: ProcessIdentity, budget: inout AXChildRecoveryBudget, requireComplete: Bool) throws -> AXUIElement? {
        let app = AXUIElementCreateApplication(owner.pid)
        var seen = Set<AXUIElement>()
        var windows: [AXUIElement] = []
        func matches(_ node: AXUIElement, sheetOnly: Bool = false) throws -> Bool {
            guard seen.insert(node).inserted else { return false }
            let role = try string(node, "AXRole")
            guard role == "AXSheet" || (!sheetOnly && role == "AXWindow") else { return false }
            windows.append(node)
            return try windowID(node) == id
        }
        for window in try children(app, "AXWindows") where try matches(window) { return window }
        if let focused = try element(app, "AXFocusedWindow"), try matches(focused) { return focused }
        let roots = try readChildren(app, budget: &budget)
        for case let root? in roots.entries where try matches(root) { return root }
        var incomplete = roots.incomplete
        var index = 0
        while index < windows.count {
            let list = try readChildren(windows[index], budget: &budget)
            for case let child? in list.entries where try matches(child, sheetOnly: true) { return child }
            incomplete = incomplete || list.incomplete
            index += 1
        }
        guard !requireComplete || !incomplete else { throw Self.beforeInput("WINDOW_UNAVAILABLE", "Window or sheet discovery is incomplete.") }
        return nil
    }
    private func bounds(position: CFTypeRef?, size: CFTypeRef?) throws -> WindowBounds? {
        guard let position, CFGetTypeID(position) == AXValueGetTypeID(), let dimensions = Self.dimensions(size) else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &point),
              point.x.isFinite, point.y.isFinite else { return nil }
        return WindowBounds(x: point.x, y: point.y, width: dimensions.width, height: dimensions.height)
    }
    private static func dimensions(_ size: CFTypeRef?) -> CGSize? {
        guard let size, CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var dimensions = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &dimensions),
              dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
        return dimensions
    }
    private func controlValue(_ raw: CFTypeRef?) -> String? {
        guard let value = raw else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return ((value as? NSNumber)?.boolValue == true) ? "1" : "0" }
        if CFGetTypeID(value) == CFNumberGetTypeID() { return (value as? NSNumber)?.stringValue }
        return nil
    }
    // A node's values are retained only for this observation. Input always reads
    // live attributes, and unsupported batch APIs retain the individual read path.
    private func metadata(_ element: AXUIElement) throws -> [String: CFTypeRef]? {
        try prepare(element)
        let names = ["AXRole", "AXTitle", "AXValue", "AXPlaceholderValue", "AXDescription", "AXEnabled",
                     "AXIdentifier", "AXPosition", "AXSize", "AXChildren", "AXSelected", "AXSelectedText", "AXSelectedTextRange",
                     "AXSubrole", "AXHelp", "AXURL", "AXFocused", "AXExpanded"]
        var output: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &output)
        if error == .notImplemented || error == .attributeUnsupported { return nil }
        guard error == .success else { throw failure(error, "read node attributes") }
        guard let output, CFArrayGetCount(output) == names.count else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility batch returned mismatched attribute values")
        }
        let values = output as [AnyObject]
        return Dictionary(uniqueKeysWithValues: zip(names, values))
    }
    static func batchAttribute(_ value: CFTypeRef, name: String) throws -> CFTypeRef? {
        if CFGetTypeID(value) == CFNullGetTypeID() { return nil }
        if CFGetTypeID(value) == AXValueGetTypeID() {
            let wrapped = unsafeDowncast(value, to: AXValue.self)
            if AXValueGetType(wrapped) == .axError {
                var error = AXError.success
                guard AXValueGetValue(wrapped, .axError, &error), error != .success else {
                    throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility batch returned an invalid attribute error")
                }
                if error == .attributeUnsupported || error == .noValue || error == .notImplemented
                    || optionalAttributeUnavailable(error, attribute: name) { return nil }
                throw NativeFailure(code: error == .apiDisabled ? "PERMISSION_DENIED" : "NATIVE_ERROR",
                                    message: "Accessibility read \(name) failed with error \(error.rawValue)", accessibilityError: error.rawValue, attribute: name)
            }
        }
        return value
    }

    // Decode metadata lazily while retaining errors for every consumed attribute.
    func nodeObservation(attributes: [String: CFTypeRef]?, fallback: @escaping (String) throws -> CFTypeRef?) throws -> AXNodeObservation {
        func observed(_ name: String) throws -> CFTypeRef? {
            guard let attributes else { return try fallback(name) }
            guard let value = attributes[name] else { throw NativeFailure(code: "NATIVE_ERROR", message: "Missing requested observation attribute") }
            return try Self.batchAttribute(value, name: name)
        }
        let role = try stringValue(observed("AXRole"), attribute: "AXRole") ?? "AXUnknown"
        return AXNodeObservation(role: role, attribute: observed)
    }

    private func enableAX(_ app: AXUIElement, identity: ProcessIdentity) throws {
        let key = ProcessIdentityKey(identity)
        if enabledProcesses.contains(key) { return }
        try prepare(app)
        var error = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if error == .attributeUnsupported { error = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
        if error == .apiDisabled { throw failure(error, "enable application accessibility") }
        if error == .success { enabledProcesses.insert(key) }
    }

    func project(identity: ProcessIdentity, windowID requested: UInt32?, maxElements: Int, maxDepth: Int, includeMenus: Bool = false, details: Bool = false) throws -> AXProjection {
        let app = AXUIElementCreateApplication(identity.pid)
        try enableAX(app, identity: identity)
        var budget = AXChildRecoveryBudget(maxElements: maxElements, timeout: timeout)
        // Window discovery and traversal can both enumerate the same parent.
        var recoveryCache: [AXUIElement: AXObservedChildren] = [:]
        func observedChildren(_ parent: AXUIElement, _ value: @autoclosure () throws -> CFTypeRef?, duringDiscovery: Bool = false) throws -> AXObservedChildren {
            try readChildren(parent, budget: &budget, cached: recoveryCache[parent], onRecovery: { result in
                if duringDiscovery { recoveryCache[parent] = result }
            }) {
                try childValues(value(), attribute: "AXChildren")
            }
        }
        let appChildren = try observedChildren(app, attribute(app, "AXChildren"), duringDiscovery: true)
        var roots = appChildren.entries.compactMap { $0 }
        let appRootCount = roots.count
        func appendUnique(_ element: AXUIElement) {
            if !roots.contains(where: { CFEqual($0, element) }) { roots.append(element) }
        }
        for root in try children(app, "AXWindows") { appendUnique(root) }
        let focused = try element(app, "AXFocusedWindow")
        if let focused { appendUnique(focused) }
        var rootDiscovery = try AXRootDiscovery.discover(roots: roots, maxElements: maxElements,
            role: { try self.string($0, "AXRole") }, children: {
                try observedChildren($0, self.attribute($0, "AXChildren"), duringDiscovery: true).entries.compactMap { $0 }
            })
        roots = rootDiscovery.roots
        var focusedID: UInt32?
        if let focused, rootDiscovery.invalidRoots[focused] == nil {
            do { focusedID = try windowID(focused) }
            catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                rootDiscovery.recordInvalidRoot(focused, failure: failure)
            }
        }
        if let requested {
            var matches: [AXUIElement] = []
            var nonWindows: [(element: AXUIElement, role: String)] = []
            var anonymousSheets: [AXUIElement] = []
            for root in roots where rootDiscovery.invalidRoots[root] == nil {
                do {
                    let role = try string(root, "AXRole") ?? ""
                    if role == "AXWindow" || role == "AXSheet" {
                        let id = try windowID(root)
                        if id == requested { matches.append(root) }
                        else if role == "AXSheet" && id == nil { anonymousSheets.append(root) }
                    } else { nonWindows.append((root, role)) }
                } catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                    rootDiscovery.recordInvalidRoot(root, failure: failure)
                }
            }
            try rootDiscovery.validateWindowSelection(hasMatch: !matches.isEmpty) {
                _ = try NativePlatform.ownedWindow(identity.pid, requested)
            }
            if matches.isEmpty {
                let hasUnreadableElements = recoveryCache.values.contains(where: \.hasUnreadableElements)
                let limited = recoveryCache.values.contains(where: \.elementLimitReached)
                var lines: [String] = []
                if hasUnreadableElements { lines.append(AXTextFormatter.incompleteDiscovery) }
                if limited { lines.append(AXTextFormatter.truncation(maxElements: maxElements, maxDepth: nil)) }
                return AXProjection(tree: lines.joined(separator: "\n"), elements: [], indexed: [:], focusedWindowID: focusedID,
                                    truncated: limited, hasUnreadableElements: hasUnreadableElements)
            }
            let dialog = try matches.contains { root in
                do {
                    let role = try string(root, "AXRole")
                    let subrole = try string(root, "AXSubrole")
                    let identifier = try string(root, "AXIdentifier")
                    return role == "AXSheet" || ["AXDialog", "AXSystemDialog", "AXSheet"].contains(subrole ?? "") || ["open-panel", "save-panel"].contains(identifier ?? "")
                } catch let failure as NativeFailure where failure.accessibilityError == AXError.invalidUIElement.rawValue {
                    rootDiscovery.recordInvalidRoot(root, failure: failure)
                    // Unknown dialog metadata cannot establish that application menus belong in this scope.
                    return true
                }
            }
            roots = matches + nonWindows.filter { !dialog || $0.role != "AXMenuBar" }.map(\.element)
                + (dialog ? [] : anonymousSheets)
        }
        let rootObservation = AXObservedChildren(
            entries: requested == nil ? appChildren.entries + roots.dropFirst(appRootCount).map(Optional.some) : roots.map(Optional.some),
            parentIncomplete: requested == nil ? appChildren.parentIncomplete : appChildren.hasUnreadableElements,
            elementLimitReached: appChildren.elementLimitReached)
        return try AXTreeProjection.project(roots: rootObservation, focusedWindowID: focusedID, windowScoped: requested != nil,
            maxElements: maxElements, maxDepth: maxDepth, includeMenus: includeMenus, details: details,
            checkCancellation: { try self.cancellation.check() }, read: { element in
                if let failure = rootDiscovery.invalidRoots[element] { throw failure }
                return try self.readNode(element, includeMenus: includeMenus, readChildren: { observation in
                    try observedChildren(element, observation.attribute("AXChildren"))
                })
            })
    }

    private func readNode(_ element: AXUIElement, includeMenus: Bool,
                          readChildren: (AXNodeObservation) throws -> AXObservedChildren) throws -> AXReadNode {
        let observation = try nodeObservation(attributes: metadata(element), fallback: { try self.attribute(element, $0) })
        let role = observation.role
        let observed = observation.attribute
        let title = try stringValue(observed("AXTitle"), attribute: "AXTitle")
        let value = try controlValue(observed("AXValue"))
        let placeholder = try stringValue(observed("AXPlaceholderValue"), attribute: "AXPlaceholderValue")
        let description = try stringValue(observed("AXDescription"), attribute: "AXDescription")
        let actionNames = try self.actions(element)
        let writability = try Self.observationWritability(role: role) { try writable(element, $0, forDiscovery: $1) }
        let valueWritable = writability.value
        let enabled = try booleanValue(observed("AXEnabled"), attribute: "AXEnabled")
        let selected = try booleanValue(observed("AXSelected"), attribute: "AXSelected")
        let selectionWritable = writability.selection
        let selectedRange = AXTextNode.textRoles.contains(role) ? try textRange(observed("AXSelectedTextRange")) : nil
        let selectedText = AXTextNode.textRoles.contains(role) ? try stringValue(observed("AXSelectedText"), attribute: "AXSelectedText") : nil
        let identifier = try stringValue(observed("AXIdentifier"), attribute: "AXIdentifier")
        let subrole = try stringValue(observed("AXSubrole"), attribute: "AXSubrole")
        let help = try stringValue(observed("AXHelp"), attribute: "AXHelp")
        let rawURL = try observed("AXURL")
        let url: String?
        if let rawURL, CFGetTypeID(rawURL) == CFURLGetTypeID() { url = (rawURL as? URL)?.absoluteString }
        else { url = try stringValue(rawURL, attribute: "AXURL") }
        let focused = try booleanValue(observed("AXFocused"), attribute: "AXFocused")
        let expanded = try booleanValue(observed("AXExpanded"), attribute: "AXExpanded")
        var node = AXTextNode(index: nil, role: role, title: title, value: value, description: description,
                              actions: actionNames, enabled: enabled, valueWritable: valueWritable,
                              selectionWritable: selectionWritable, selected: selected, selectedRange: selectedRange,
                              selectedText: selectedText, subrole: subrole, placeholder: placeholder, help: help,
                              identifier: identifier, url: url, focused: focused, expanded: expanded)
        node.validateSelection()
        let omitted = node.omitted
        if !omitted, let position = try observed("AXPosition") { node.bounds = try bounds(position: position, size: observed("AXSize")) }
        let children = role == "AXMenuBarItem" && !includeMenus && !omitted ? AXObservedChildren() : try readChildren(observation)
        return AXReadNode(text: node, children: children)
    }

    func enclosingWindow(_ element: AXUIElement) throws -> (element: AXUIElement, id: UInt32) {
        var current: AXUIElement? = element
        var visited: [AXUIElement] = []
        for _ in 0..<100 {
            guard let node = current else { break }
            if visited.contains(where: { CFEqual($0, node) }) { break }
            visited.append(node)
            let role = try string(node, "AXRole")
            if role == "AXWindow" || role == "AXSheet", let id = try windowID(node) {
                return (node, id)
            }
            current = try self.element(node, "AXParent")
        }
        throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Pointer input requires an enclosing window or sheet. For a menu item’s default action, use app.invoke(id)")
    }
    /// A system file panel renders in its host window but receives input in the panel service's window.
    func filePanelRecipient(_ node: AXUIElement, owner: ProcessIdentity, catalog: ApplicationCatalogSnapshot, budget: inout AXChildRecoveryBudget) throws -> (process: ProcessIdentity, windowID: UInt32)? {
        let identifier: String?
        do { identifier = try stringValue(attribute(node, "AXIdentifier", allowMissingMetadata: false), attribute: "AXIdentifier") }
        catch let error as NativeFailure where error.attribute == "AXIdentifier" && error.accessibilityError == AXError.failure.rawValue {
            if let role = try string(node, "AXRole"), role != "AXWindow" && role != "AXSheet" { return nil }
            throw Self.beforeInput("PANEL_NOT_READY", "Could not identify the window or sheet.")
        }
        guard ["open-panel", "save-panel"].contains(identifier ?? "") else { return nil }
        guard let hostID = try windowID(node) else { throw Self.beforeInput("PANEL_NOT_READY", "File panel has no window ID.") }
        _ = try NativePlatform.ownedWindow(owner.pid, hostID)
        var recipient: (ProcessIdentity, UInt32)?
        let children = try readChildren(node, budget: &budget)
        guard !children.incomplete else { throw Self.beforeInput("PANEL_NOT_READY", "File panel recipient discovery is incomplete.") }
        let windows = NativePlatform.windows(allLayers: true)
        for case let child? in children.entries {
            guard let id = try windowID(child) else {
                // A local control without a window cannot be the panel service's input window.
                if try processID(child) == owner.pid, let role = try string(child, "AXRole"), role != "AXWindow" && role != "AXSheet" { continue }
                throw Self.beforeInput("PANEL_NOT_READY", "File panel child window could not be identified.")
            }
            guard let window = windows.first(where: { $0.windowID == id }) else {
                throw Self.beforeInput("PANEL_NOT_READY", "File panel child window could not be identified.")
            }
            guard window.pid != owner.pid else { continue }
            guard catalog.application(window.pid)?.bundleID == "com.apple.appkit.xpc.openAndSavePanelService" else {
                throw Self.beforeInput("PANEL_NOT_READY", "File panel refers to an unsupported remote process.")
            }
            let process = try NativePlatform.identity(window.pid)
            if let old = recipient, old.0 != process || old.1 != id { throw Self.beforeInput("PANEL_NOT_READY", "File panel has ambiguous remote recipients.") }
            recipient = (process, id)
        }
        guard let (process, id) = recipient else { throw Self.beforeInput("PANEL_NOT_READY", "System file panel has no ready input recipient.") }
        var focus = try element(AXUIElementCreateApplication(process.pid), "AXFocusedWindow")
        for _ in 0..<100 {
            guard let focused = focus else { break }
            if try windowID(focused) == id { try NativePlatform.verify(process); return (process, id) }
            focus = try element(focused, "AXParent")
        }
        throw Self.beforeInput("PANEL_NOT_READY", "System file panel focus changed.")
    }

    func keyboardRecipient(_ owner: ProcessIdentity, catalog: ApplicationCatalogSnapshot, budget: inout AXChildRecoveryBudget) throws -> ProcessIdentity {
        var current = try element(AXUIElementCreateApplication(owner.pid), "AXFocusedWindow")
        var visited: [AXUIElement] = []
        for _ in 0..<100 {
            guard let node = current else { return owner }
            if visited.contains(where: { CFEqual($0, node) }) { break }
            visited.append(node)
            if let panel = try filePanelRecipient(node, owner: owner, catalog: catalog, budget: &budget) { return panel.process }
            current = try element(node, "AXParent")
        }
        throw Self.beforeInput("PANEL_NOT_READY", "Focused accessibility ancestry exceeds the traversal limit.")
    }
}

private struct ProcessIdentityKey: Hashable {
    let pid: Int32
    let seconds: UInt64
    let microseconds: UInt64
    init(_ value: ProcessIdentity) { pid = value.pid; seconds = value.startedSeconds; microseconds = value.startedMicroseconds }
}
