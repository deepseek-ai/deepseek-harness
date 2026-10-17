// Passive input metadata only. Unmarked events may come from people or other automation.
import AppKit
import Carbon
import CoreGraphics
import Foundation

@MainActor final class ExternalInputMonitor {
    private let activity: RecentActivity
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    init(activity: RecentActivity) { self.activity = activity }

    var status: String {
        if IsSecureEventInputEnabled() { return "secure-input" }
        guard let tap, CGEvent.tapIsEnabled(tap: tap) else { return "unavailable" }
        return "listening"
    }

    func start() {
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let created = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap,
            options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
                guard let info else { return Unmanaged.passUnretained(event) }
                MainActor.assumeIsolated {
                    let monitor = Unmanaged<ExternalInputMonitor>.fromOpaque(info).takeUnretainedValue()
                    monitor.receive(type, event: event)
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else { return }
        tap = created
        source = runLoopSource
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
    }

    func stop() {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        source = nil
        tap = nil
    }

    func receive(_ type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // The next request retries registration; an unavailable monitor remains visible in replies.
            stop()
            return
        }
        guard event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) else { return }
        let rawPID = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard let pid = Int32(exactly: rawPID), pid > 0, let process = try? NativePlatform.identity(pid),
              activity.isTracked(process) else { return }
        let operation: String
        let windowID: UInt32?
        switch type {
        case .keyDown:
            operation = "keyboard"
            // Key events do not identify a reliable window; sampling later focus could misattribute them.
            windowID = nil
        case .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel:
            operation = type == .scrollWheel ? "scroll" : "click"
            let rawWindow = event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
            if let id = UInt32(exactly: rawWindow), id > 0,
               Self.windowOwner(id) == pid { windowID = id }
            else { windowID = nil }
        default: return
        }
        activity.record(ActivityTarget(process: process, windowID: windowID), owner: nil, operation: operation)
    }

    static func windowOwner(_ id: UInt32) -> Int32? {
        NativePlatform.windows(allLayers: true).first { $0.windowID == id }?.pid
    }
}
