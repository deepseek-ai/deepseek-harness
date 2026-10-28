// A foreground-sensitive Paste receiver records AX command delivery independently of clipboard consumption.
import AppKit

final class PasteFixture: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    let statePath: String
    let label: String
    var window: NSWindow!
    var text: NSTextView!
    var pasteCalls: [Bool] = []
    init(statePath: String, label: String) { self.statePath = statePath; self.label = label }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.autoenablesItems = false
        let paste = NSMenuItem(title: "Paste", action: #selector(pasteText(_:)), keyEquivalent: "v")
        paste.target = self
        edit.addItem(paste)
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 140, y: 160, width: 460, height: 220),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = label
        window.animationBehavior = .none
        text = NSTextView(frame: NSRect(x: 20, y: 20, width: 420, height: 180))
        text.isRichText = false
        text.isEditable = true
        text.delegate = self
        window.contentView!.addSubview(text)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(text)
        NSApp.activate(ignoringOtherApps: true)
        persist()
        print("READY"); fflush(stdout)
    }
    @objc func pasteText(_ sender: Any?) {
        pasteCalls.append(NSApp.isActive)
        if NSApp.isActive { text.paste(sender) }
        persist()
    }
    func applicationDidBecomeActive(_ notification: Notification) { persist() }
    func applicationDidResignActive(_ notification: Notification) { persist() }
    func textDidChange(_ notification: Notification) { persist() }
    func persist() {
        guard let window, let text else { return }
        let state: [String: Any] = ["active": NSApp.isActive, "textFocused": window.firstResponder === text,
                                    "text": text.string, "pasteCalls": pasteCalls]
        try! JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = PasteFixture(statePath: CommandLine.arguments[1], label: CommandLine.arguments[2])
app.delegate = fixture
app.run()
