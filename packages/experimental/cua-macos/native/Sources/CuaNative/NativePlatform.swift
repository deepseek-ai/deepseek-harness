// Value-only macOS process, session and WindowServer observations.
import Foundation
import AppKit
import ApplicationServices
import Darwin

struct ApplicationInfo: Sendable {
    let pid: Int32
    let name: String?
    let bundleID: String?
    let path: String?
    let executablePath: String?
    let regular: Bool
    func matches(_ selector: String) -> Bool {
        regular && name != nil && (name?.caseInsensitiveCompare(selector) == .orderedSame || bundleID == selector || String(pid) == selector
            || (selector.hasPrefix("/") && path.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
                == URL(fileURLWithPath: selector).resolvingSymlinksInPath().path))
    }
    var json: JSONValue {
        var value: [String: JSONValue] = ["pid": .number(Double(pid))]
        if let name { value["name"] = .string(name) }
        if let bundleID { value["bundleId"] = .string(bundleID) }
        return .object(value)
    }
}
struct ApplicationCatalogSnapshot: Sendable {
    let applications: [ApplicationInfo]
    let frontPID: Int32?
    func application(_ pid: Int32) -> ApplicationInfo? { applications.first { $0.pid == pid } }
}
@MainActor enum ApplicationCatalog {
    static func snapshot() -> ApplicationCatalogSnapshot {
        let apps = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }.map { app in
            ApplicationInfo(pid: app.processIdentifier, name: app.localizedName, bundleID: app.bundleIdentifier,
                            path: app.bundleURL?.path, executablePath: app.executableURL?.path, regular: app.activationPolicy == .regular)
        }
        return ApplicationCatalogSnapshot(applications: apps, frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier)
    }
    static func activate(_ identity: ProcessIdentity) throws {
        try NativePlatform.verify(identity)
        guard let app = NSRunningApplication(processIdentifier: identity.pid), !app.isTerminated else {
            throw NativeFailure(code: "APP_UNAVAILABLE", message: "Application exited before activation")
        }
        app.unhide()
        guard app.activate(options: []) else { throw NativeFailure(code: "NATIVE_ERROR", message: "macOS refused application activation") }
    }
}

enum NativePlatform {
    static func executablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
    }
    static func identity(_ pid: Int32) throws -> ProcessIdentity {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.stride
        let copied = withUnsafeMutablePointer(to: &info) { pointer in
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, pointer, Int32(size))
        }
        guard copied == Int32(size) else { throw NativeFailure(code: "APP_UNAVAILABLE", message: "Target application exited or cannot be inspected; select it again") }
        return ProcessIdentity(pid: pid, startedSeconds: info.pbi_start_tvsec, startedMicroseconds: info.pbi_start_tvusec)
    }
    static func verify(_ identity: ProcessIdentity) throws {
        guard try self.identity(identity.pid) == identity else { throw NativeFailure(code: "STALE_APP", message: "Application process changed; call getApp again") }
    }
    static func sessionLocked() -> Bool? {
        guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
        func flag(_ key: String) -> Bool? {
            guard let value = dictionary[key], CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return nil }
            return (value as? NSNumber)?.boolValue
        }
        if flag("CGSSessionScreenIsLocked") == true { return true }
        return flag("kCGSSessionOnConsoleKey") == true && flag("kCGSessionLoginDoneKey") == true ? false : nil
    }
    static func requireUnlocked(_ value: Bool?) throws {
        guard value == false else {
            throw NativeFailure(code: value == true ? "SESSION_LOCKED" : "SESSION_UNAVAILABLE",
                                message: value == true ? "macOS is locked; unlock it and read fresh state before resuming" : "No unlocked console session could be verified")
        }
    }
    static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else { throw NativeFailure(code: "PERMISSION_DENIED", message: "Accessibility permission is required for the responsible host/helper") }
    }
    static func requireScreenRecording() throws {
        guard CGPreflightScreenCaptureAccess() else { throw NativeFailure(code: "PERMISSION_DENIED", message: "Screen Recording permission is required for the responsible host/helper") }
    }
    static func windows(allLayers: Bool = false) -> [WindowInfo] {
        guard let rows = CGWindowListCopyWindowInfo(.excludeDesktopElements, kCGNullWindowID) as? [[String: Any]] else { return [] }
        let memberships = allLayers ? [:] : WindowSpaces().memberships(windowIDs: rows.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value })
        return rows.compactMap { row in
            let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard allLayers || layer == 0,
                  let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
            let raw = row[kCGWindowBounds as String] as? [String: NSNumber] ?? [:]
            let bounds = WindowBounds(x: raw["X"]?.doubleValue ?? 0, y: raw["Y"]?.doubleValue ?? 0,
                                      width: raw["Width"]?.doubleValue ?? 0, height: raw["Height"]?.doubleValue ?? 0)
            return WindowInfo(windowID: id, pid: pid, appName: row[kCGWindowOwnerName as String] as? String ?? "",
                              title: row[kCGWindowName as String] as? String ?? "", bounds: bounds,
                              isOnScreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                              onCurrentSpace: memberships[id]?.onCurrentSpace)
        }
    }
    static func frontPID() -> Int32? { WindowSpaces().frontPID() }
    /// AppKit excludes input-transparent windows and transparent regions, including system overlays.
    @MainActor static func mouseWindow(at quartzPoint: CGPoint) -> Int {
        let point = WindowGeometry.appKitPoint(quartzPoint, mainDisplayHeight: CGDisplayBounds(CGMainDisplayID()).height)
        return NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
    }
    static func ownedWindow(_ pid: Int32, _ id: UInt32) throws -> WindowInfo {
        try requireOwnedWindow(pid, windows(allLayers: true).first { $0.windowID == id })
    }
    static func requireOwnedWindow(_ pid: Int32, _ window: WindowInfo?) throws -> WindowInfo {
        guard let window else { throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Window closed or is unavailable; refresh getWindows") }
        guard window.pid == pid else { throw NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Window belongs to another application") }
        return window
    }
}
