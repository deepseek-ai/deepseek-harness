// Read the test process's own windows so AppKit exercises real AX range reads without an Accessibility grant.
import AppKit
import ApplicationServices
import Testing
@testable import CuaNative

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

@MainActor @Test func realAXRangesKeepActionsAndScopePartialReadsToTheSelectedWindow() throws {
    _ = NSApplication.shared
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

    let access = AXAccess(timeout: 3, cancellation: CancellationLatch())
    let identity = try NativePlatform.identity(getpid())
    func project(_ window: NSWindow, depth: Int = 12) throws -> AXProjection {
        try access.project(identity: identity, windowID: UInt32(window.windowNumber),
                           maxElements: 1000, maxDepth: depth)
    }

    let complete = try project(good)
    #expect(!complete.truncated && !complete.incomplete)
    #expect(complete.tree.contains("Healthy window"))
    let partial = try project(bad)
    #expect(!partial.truncated && partial.incomplete)
    let lines = partial.tree.components(separatedBy: "\n")
    let a = try #require(lines.firstIndex { $0.contains("\"Before gap\"") })
    let b = try #require(lines.firstIndex { $0.contains("\"After gap\"") })
    #expect(Array(lines[(a + 1)..<b]).map { $0.trimmingCharacters(in: .whitespaces) } == ["[One child could not be read.]"])
    for title in ["Before gap", "After gap"] {
        let id = try #require(partial.elements.first { $0["title"].string == title }?["elementId"].string.flatMap(Int.init))
        try access.perform(try #require(partial.indexed[id]), "AXPress")
    }
    let deadline = Date().addingTimeInterval(3)
    while bad.pressed.count < 2 && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    #expect(bad.pressed == ["Before gap", "After gap"])
    let limited = try project(bad, depth: 1)
    #expect(limited.truncated && limited.incomplete)
    #expect(limited.tree.contains("maxDepth=1"))
}
