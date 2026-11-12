// Read the test process's own windows so AppKit exercises real AX range reads without an Accessibility grant.
import AppKit
import ApplicationServices

@MainActor private final class ChildFixtureWindow: NSWindow {
    var childList: [Any]?
    var pressed: [String] = []

    override func accessibilityChildren() -> [Any]? { childList ?? super.accessibilityChildren() }
    @objc func press(_ sender: NSButton) { pressed.append(sender.title) }

    func button(_ title: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(press(_:)))
        contentView?.addSubview(button)
        return button
    }
}

@main enum ChildProjectionFixture {
    @MainActor static func main() throws {
        let app = NSApplication.shared
        func makeWindow() -> ChildFixtureWindow {
            let window = ChildFixtureWindow(contentRect: NSRect(x: 40, y: 40, width: 240, height: 120),
                                            styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            return window
        }
        let good = makeWindow(), bad = makeWindow()
        defer { bad.close(); good.close() }
        good.childList = [good.button("Healthy window")]
        let before = bad.button("Before gap"), after = bad.button("After gap")
        let group = NSView()
        bad.contentView?.addSubview(group)
        group.setAccessibilityElement(true)
        group.setAccessibilityRole(.group)
        group.setAccessibilityChildren([NSTextField(labelWithString: "Nested child")])
        bad.childList = [before, NSNull(), after, group, NSDate(timeIntervalSince1970: 0)]
        good.orderBack(nil)
        bad.orderBack(nil)
        app.finishLaunching()

        let access = AXAccess(timeout: 3, cancellation: CancellationLatch())
        let identity = try NativePlatform.identity(getpid())
        func project(_ window: NSWindow, depth: Int = 12) throws -> AXProjection {
            try access.project(identity: identity, windowID: UInt32(window.windowNumber),
                               maxElements: 1000, maxDepth: depth)
        }

        let ownApp = AXUIElementCreateApplication(getpid())
        let windows = try access.children(ownApp, "AXWindows")
        guard let badRoot = try windows.first(where: { try access.windowID($0) == UInt32(bad.windowNumber) }) else {
            throw NativeFailure(code: "FIXTURE", message: "AppKit did not expose the test window")
        }
        var whole: CFTypeRef?
        try check(AXUIElementCopyAttributeValue(badRoot, kAXChildrenAttribute as CFString, &whole) == .failure, "AXChildren must return -25200")

        let complete = try project(good)
        try check(!complete.truncated && !complete.hasUnreadableElements && complete.tree.contains("Healthy window"), "An unrelated window reported missing children")
        let partial = try project(bad)
        try check(!partial.truncated && partial.hasUnreadableElements, "Unreadable children must only set hasUnreadableElements")
        let lines = partial.tree.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let gaps = lines.indices.filter { lines[$0] == "[One child could not be read.]" }
        guard let left = lines.firstIndex(where: { $0.contains("AXButton") && $0.contains("\"Before gap\"") }),
              let right = lines.firstIndex(where: { $0.contains("AXButton") && $0.contains("\"After gap\"") }) else {
            throw NativeFailure(code: "FIXTURE", message: "Missing controls in the partial tree")
        }
        try check(gaps.count == 2 && left < gaps[0] && gaps[0] < right && right < gaps[1],
                  "NSNull and the non-element range value must keep their sibling positions")
        for title in ["Before gap", "After gap"] {
            guard let raw = partial.elements.first(where: { $0["title"].string == title })?["elementId"].string,
                  let index = Int(raw), let element = partial.indexed[index] else {
                throw NativeFailure(code: "FIXTURE", message: "Missing actionable button " + title)
            }
            try access.perform(element, "AXPress")
        }
        let deadline = Date().addingTimeInterval(3)
        while bad.pressed.count < 2 && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        try check(bad.pressed == ["Before gap", "After gap"], "Both buttons must receive AXPress")
        let limited = try project(bad, depth: 1)
        try check(limited.truncated && limited.hasUnreadableElements && limited.tree.contains("maxDepth=1"), "Traversal and AX failures must report both flags")
        app.setAccessibilityChildren([good])
        app.setAccessibilityWindows([good])
        app.setAccessibilityFocusedWindow(good)
        let unexposed = try project(bad)
        try check(unexposed.tree.isEmpty && !unexposed.hasUnreadableElements, "Exhaustive discovery should report an AX-less window")
        good.childList = [NSNull()]
        let uncertain = try project(bad)
        try check(uncertain.hasUnreadableElements && !uncertain.truncated && uncertain.indexed.isEmpty,
                  "Partial window discovery must not expose controls from another window")
        print("Passed real AX range recovery, sibling actions, window scoping and independent observation flags.")
    }

    private static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw NativeFailure(code: "FIXTURE", message: message) }
    }
}
