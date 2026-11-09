import AppKit
import Darwin

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
}

/// Publishes actual window geometry and received actions independently of the helper.
final class FloatingWindowFixture: NSObject, NSApplicationDelegate {
    let statePath: String
    var main: NSWindow!
    var panel: FloatingPanel!
    var button: NSButton!
    var closeButton: NSButton!
    var panelID = 0
    var count = 0
    var resized = false
    var closed = false
    var panelSize: [CGFloat] = []
    var buttonPoint: [CGFloat] = []
    var resizeControl: DispatchSourceSignal?
    var visibilityControl: DispatchSourceSignal?
    var observer: Timer?

    init(statePath: String) { self.statePath = statePath }
    func applicationDidFinishLaunching(_ notification: Notification) {
        main = NSWindow(contentRect: NSRect(x: 120, y: 180, width: 420, height: 300),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
        main.title = "Floating fixture main"
        closeButton = NSButton(title: "Close panel", target: self, action: #selector(closePanel))
        closeButton.frame = NSRect(x: 280, y: 30, width: 120, height: 35)
        main.contentView!.addSubview(closeButton)
        panel = FloatingPanel(contentRect: NSRect(x: 220, y: 250, width: 240, height: 140),
                              styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Floating fixture panel"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        for window in [main!, panel!] {
            window.isReleasedWhenClosed = false
            window.animationBehavior = .none
            window.collectionBehavior = [.canJoinAllApplications, .stationary]
        }
        button = NSButton(title: "Increment floating panel", target: self, action: #selector(increment))
        button.frame = NSRect(x: 20, y: 45, width: 200, height: 40)
        panel.contentView!.addSubview(button)
        main.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panelID = panel.windowNumber
        signal(SIGUSR1, SIG_IGN)
        let visibility = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        visibility.setEventHandler { [weak self] in
            guard let self, let panel = self.panel else { return }
            if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
            self.persist()
        }
        visibility.resume()
        visibilityControl = visibility
        signal(SIGUSR2, SIG_IGN)
        let control = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        control.setEventHandler { [weak self] in
            guard let self else { return }
            self.panel.setContentSize(NSSize(width: 280, height: 180))
            self.resized = true
            self.persist()
        }
        control.resume()
        resizeControl = control
        // WindowServer visibility and frame updates settle after AppKit requests return.
        observer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.persist() }
        persist()
        print("READY")
        fflush(stdout)
    }
    @objc func increment() { count += 1; persist() }
    @objc func closePanel() {
        panel.close()
        panel = nil
        button = nil
        closed = true
        persist()
    }
    func persist() {
        let rows = CGWindowListCopyWindowInfo(.excludeDesktopElements, kCGNullWindowID) as? [[String: Any]] ?? []
        let row = rows.first { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == panelID }
        if let panel, let button {
            let rect = button.convert(button.bounds, to: nil)
            panelSize = [panel.frame.width, panel.frame.height]
            buttonPoint = [rect.midX, panel.frame.height - rect.midY]
        }
        let bounds = row?[kCGWindowBounds as String] as? [String: NSNumber]
        let closeRect = closeButton.convert(closeButton.bounds, to: nil)
        let data = try! JSONSerialization.data(withJSONObject: [
            "pid": getpid(), "mainWindowId": main.windowNumber, "panelWindowId": panelID,
            "panelLayer": row?[kCGWindowLayer as String] ?? -1,
            "panelOnScreen": row?[kCGWindowIsOnscreen as String] ?? false,
            "serverSize": [bounds?["Width"]?.doubleValue ?? 0, bounds?["Height"]?.doubleValue ?? 0],
            "panelSize": panelSize, "buttonPoint": buttonPoint,
            "closePoint": [closeRect.midX, main.frame.height - closeRect.midY],
            "count": count, "resized": resized, "closed": closed,
        ])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = FloatingWindowFixture(statePath: CommandLine.arguments[1])
app.delegate = fixture
app.run()
