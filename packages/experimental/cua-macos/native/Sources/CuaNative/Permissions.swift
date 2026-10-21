// System consent is requested only by the Host's user-facing permission controls.
import AppKit
@preconcurrency import ApplicationServices
import Darwin
import Foundation

@MainActor struct SystemPermissions {
    private let launchApplication: JSONValue?

    // Capture the system-reported responsible app before startup completes and the launcher can exit.
    init() { launchApplication = Self.responsibleApplication(for: getpid()) }

    func status() -> JSONValue {
        var result: [String: JSONValue] = [
            "accessibility": .bool(AXIsProcessTrusted()),
            "screenRecording": .bool(CGPreflightScreenCaptureAccess()),
            "helper": Self.process(getpid()),
            "parent": Self.process(getppid()),
        ]
        if let launchApplication { result["launchApplication"] = launchApplication }
        return .object(result)
    }

    func request(_ permission: String) throws -> JSONValue {
        switch permission {
        case "accessibility":
            if !AXIsProcessTrusted() {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
            }
        case "screenRecording":
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        default: throw RequestParameters.invalid("permission must be accessibility or screenRecording")
        }
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
              NSWorkspace.shared.open(url) else {
            throw NativeFailure(code: "SETTINGS_UNAVAILABLE", message: "Open System Settings > Privacy & Security manually")
        }
        return .object(["opened": .bool(true)])
    }

    /// Resolve macOS process responsibility, including launchers outside the nearest GUI application.
    static func responsibleApplication(for pid: Int32) -> JSONValue? {
        guard let responsible = NativePlatform.responsiblePID(pid),
              let app = NSRunningApplication(processIdentifier: responsible), !app.isTerminated,
              let bundle = app.bundleURL else { return nil }
        var result: [String: JSONValue] = ["name": .string(bundle.lastPathComponent), "path": .string(bundle.path)]
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
