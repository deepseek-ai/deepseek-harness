// Disposable AppKit application records received input and rich text independently of the driver.
import AppKit

final class CapabilityPad: NSView {
    var received: ((NSEvent) -> Void)?
    var pressed: (() -> Void)?
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityPerformPress() -> Bool { pressed?(); return true }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private func record(_ event: NSEvent) { window?.makeFirstResponder(self); received?(event) }
    override func mouseDown(with event: NSEvent) { record(event) }
    override func mouseDragged(with event: NSEvent) { record(event) }
    override func mouseUp(with event: NSEvent) { record(event) }
    override func rightMouseDown(with event: NSEvent) { record(event) }
    override func rightMouseDragged(with event: NSEvent) { record(event) }
    override func rightMouseUp(with event: NSEvent) { record(event) }
    override func otherMouseDown(with event: NSEvent) { record(event) }
    override func otherMouseDragged(with event: NSEvent) { record(event) }
    override func otherMouseUp(with event: NSEvent) { record(event) }
    override func keyDown(with event: NSEvent) { received?(event) }
    override func keyUp(with event: NSEvent) { received?(event) }
    override func draw(_ rect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.15).setFill(); bounds.fill()
        ("Middle-button, drag and keypad receiver" as NSString).draw(at: NSPoint(x: 16, y: 16),
            withAttributes: [.font: NSFont.systemFont(ofSize: 18)])
    }
}

final class CapabilityTextView: NSTextView {
    var attemptedPaste: ((Bool) -> Void)?
    override func paste(_ sender: Any?) {
        let owned = NSPasteboard.general.data(forType: NSPasteboard.PasteboardType("org.deepseek-harness.cua.clipboard-owner")) != nil
        attemptedPaste?(owned)
        if owned { super.paste(sender) }
    }
}

final class CapabilitiesFixture: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
    let statePath: String
    var window: NSWindow!
    var text: CapabilityTextView!
    var pasteAttempts: [Bool] = []
    var pad: CapabilityPad!
    var events: [[String: Any]] = []
    var axPresses = 0
    init(statePath: String) { self.statePath = statePath }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let bar = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit
        bar.addItem(editItem)
        NSApplication.shared.mainMenu = bar
        window = NSWindow(contentRect: NSRect(x: 140, y: 160, width: 640, height: 500),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "DSH CUA capability checks"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
        text = CapabilityTextView(frame: NSRect(x: 20, y: 230, width: 600, height: 235))
        text.isRichText = true
        text.isEditable = true
        text.font = .systemFont(ofSize: 18)
        text.string = "第一😀 target，第二😀 target."
        text.setAccessibilityIdentifier("dsh-cua-rich-text")
        text.setAccessibilityLabel("Rich text fixture")
        text.delegate = self
        text.attemptedPaste = { [weak self] owned in self?.pasteAttempts.append(owned); self?.persist() }
        window.contentView!.addSubview(text)
        pad = CapabilityPad(frame: NSRect(x: 20, y: 25, width: 600, height: 170))
        pad.setAccessibilityTitle("Input receiver")
        pad.pressed = { [weak self] in self?.axPresses += 1; self?.persist() }
        pad.received = { [weak self] event in
            guard let self else { return }
            var value: [String: Any] = ["type": event.type.rawValue, "timestamp": event.timestamp, "flags": event.modifierFlags.rawValue,
                                       "shift": event.modifierFlags.contains(.shift), "command": event.modifierFlags.contains(.command)]
            if [.keyDown, .keyUp].contains(event.type) { value["keyCode"] = event.keyCode; value["characters"] = event.characters ?? "" }
            else { value["button"] = event.buttonNumber }
            self.events.append(value)
            self.persist()
        }
        window.contentView!.addSubview(pad)
        if Bundle.main.object(forInfoDictionaryKey: "DSHFixtureBackground") as? Bool == true || CommandLine.arguments.contains("--background") {
            window.orderFront(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(text)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        persist()
    }
    func applicationDidBecomeActive(_ notification: Notification) { persist() }
    func applicationDidResignActive(_ notification: Notification) { persist() }
    func windowDidBecomeKey(_ notification: Notification) { persist() }
    func windowDidResignKey(_ notification: Notification) { persist() }
    func textDidChange(_ notification: Notification) { persist() }
    func textViewDidChangeSelection(_ notification: Notification) { if pad != nil { persist() } }
    func persist() {
        guard let window, let text, let pad else { return }
        var runs: [[String: Any]] = []
        if let storage = text.textStorage {
            storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length)) { attributes, range, _ in
                let font = attributes[.font] as? NSFont
                var run: [String: Any] = ["text": (storage.string as NSString).substring(with: range),
                    "bold": font.map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } ?? false]
                if let link = attributes[.link] { run["link"] = String(describing: link) }
                runs.append(run)
            }
        }
        let frame = pad.convert(pad.bounds, to: nil)
        let selection = text.selectedRange()
        let result: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windowId": window.windowNumber,
            "active": NSApplication.shared.isActive, "keyWindow": window.isKeyWindow,
            "textFocused": window.firstResponder === text, "pasteAttempts": pasteAttempts,
            "text": text.string, "selection": [selection.location, selection.length], "runs": runs, "events": events, "axPresses": axPresses,
            "pad": [frame.minX, window.frame.height - frame.maxY, frame.width, frame.height]]
        try! JSONSerialization.data(withJSONObject: result).write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let statePath = CommandLine.arguments.dropFirst().first ?? Bundle.main.object(forInfoDictionaryKey: "DSHFixtureStatePath") as? String
if let statePath {
    let application = NSApplication.shared
    application.setActivationPolicy(.regular)
    let fixture = CapabilitiesFixture(statePath: statePath)
    application.delegate = fixture
    application.run()
} else {
    fputs("CapabilitiesFixture requires a state file path\n", stderr)
    exit(2)
}
