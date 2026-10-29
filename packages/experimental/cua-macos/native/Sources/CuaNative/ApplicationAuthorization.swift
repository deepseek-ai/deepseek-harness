// Consent follows the bundle identifier or executable path; handles identify one process instance.
import AppKit
import CryptoKit
import Foundation

enum ApplicationAuthorization {
    // Versions and copies with the same bundle identifier share consent, regardless of signing.
    static func describe(_ identity: ProcessIdentity, name: String, expectedExecutablePath: String?,
                         readBundle: (Int32) -> (identifier: String?, url: URL?) = runningBundle,
                         readPath: (Int32) -> Result<String, NativeFailure> = NativePlatform.executablePathResult) throws -> JSONValue {
        try NativePlatform.verify(identity)
        let bundle = readBundle(identity.pid)
        var bundleID = bundle.identifier.flatMap { $0.isEmpty ? nil : $0 }
        let pathResult = readPath(identity.pid)
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

    static func runningBundle(_ pid: Int32) -> (identifier: String?, url: URL?) {
        let application = NSRunningApplication(processIdentifier: pid)
        return (application?.bundleIdentifier, application?.bundleURL)
    }

    static func describeInstalled(_ app: InstalledApplication) throws -> JSONValue {
        guard let current = InstalledApplication.read(URL(fileURLWithPath: app.path)),
              current.bundleID == app.bundleID, current.executablePath == app.executablePath else {
            throw NativeFailure(code: "STALE_APP", message: "Application changed after selection; select it again")
        }
        return try record(bundleID: current.bundleID, name: app.name, executablePath: current.executablePath)
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
