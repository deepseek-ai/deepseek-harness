// Read the test process's own windows so AppKit exercises real AX range reads without an Accessibility grant.
import AppKit
import ApplicationServices

@MainActor private final class ChildFixtureWindow: NSWindow {
    var childList: [Any]?
    var pressed: [String] = []
    var inputLog: URL?

    override func accessibilityChildren() -> [Any]? { childList ?? super.accessibilityChildren() }
    var pasteCalls: [String] = []
    @objc func paste(_ sender: NSMenuItem) { pasteCalls.append(sender.title) }
    @objc func press(_ sender: NSButton) {
        pressed.append(sender.title)
        if sender.title == "Identify as open panel" { setAccessibilityIdentifier("open-panel") }
        if let inputLog { try! JSONEncoder().encode(pressed).write(to: inputLog, options: .atomic) }
    }

    func button(_ title: String) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(press(_:)))
        contentView?.addSubview(button)
        return button
    }
}

@MainActor private final class ChildFixtureMenu: NSMenu {
    override func accessibilityChildren() -> [Any]? {
        let items = super.accessibilityChildren() ?? []
        return [NSNull()] + items + [NSNull()]
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
        good.title = "Healthy target"
        bad.title = "Partial target"
        defer { bad.close(); good.close() }
        good.childList = [good.button("Healthy window")]
        let before = bad.button("Before gap"), after = bad.button("After gap")
        let group = NSView()
        bad.contentView?.addSubview(group)
        group.setAccessibilityElement(true)
        group.setAccessibilityRole(.group)
        group.setAccessibilityChildren([NSTextField(labelWithString: "Nested child")])
        bad.childList = [before, NSNull(), after, group, NSDate(timeIntervalSince1970: 0)]
        let menuBar = NSMenu(), editItem = NSMenuItem(), edit = ChildFixtureMenu(title: "Edit")
        edit.autoenablesItems = false
        func addPaste(_ name: String) {
            let item = NSMenuItem(title: name, action: #selector(ChildFixtureWindow.paste(_:)), keyEquivalent: "v")
            item.target = bad
            edit.addItem(item)
        }
        addPaste("Paste")
        editItem.submenu = edit
        menuBar.addItem(editItem)
        app.mainMenu = menuBar
        good.orderBack(nil)
        bad.orderBack(nil)
        app.finishLaunching()

        if let path = CommandLine.arguments.dropFirst().first {
            bad.inputLog = URL(fileURLWithPath: path)
            before.frame = NSRect(x: 10, y: 15, width: 100, height: 28)
            after.frame = NSRect(x: 120, y: 55, width: 100, height: 28)
            bad.childList?.append(bad.button("Identify as open panel"))
            app.setActivationPolicy(.regular)
            bad.makeKeyAndOrderFront(nil)
            app.activate(ignoringOtherApps: true)
            let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown]) { event in
                if bad.pressed.contains("Identify as open panel") {
                    bad.pressed.append("Unexpected input")
                    try! JSONEncoder().encode(bad.pressed).write(to: URL(fileURLWithPath: path), options: .atomic)
                }
                return event
            }
            defer { if let monitor { NSEvent.removeMonitor(monitor) } }
            print("READY"); fflush(stdout)
            app.run()
            return
        }

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

        guard let bar = try access.element(ownApp, "AXMenuBar") else { throw NativeFailure(code: "FIXTURE", message: "Missing menu bar") }
        let menus = try access.children(bar).flatMap { try access.children($0) }
        let failed = menus.contains { menu in
            var children: CFTypeRef?
            return AXUIElementCopyAttributeValue(menu, kAXChildrenAttribute as CFString, &children) == .failure
        }
        try check(failed, "The menu must reject bulk AXChildren with -25200")
        // NSMenu exposes its actual menu items through count/range even when its whole attribute fails.
        let paste = try access.pasteCommand(getpid(), maxElements: 2000, maxDepth: 25)
        try access.perform(paste, "AXPress")
        let pasteDeadline = Date().addingTimeInterval(3)
        while bad.pasteCalls.isEmpty && Date() < pasteDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        try check(bad.pasteCalls == ["Paste"], "Unique recovered Paste command did not execute exactly once")
        addPaste("Second Paste")
        do {
            _ = try access.pasteCommand(getpid(), maxElements: 2000, maxDepth: 25)
            throw NativeFailure(code: "FIXTURE", message: "Selected a Paste command from an ambiguous menu")
        } catch let failure as NativeFailure where failure.code == "UNSUPPORTED" {
            try check(failure.message.contains("ambiguous") && failure.message.contains("No input was dispatched"), failure.message)
        }
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
        let goodID = UInt32(good.windowNumber), badID = UInt32(bad.windowNumber)
        app.setAccessibilityWindows([good, bad])
        var exhausted = AXChildRecoveryBudget(maxElements: 0, timeout: 0)
        let exact = try access.windowElement(badID, owner: identity, budget: &exhausted, requireComplete: true)
        try check(exact == badRoot, "An earlier window's unreadable children blocked an exact ID")

        app.setAccessibilityWindows([good])
        bad.setAccessibilityRole(.sheet)
        for children: [Any] in [[bad, NSNull()], [NSNull(), bad]] {
            good.childList = children
            var budget = AXChildRecoveryBudget(maxElements: 16, timeout: 3)
            let sheet = try access.windowElement(badID, owner: identity, budget: &budget, requireComplete: true)
            try check(sheet == badRoot && budget.requests < 16, "A recovered sheet was lost at the gap")
            let left = budget.requests
            _ = try access.windowElement(goodID, owner: identity, budget: &budget, requireComplete: true)
            try check(budget.requests == left, "An exact window consumed additional recovery requests")
            for (requests, time): (Int, Float) in [(1, 3), (16, 0)] {
                var insufficient = AXChildRecoveryBudget(maxElements: requests, timeout: time)
                var geometryBudget = insufficient
                let geometry = try access.windowElement(badID, owner: identity, budget: &geometryBudget, requireComplete: false)
                try check(geometry == nil, "Incomplete optional AX geometry should leave the CG frame available")
                do {
                    _ = try access.windowElement(badID, owner: identity, budget: &insufficient, requireComplete: true)
                    throw NativeFailure(code: "FIXTURE", message: "Unseen sheet accepted after recovery exhausted")
                } catch let failure as NativeFailure where failure.code == "WINDOW_UNAVAILABLE" {
                    try check(failure.message.contains("No input was dispatched. Read fresh state"), failure.message)
                }
            }
        }
        print("Passed AX range recovery, sibling actions, exact window and recovered sheet selection, and recovery budgets.")
    }

    private static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw NativeFailure(code: "FIXTURE", message: message) }
    }
}
