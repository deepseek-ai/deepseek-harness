// Consent follows the bundle identifier or executable path; handles identify one process instance.
import AppKit
import CryptoKit
import Foundation

/// Live LaunchServices metadata for one running process; every field is nil for processes macOS does not report as applications.
typealias RunningBundle = (identifier: String?, url: URL?, executable: URL?)

enum ApplicationAuthorization {
    // Versions and copies with the same bundle identifier share consent, regardless of signing.
    // Running applications are checked by the executable URL in their LaunchServices metadata: a process can run from a
    // code-signing copy (Google Chrome) whose kernel path names the copy. The kernel path checks only processes without that metadata.
    static func describe(_ identity: ProcessIdentity, name: String, expectedExecutablePath: String?,
                         readBundle: (Int32) -> RunningBundle = runningBundle,
                         readPath: (Int32) -> Result<String, NativeFailure> = NativePlatform.executablePathResult) throws -> JSONValue {
        try NativePlatform.verify(identity)
        let bundle = readBundle(identity.pid)
        var bundleID = bundle.identifier.flatMap { $0.isEmpty ? nil : $0 }
        let pathResult: Result<String, NativeFailure> = bundle.executable.map { .success($0.path) } ?? readPath(identity.pid)
        let path = (try? pathResult.get()).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        if let path, let expectedExecutablePath, path != URL(fileURLWithPath: expectedExecutablePath).resolvingSymlinksInPath().path {
            throw NativeFailure(code: "STALE_APP", message: "Application executable changed during selection; select the application again")
        }
        if bundleID == nil, let path, let url = bundle.url,
           let installed = InstalledApplication.read(url), installed.executablePath == path {
            bundleID = installed.bundleID
        }
        try NativePlatform.verify(identity)
        if bundleID?.isEmpty != false, case .failure(let error) = pathResult { throw error }
        return try record(bundleID: bundleID, name: name, executablePath: path)
    }

    static func runningBundle(_ pid: Int32) -> RunningBundle {
        let application = NSRunningApplication(processIdentifier: pid)
        return (application?.bundleIdentifier, application?.bundleURL, application?.executableURL)
    }

    static func describeInstalled(_ app: InstalledApplication) throws -> JSONValue {
        guard let current = InstalledApplication.read(URL(fileURLWithPath: app.path)),
              current.bundleID == app.bundleID, current.executablePath == app.executablePath else {
            throw NativeFailure(code: "STALE_APP", message: "Application changed after selection; select it again")
        }
        return try record(bundleID: current.bundleID, name: app.name, executablePath: current.executablePath)
    }

    /// Require the selected authorization to still describe the installation that would launch.
    static func requireLaunchSelection(_ selected: JSONValue, application: InstalledApplication) throws {
        let current = try describeInstalled(application)
        guard current["id"] == selected["id"] else {
            throw NativeFailure(code: "STALE_APP", message: "Application authorization changed since selection; select the application again")
        }
    }

    private static func record(bundleID: String?, name: String, executablePath: String?) throws -> JSONValue {
        let path = executablePath.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        let identity: String
        if let bundleID, !bundleID.isEmpty { identity = "macos:bundle-id:" + bundleID }
        else if let path { identity = "macos:executable-path:" + path }
        else { throw NativeFailure(code: "NATIVE_ERROR", message: "Application consent requires a bundle identifier or an executable path") }
        var value: [String: JSONValue] = ["id": .string(digest(identity)), "name": .string(name), "persistable": .bool(true)]
        if let path { value["executablePath"] = .string(path) }
        return .object(value)
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
