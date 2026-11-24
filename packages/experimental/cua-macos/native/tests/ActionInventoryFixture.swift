// Compare the fixture's public AX inventory with the helper observing the same controls.
import AppKit
import ApplicationServices

final class ActionTarget: NSObject {
    let outcome: String
    let state: URL
    init(_ outcome: String, _ state: URL) { self.outcome = outcome; self.state = state }

    @objc func mark(_ sender: NSAccessibilityCustomAction) -> Bool {
        (try? Data(outcome.utf8).write(to: state, options: .atomic)) != nil
    }
}

final class ActionButton: NSView {
    var custom: [NSAccessibilityCustomAction] = []
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Audit button" }
    override func accessibilityCustomActions() -> [NSAccessibilityCustomAction]? { custom }
    override func accessibilityPerformPress() -> Bool { true }
}

func read(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
}

func inspect(_ element: AXUIElement, depth: Int, into inventory: inout [String: Any]) {
    guard depth < 8 else { return }
    if let id = read(element, kAXIdentifierAttribute as CFString) as? String, id.hasPrefix("audit-") {
        var actions: CFArray?, attributes: CFArray?
        precondition(AXUIElementCopyActionNames(element, &actions) == .success)
        precondition(AXUIElementCopyAttributeNames(element, &attributes) == .success)
        let names = actions as! [String]
        let native: [[String: Any]] = names.map { name in
            var text: CFString?
            _ = AXUIElementCopyActionDescription(element, name as CFString, &text)
            return ["name": name, "description": (text as String?).flatMap { $0.isEmpty ? nil : $0 } as Any]
        }
        var writable: [String] = [], arrayAttributes: [String] = []
        for name in attributes as! [String] {
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue else { continue }
            writable.append(name)
            if let value = read(element, name as CFString), CFGetTypeID(value) == CFArrayGetTypeID() {
                arrayAttributes.append(name)
            }
        }
        inventory[id] = ["native": native, "writable": writable, "arrays": arrayAttributes]
    }
    for child in read(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] {
        inspect(child, depth: depth + 1, into: &inventory)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let state = URL(fileURLWithPath: CommandLine.arguments[1])
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 350, height: 410),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Action inventory"
window.setAccessibilityIdentifier("audit-window")
let custom = ActionButton()
let targets = ["first", "second"].map { ActionTarget($0, state) }
custom.custom = targets.map { NSAccessibilityCustomAction(name: "Mark", target: $0, selector: #selector(ActionTarget.mark(_:))) }
let disabled = NSButton(title: "Disabled", target: nil, action: nil)
let editor = NSTextView()
editor.string = "alpha beta gamma delta"
editor.isEditable = true
let controls: [(String, NSView)] = [("editor", editor), ("check", NSButton(checkboxWithTitle: "Check", target: nil, action: nil)),
                                    ("stepper", NSStepper()), ("custom", custom), ("field", NSTextField(string: "fixture contents")),
                                    ("disabled", disabled), ("slider", NSSlider(value: 3, minValue: 0, maxValue: 10, target: nil, action: nil))]
for (index, entry) in controls.enumerated() {
    entry.1.frame = NSRect(x: 15, y: 15 + index * 45, width: 200, height: 35)
    entry.1.setAccessibilityIdentifier("audit-" + entry.0)
    window.contentView!.addSubview(entry.1)
}
window.orderFront(nil)
// Take the external snapshot while the button is enabled. Query AX after disabling it.
DispatchQueue.main.async {
    print("READY")
    fflush(stdout)
}
DispatchQueue.global().async {
    guard readLine() == "observe" else { return }
    DispatchQueue.main.sync { disabled.isEnabled = false }
    var inventory: [String: Any] = [:]
    inspect(AXUIElementCreateApplication(getpid()), depth: 0, into: &inventory)
    let data = try! JSONSerialization.data(withJSONObject: inventory)
    FileHandle.standardOutput.write(data + Data([10]))
    if readLine() == "selections" {
        let ranges = DispatchQueue.main.sync { editor.selectedRanges.map { [$0.rangeValue.location, $0.rangeValue.length] } }
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ranges) + Data([10]))
    }
}
app.run()
