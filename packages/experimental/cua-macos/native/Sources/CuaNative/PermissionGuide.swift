// A helper-owned drag source accompanies System Settings without requiring Accessibility access.
import AppKit
import ApplicationServices
import Foundation

struct PermissionGuideText: Sendable {
    let instruction: String
    let backLabel: String
    let finderLabel: String
    let unavailableMessage: String
    let settingsMessage: String
}

struct PermissionGuideApplication: Sendable {
    let url: URL
    let identifier: String
    var name: String { url.lastPathComponent }

    func validatedURL() throws(NativeFailure) -> URL {
        guard url.isFileURL, url.pathExtension == "app",
              let application = InstalledApplication.read(url), application.bundleID == identifier,
              FileManager.default.isExecutableFile(atPath: application.executablePath) else {
            throw NativeFailure(code: "APPLICATION_UNAVAILABLE", message: "The permission application is unavailable; enable Computer Use again")
        }
        return url
    }
}

@MainActor protocol PermissionGuidePresenting: AnyObject {
    func show(application: PermissionGuideApplication, text: PermissionGuideText, owner: UUID,
              interval: TimeInterval, granted: @escaping @MainActor () -> Bool) throws(NativeFailure)
    func reportSettingsFailure()
    func dismiss()
    func close(owner: UUID)
}

struct PermissionGuideWindow {
    let id: CGWindowID
    let frame: CGRect
}

enum PermissionGuidePlacement {
    /// Bind to the largest settings window once; dialogs never replace an existing anchor.
    static func target(in windows: [PermissionGuideWindow], pinned: CGWindowID?) -> PermissionGuideWindow? {
        if let pinned { return windows.first { $0.id == pinned } }
        return windows.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    /// Keep the guide adjacent to its parent without repeating an already satisfied WindowServer order.
    static func needsOrdering(guide: CGWindowID, above target: CGWindowID, frontToBack: [CGWindowID]) -> Bool {
        guard let targetIndex = frontToBack.firstIndex(of: target) else { return false }
        guard let guideIndex = frontToBack.firstIndex(of: guide) else { return true }
        return guideIndex + 1 != targetIndex
    }

    /// AppKit coordinates; the guide overlays the settings window's lower margin and stays on screen.
    static func frame(settings: CGRect?, visible: CGRect, size: CGSize) -> CGRect {
        let width = min(size.width, max(1, visible.width - 24))
        let height = min(size.height, max(1, visible.height - 24))
        let x = min(max((settings?.midX ?? visible.midX) - width / 2, visible.minX + 12), visible.maxX - width - 12)
        let y = min(max((settings?.minY ?? visible.minY) + 8, visible.minY + 12), visible.maxY - height - 12)
        return CGRect(x: x, y: y, width: width, height: height)
    }
}

@MainActor final class PermissionGuide: NSObject, PermissionGuidePresenting, NSWindowDelegate {
    private var panel: PermissionGuidePanel?
    private var timer: Timer?
    private var owner: UUID?
    private var returnApplication: NSRunningApplication?
    private var granted: (@MainActor () -> Bool)?
    private var failureLabel: NSTextField?
    private var instructionLabel: NSTextField?
    private var text: PermissionGuideText?
    private var settingsWindowID: CGWindowID?
    private var dragging = false
    private var settingsOpenFailed = false

    func show(application: PermissionGuideApplication, text: PermissionGuideText, owner: UUID,
              interval: TimeInterval, granted: @escaping @MainActor () -> Bool) throws(NativeFailure) {
        let previousApplication = NSWorkspace.shared.frontmostApplication
        dismiss(activatePrevious: false)
        _ = try application.validatedURL()
        self.owner = owner
        self.text = text
        self.granted = granted
        returnApplication = previousApplication?.bundleIdentifier == "com.apple.systempreferences" ? nil : previousApplication
        settingsWindowID = nil
        dragging = false
        settingsOpenFailed = false

        let panel = PermissionGuidePanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 128),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.delegate = self
        panel.title = application.name
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .normal
        panel.isFloatingPanel = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.onDismiss = { [weak self] in self?.dismiss(activatePrevious: true) }
        panel.setAccessibilityLabel(text.instruction.replacingOccurrences(of: "{application}", with: application.name))

        let surface = NSVisualEffectView()
        surface.material = .popover
        surface.blendingMode = .behindWindow
        surface.state = .active
        surface.wantsLayer = true
        surface.layer?.cornerRadius = 18
        surface.layer?.borderWidth = 0.5
        surface.layer?.borderColor = NSColor.separatorColor.cgColor
        surface.layer?.masksToBounds = true
        surface.maskImage = PermissionGuideAppearance.materialMask()
        panel.contentView = surface

        let arrow = NSImageView()
        arrow.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 27, weight: .semibold))
        arrow.contentTintColor = .systemBlue
        arrow.translatesAutoresizingMaskIntoConstraints = false
        let instruction = NSTextField(wrappingLabelWithString:
            text.instruction.replacingOccurrences(of: "{application}", with: application.name))
        instruction.font = .systemFont(ofSize: 14)
        instruction.textColor = .secondaryLabelColor
        instruction.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let headingInset = NSView()
        headingInset.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSStackView(views: [headingInset, arrow, instruction])
        heading.orientation = .horizontal
        heading.alignment = .centerY
        heading.spacing = 10

        let back = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: text.backLabel) ?? NSImage(),
                            target: self, action: #selector(goBack))
        back.bezelStyle = .circular
        back.toolTip = text.backLabel
        back.setAccessibilityLabel(text.backLabel)
        back.translatesAutoresizingMaskIntoConstraints = false
        let item = PermissionApplicationView(application: application, finderLabel: text.finderLabel,
            dragBegan: { [weak self, weak panel] in
                guard let self, let panel, self.panel === panel else { return }
                self.dragging = true
                panel.orderOut(nil)
            }, dragEnded: { [weak self, weak panel] operation in
                guard let self, let panel, self.panel === panel else { return }
                self.dragging = false
                if operation.isEmpty { self.update() }
                else { self.dismiss(activatePrevious: false) }
            }, reportFailure: { [weak self] in self?.showFailure(text.unavailableMessage) })
        panel.initialFirstResponder = item
        let row = NSStackView(views: [back, item])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        let failure = NSTextField(wrappingLabelWithString: "")
        failure.font = .systemFont(ofSize: 12)
        failure.textColor = .systemRed
        failure.isHidden = true
        let content = NSStackView(views: [heading, row, failure])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 10
        content.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -16),
            content.topAnchor.constraint(equalTo: surface.topAnchor, constant: 14),
            content.bottomAnchor.constraint(lessThanOrEqualTo: surface.bottomAnchor, constant: -14),
            heading.widthAnchor.constraint(equalTo: content.widthAnchor),
            row.widthAnchor.constraint(equalTo: content.widthAnchor),
            failure.widthAnchor.constraint(equalTo: content.widthAnchor),
            headingInset.widthAnchor.constraint(equalToConstant: 42),
            arrow.widthAnchor.constraint(equalToConstant: 28), arrow.heightAnchor.constraint(equalToConstant: 32),
            back.widthAnchor.constraint(equalToConstant: 30), back.heightAnchor.constraint(equalToConstant: 30),
            item.heightAnchor.constraint(equalToConstant: 44),
        ])
        self.panel = panel
        failureLabel = failure
        instructionLabel = instruction
        update()
        guard self.panel === panel else { return }
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func reportSettingsFailure() {
        settingsOpenFailed = true
        if let text { showFailure(text.settingsMessage) }
    }

    func dismiss() { dismiss(activatePrevious: false) }

    func close(owner: UUID) {
        guard self.owner == owner else { return }
        dismiss(activatePrevious: false)
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === panel else { return }
        dismiss(activatePrevious: false)
    }

    @objc private func goBack() { dismiss(activatePrevious: true) }

    private func dismiss(activatePrevious: Bool) {
        timer?.invalidate()
        timer = nil
        let previous = returnApplication
        returnApplication = nil
        let window = panel
        panel = nil
        owner = nil
        granted = nil
        failureLabel = nil
        instructionLabel = nil
        text = nil
        settingsWindowID = nil
        dragging = false
        settingsOpenFailed = false
        window?.close()
        if activatePrevious, let previous, !previous.isTerminated { _ = previous.activate(options: []) }
    }

    private func showFailure(_ message: String) {
        failureLabel?.stringValue = message
        failureLabel?.isHidden = false
        updatePosition()
    }

    private func update() {
        guard panel != nil, !dragging else { return }
        if granted?() == true { dismiss(activatePrevious: false); return }
        updatePosition()
    }

    private func updatePosition() {
        guard let panel, !dragging, let primary = NSScreen.screens.first else { return }
        let snapshot = Self.settingsWindows(primaryHeight: primary.frame.height)
        let target = PermissionGuidePlacement.target(in: snapshot.targets, pinned: settingsWindowID)
        if let target { settingsWindowID = target.id }
        else if settingsWindowID != nil { dismiss(activatePrevious: false); return }
        else if !settingsOpenFailed { return }
        let settings = target?.frame
        let screen = NSScreen.screens.max { left, right in
            let target = settings ?? primary.frame
            let a = left.frame.intersection(target), b = right.frame.intersection(target)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        } ?? primary
        let width = min(620, max(360, (settings?.width ?? screen.visibleFrame.width) - 48), screen.visibleFrame.width - 24)
        instructionLabel?.preferredMaxLayoutWidth = width - 122
        failureLabel?.preferredMaxLayoutWidth = width - 32
        let headingHeight = max(32, instructionLabel?.fittingSize.height ?? 32)
        let failureHeight = failureLabel?.isHidden == false ? 10 + (failureLabel?.fittingSize.height ?? 0) : 0
        let height = max(128, ceil(headingHeight + 10 + 44 + 28 + failureHeight))
        let frame = PermissionGuidePlacement.frame(settings: settings, visible: screen.visibleFrame, size: CGSize(width: width, height: height))
        if panel.frame != frame {
            panel.setFrame(frame, display: true)
            panel.invalidateShadow()
        }
        if let target {
            if PermissionGuidePlacement.needsOrdering(guide: CGWindowID(panel.windowNumber), above: target.id, frontToBack: snapshot.order) {
                panel.order(.above, relativeTo: Int(target.id))
            }
        } else if !panel.isVisible { panel.orderFrontRegardless() }
    }

    private static func settingsWindows(primaryHeight: CGFloat) -> (targets: [PermissionGuideWindow], order: [CGWindowID]) {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first,
              let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return ([], []) }
        let order = windows.compactMap { window -> CGWindowID? in
            guard (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { return nil }
            return (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        }
        let targets = windows.compactMap { window -> PermissionGuideWindow? in
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let id = window[kCGWindowNumber as String] as? NSNumber,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width > 200, frame.height > 200 else { return nil }
            return PermissionGuideWindow(id: id.uint32Value,
                frame: CGRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height))
        }
        return (targets, order)
    }
}

@MainActor enum PermissionGuideAppearance {
    /// The material mask also defines the window shadow; layer clipping alone leaves the backdrop rectangular.
    static func materialMask() -> NSImage {
        let radius: CGFloat = 18
        let size = NSSize(width: radius * 2 + 1, height: radius * 2 + 1)
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }
}

@MainActor private final class PermissionGuidePanel: NSPanel {
    var onDismiss: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onDismiss?() }
}

@MainActor private final class PermissionApplicationView: NSView, NSDraggingSource {
    private let application: PermissionGuideApplication
    private let reportFailure: () -> Void
    private let dragBegan: () -> Void
    private let dragEnded: (NSDragOperation) -> Void
    private let icon: NSImage

    init(application: PermissionGuideApplication, finderLabel: String, dragBegan: @escaping () -> Void,
         dragEnded: @escaping (NSDragOperation) -> Void, reportFailure: @escaping () -> Void) {
        self.application = application
        self.reportFailure = reportFailure
        self.dragBegan = dragBegan
        self.dragEnded = dragEnded
        icon = NSWorkspace.shared.icon(forFile: application.url.path)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        layer?.cornerRadius = 8
        layer?.borderWidth = 0.5
        layer?.borderColor = NSColor.separatorColor.cgColor
        let image = NSImageView(image: icon)
        let label = NSTextField(labelWithString: application.name)
        label.font = .systemFont(ofSize: 15)
        image.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(image)
        addSubview(label)
        NSLayoutConstraint.activate([
            image.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            image.centerYAnchor.constraint(equalTo: centerYAnchor),
            image.widthAnchor.constraint(equalToConstant: 30), image.heightAnchor.constraint(equalToConstant: 30),
            label.leadingAnchor.constraint(equalTo: image.trailingAnchor, constant: 10),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(application.name)
        setAccessibilityHelp(finderLabel)
        let menu = NSMenu()
        let reveal = NSMenuItem(title: finderLabel, action: #selector(showInFinder), keyEquivalent: "")
        reveal.target = self
        menu.addItem(reveal)
        self.menu = menu
    }

    required init?(coder: NSCoder) { return nil }
    override var acceptsFirstResponder: Bool { true }
    override var needsPanelToBecomeKey: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateColors() }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors() }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override func mouseDragged(with event: NSEvent) {
        do {
            let item = NSDraggingItem(pasteboardWriter: try application.validatedURL() as NSURL)
            item.setDraggingFrame(NSRect(x: 10, y: 7, width: 30, height: 30), contents: icon)
            beginDraggingSession(with: [item], event: event, source: self)
        } catch { reportFailure() }
    }

    override func accessibilityPerformPress() -> Bool { showInFinder(); return true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 49 { showInFinder() }
        else { super.keyDown(with: event) }
    }

    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) { dragBegan() }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { dragEnded(operation) }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }

    @objc private func showInFinder() {
        do { NSWorkspace.shared.activateFileViewerSelecting([try application.validatedURL()]) }
        catch { reportFailure() }
    }
}
