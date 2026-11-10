// System permission guidance belongs to the native application whose bundle the user authorizes.
import AppKit
@preconcurrency import ApplicationServices
import Darwin
import Foundation

@MainActor struct SystemPermissionActions {
    var accessibility: @MainActor () -> Bool
    var screenRecording: @MainActor () -> Bool
    var open: (URL) -> Bool

    static func system() -> Self {
        Self(accessibility: { AXIsProcessTrusted() }, screenRecording: { CGPreflightScreenCaptureAccess() },
             open: { NSWorkspace.shared.open($0) })
    }
}

@MainActor final class SystemPermissions {
    /// Captured at startup because a launcher can exit before permission is requested.
    private let launchApplication: JSONValue?
    private let actions: SystemPermissionActions
    private let guide: any PermissionGuidePresenting

    init() {
        launchApplication = Self.responsibleApplication(for: getpid())
            ?? Self.application(Bundle.main.bundleURL, identifier: Bundle.main.bundleIdentifier)
        actions = .system()
        guide = PermissionGuide()
    }

    init(application: JSONValue?, actions: SystemPermissionActions, guide: any PermissionGuidePresenting) {
        launchApplication = application
        self.actions = actions
        self.guide = guide
    }

    func status() -> JSONValue {
        var result: [String: JSONValue] = [
            "platform": .string("darwin"),
            "accessibility": .bool(actions.accessibility()),
            "screenRecording": .bool(actions.screenRecording()),
            "helper": Self.process(getpid()),
            "parent": Self.process(getppid()),
        ]
        if let launchApplication, case .object(var application) = launchApplication {
            application.removeValue(forKey: "bundleId")
            result["launchApplication"] = .object(application)
        }
        return .object(result)
    }

    func request(_ permission: String, owner: UUID, text: PermissionGuideText, interval: TimeInterval) throws -> JSONValue {
        let observe: @MainActor () -> Bool
        switch permission {
        case "accessibility": observe = actions.accessibility
        case "screenRecording": observe = actions.screenRecording
        default: throw RequestParameters.invalid("permission must be accessibility or screenRecording")
        }
        var guideFailure: NativeFailure?
        if !observe() {
            do throws(NativeFailure) {
                guard let path = launchApplication?["path"].string, let identifier = launchApplication?["bundleId"].string else {
                    throw NativeFailure(code: "APPLICATION_UNAVAILABLE", message: text.unavailableMessage)
                }
                try guide.show(application: PermissionGuideApplication(url: URL(fileURLWithPath: path), identifier: identifier),
                               text: text, owner: owner, interval: interval, granted: observe)
            } catch {
                guide.dismiss()
                guideFailure = error.code == "APPLICATION_UNAVAILABLE"
                    ? NativeFailure(code: error.code, message: text.unavailableMessage) : error
            }
        } else { guide.dismiss() }
        do { _ = try openPane(permission) }
        catch {
            guide.reportSettingsFailure()
            let message = guideFailure.map { $0.message + "\n" } ?? ""
            throw NativeFailure(code: error.code, message: message + text.settingsMessage)
        }
        if let guideFailure { throw guideFailure }
        return status()
    }

    func closeGuide(owner: UUID) { guide.close(owner: owner) }

    func openSettings(_ permission: String, failureMessage: String) throws(NativeFailure) -> JSONValue {
        guide.dismiss()
        do { return try openPane(permission) }
        catch {
            guard error.code == "SETTINGS_UNAVAILABLE" else { throw error }
            throw NativeFailure(code: error.code, message: failureMessage)
        }
    }

    private func openPane(_ permission: String) throws(NativeFailure) -> JSONValue {
        let pane: String
        switch permission {
        case "accessibility": pane = "Privacy_Accessibility"
        case "screenRecording": pane = "Privacy_ScreenCapture"
        default: throw RequestParameters.invalid("permission must be accessibility or screenRecording")
        }
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"), actions.open(url) else {
            throw NativeFailure(code: "SETTINGS_UNAVAILABLE", message: "Open System Settings > Privacy & Security manually")
        }
        return .object(["opened": .bool(true)])
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
