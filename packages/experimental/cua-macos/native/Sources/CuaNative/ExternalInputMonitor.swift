// Passive input metadata only. Unmarked events may come from people or other automation.
import AppKit
import CoreGraphics
import Foundation

@MainActor final class ExternalInputMonitor {
    private let activity: RecentActivity
    private let ownerOfWindow: (UInt32) -> Int32?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    init(activity: RecentActivity, ownerOfWindow: @escaping (UInt32) -> Int32? = ExternalInputMonitor.windowOwner) {
        self.activity = activity
        self.ownerOfWindow = ownerOfWindow
    }

    func start() {
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        // A click or scroll may make an observed window stale. The tap forwards only the target and time.
        // It does not subscribe to keyboard input or retain pointer coordinates or scroll deltas.
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
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
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) else { return }
        let rawPID = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard let pid = Int32(exactly: rawPID), pid > 0, let process = try? NativePlatform.identity(pid),
              activity.isTracked(process) else { return }
        guard [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(type) else { return }
        let rawWindow = event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
        guard let id = UInt32(exactly: rawWindow), id > 0, ownerOfWindow(id) == pid else { return }
        activity.recordExternal(ActivityTarget(process: process, windowID: id), eventUptime: event.timestamp)
    }

    nonisolated static func windowOwner(_ id: UInt32) -> Int32? {
        // WindowServer expects unboxed window IDs, not CFNumber objects.
        var identifier = UnsafeRawPointer(bitPattern: UInt(id))
        let identifiers = CFArrayCreate(kCFAllocatorDefault, &identifier, 1, nil)
        guard let rows = CGWindowListCreateDescriptionFromArray(identifiers) as? [[String: Any]],
              let row = rows.first, (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id else { return nil }
        return (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    }
}
