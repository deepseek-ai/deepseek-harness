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
        bad.childList = [before, NSNull(), after, group]
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
        try check(!complete.truncated && !complete.incomplete && complete.tree.contains("Healthy window"), "An unrelated window reported missing children")
        let partial = try project(bad)
        try check(!partial.truncated && partial.incomplete, "Unreadable children must only set incomplete")
        let lines = partial.tree.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let gap = lines.firstIndex(of: "[One child could not be read.]"), gap > 0, gap + 1 < lines.count else {
            throw NativeFailure(code: "FIXTURE", message: "Missing positional marker in the partial tree")
        }
        try check(lines[gap - 1].contains("AXButton \"Before gap\"") && lines[gap + 1].contains("AXButton \"After gap\""), "Missing siblings around the positional marker")
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
        try check(limited.truncated && limited.incomplete && limited.tree.contains("maxDepth=1"), "Traversal and AX failures must report both flags")
        print("Passed real AX range recovery, sibling actions, window scoping and independent observation flags.")
    }

    private static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw NativeFailure(code: "FIXTURE", message: message) }
    }
}
