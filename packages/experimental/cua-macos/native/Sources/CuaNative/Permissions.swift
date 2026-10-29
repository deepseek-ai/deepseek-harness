// System consent is requested only by the Host's user-facing permission controls.
import AppKit
@preconcurrency import ApplicationServices
import Darwin
import Foundation

@MainActor struct SystemPermissionActions {
    var accessibility: () -> Bool
    var screenRecording: () -> Bool
    var requestAccessibility: () -> Void
    var requestScreenRecording: () -> Void
    var open: (URL) -> Bool
    var reveal: ([URL]) -> Void

    static func system() -> Self {
        Self(accessibility: { AXIsProcessTrusted() }, screenRecording: { CGPreflightScreenCaptureAccess() },
             requestAccessibility: {
                 let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                 _ = AXIsProcessTrustedWithOptions(options)
             }, requestScreenRecording: { _ = CGRequestScreenCaptureAccess() },
             open: { NSWorkspace.shared.open($0) }, reveal: { NSWorkspace.shared.activateFileViewerSelecting($0) })
    }
}

@MainActor struct SystemPermissions {
    private let launchApplication: JSONValue?
    private let actions: SystemPermissionActions

    // Capture the system-reported responsible app before startup completes and the launcher can exit.
    init() {
        launchApplication = Self.responsibleApplication(for: getpid())
            ?? Self.application(Bundle.main.bundleURL, identifier: Bundle.main.bundleIdentifier)
        actions = .system()
    }

    init(application: JSONValue?, actions: SystemPermissionActions) {
        launchApplication = application
        self.actions = actions
    }

    func status() -> JSONValue {
        var result: [String: JSONValue] = [
            "accessibility": .bool(actions.accessibility()),
            "screenRecording": .bool(actions.screenRecording()),
            "helper": Self.process(getpid()),
            "parent": Self.process(getppid()),
        ]
        if let launchApplication { result["launchApplication"] = launchApplication }
        return .object(result)
    }

    func request(_ permission: String) throws -> JSONValue {
        switch permission {
        case "accessibility":
            if !actions.accessibility() { actions.requestAccessibility() }
        case "screenRecording":
            if !actions.screenRecording() { actions.requestScreenRecording() }
        default: throw RequestParameters.invalid("permission must be accessibility or screenRecording")
        }
        _ = try openSettings(permission)
        return status()
    }

    func openSettings(_ permission: String) throws -> JSONValue {
        let pane: String
        switch permission {
        case "accessibility": pane = "Privacy_Accessibility"
        case "screenRecording": pane = "Privacy_ScreenCapture"
        default: throw RequestParameters.invalid("permission must be accessibility or screenRecording")
        }
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"),
              actions.open(url) else {
            throw NativeFailure(code: "SETTINGS_UNAVAILABLE", message: "Open System Settings > Privacy & Security manually")
        }
        return .object(["opened": .bool(true)])
    }

    func revealApplication(_ path: String) throws -> JSONValue {
        guard path == launchApplication?["path"].string,
              let bundle = Bundle(url: URL(fileURLWithPath: path)), let executable = bundle.executableURL,
              FileManager.default.isExecutableFile(atPath: executable.path),
              bundle.bundleIdentifier == launchApplication?["bundleId"].string else {
            throw NativeFailure(code: "APPLICATION_UNAVAILABLE", message: "The permission application is unavailable; refresh the permission page")
        }
        actions.reveal([bundle.bundleURL])
        return .object(["revealed": .bool(true)])
    }

    /// Resolve macOS process responsibility, including launchers outside the nearest GUI application.
    static func responsibleApplication(for pid: Int32) -> JSONValue? {
        guard let responsible = NativePlatform.responsiblePID(pid),
              let app = NSRunningApplication(processIdentifier: responsible), !app.isTerminated,
              let bundle = app.bundleURL else { return nil }
        return application(bundle, identifier: app.bundleIdentifier)
    }

    private static func application(_ bundle: URL, identifier: String?) -> JSONValue? {
        guard bundle.pathExtension == "app", let identifier else { return nil }
        var result: [String: JSONValue] = ["name": .string(bundle.lastPathComponent), "path": .string(bundle.path),
                                         "bundleId": .string(identifier)]
        if let icon = ApplicationCatalog.icon(at: bundle.path) { result["icon"] = .string(icon) }
        return .object(result)
    }

    private static func process(_ pid: Int32) -> JSONValue {
        let path = NativePlatform.executablePath(pid)
        var result: [String: JSONValue] = ["pid": .number(Double(pid))]
        if let path { result["path"] = .string(path) }
        if let name = NSRunningApplication(processIdentifier: pid)?.localizedName { result["name"] = .string(name) }
        return .object(result)
    }
}
