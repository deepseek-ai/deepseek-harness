import AppKit
import Darwin

/// Removes this app's AX roots while keeping its CG window and native button alive.
final class AxlessFixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let statePath: String
    var window: NSWindow!
    var button: NSButton!
    var savedChildren: [Any]?
    var hiddenAX = false
    var count = 0
    var resizeCount = 0
    var moved = false
    var controls: [DispatchSourceSignal] = []
    var stateObserver: Timer?

    init(statePath: String) { self.statePath = statePath }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 360, height: 180),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "DSH AXless window fixture"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
        button = NSButton(title: "Increment AXless fixture", target: self, action: #selector(increment))
        button.frame = NSRect(x: 40, y: 65, width: 280, height: 40)
        window.contentView!.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        savedChildren = NSApplication.shared.accessibilityChildren()
        for number in [SIGUSR1, SIGUSR2, SIGWINCH, SIGURG, SIGHUP, SIGALRM] {
            signal(number, SIG_IGN)
            let control = DispatchSource.makeSignalSource(signal: number, queue: .main)
            control.setEventHandler { [weak self] in
                guard let self else { return }
                switch number {
                case SIGUSR1, SIGUSR2: self.setAXHidden(number == SIGUSR1)
                case SIGWINCH:
                    self.resizeCount += 1
                    self.window.setContentSize(NSSize(width: 360 + 40 * self.resizeCount, height: 180 + 20 * self.resizeCount))
                    self.persist()
                case SIGHUP:
                    self.window.collectionBehavior = []
                    self.window.miniaturize(nil)
                case SIGALRM: NSApplication.shared.hide(nil)
                default:
                    self.window.setFrameOrigin(NSPoint(x: 180, y: 180))
                    self.moved = true
                    self.persist()
                }
            }
            control.resume()
            controls.append(control)
        }
        persist()
        // AppKit/Dock visibility can settle after their delegate notifications.
        stateObserver = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.persist() }
        print("READY")
        fflush(stdout)
    }
    @objc func increment() { count += 1; persist() }
    func applicationDidBecomeActive(_ notification: Notification) { persist() }
    func applicationDidResignActive(_ notification: Notification) { persist() }
    func applicationDidHide(_ notification: Notification) { persist() }
    func applicationDidUnhide(_ notification: Notification) { persist() }
    func windowDidMiniaturize(_ notification: Notification) { persist() }
    func windowDidDeminiaturize(_ notification: Notification) { persist() }
    func setAXHidden(_ hidden: Bool) {
        let app = NSApplication.shared
        app.setAccessibilityChildren(hidden ? [] : savedChildren)
        app.setAccessibilityWindows(hidden ? [] : [window!])
        app.setAccessibilityFocusedWindow(hidden ? nil : window)
        hiddenAX = hidden
        NSAccessibility.post(element: app, notification: .layoutChanged)
        persist()
    }
    func persist() {
        guard window != nil, button != nil else { return }
        let rect = button.convert(button.bounds, to: nil)
        let data = try! JSONSerialization.data(withJSONObject: [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "windowId": window.windowNumber,
            "hiddenAX": hiddenAX, "count": count, "resizeCount": resizeCount, "moved": moved,
            "hidden": NSApplication.shared.isHidden, "minimized": window.isMiniaturized,
            "active": NSApplication.shared.isActive,
            "size": [window.frame.width, window.frame.height],
            "buttonPoint": [rect.midX, window.frame.height - rect.midY],
        ])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let statePath = CommandLine.arguments.dropFirst().first ?? Bundle.main.object(forInfoDictionaryKey: "DSHFixtureStatePath") as? String
guard let statePath else { fatalError("Fixture requires a state path") }
let fixture = AxlessFixture(statePath: statePath)
app.delegate = fixture
app.run()
