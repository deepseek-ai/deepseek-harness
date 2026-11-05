// Nested applications share their enclosing app's Screen Recording identity in TCC.
import CryptoKit
import Darwin
import Foundation
import Security

enum StandaloneApplication {
    static func hasApplicationAncestor(_ application: URL) -> Bool {
        var parent = application.deletingLastPathComponent()
        while parent.path != "/" {
            if parent.pathExtension.lowercased() == "app" { return true }
            parent.deleteLastPathComponent()
        }
        return false
    }

    static func prepare(_ application: URL, runtimeKey: String, deadline: UInt64) throws -> URL {
        let source = application.resolvingSymlinksInPath()
        guard hasApplicationAncestor(source) else { return source }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                  appropriateFor: nil, create: true)
        return try install(source, runtimeKey: runtimeKey,
                           root: support.appendingPathComponent("DeepSeek Harness/Computer Use"), deadline: deadline)
    }

    // Published generations remain immutable while any installed DSH version may still run them.
    static func install(_ source: URL, runtimeKey: String, root: URL, deadline: UInt64) throws -> URL {
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let root = root.resolvingSymlinksInPath()
        let generation = root.appendingPathComponent(runtimeKey, isDirectory: true)
        let application = generation.appendingPathComponent(source.lastPathComponent, isDirectory: true)
        guard !hasApplicationAncestor(application) else {
            throw NativeFailure(code: "NATIVE_APPLICATION_REQUIRED", message: "Computer Use application storage must be outside another .app: \(root.path)")
        }
        var lock: SharedHelperLock?
        repeat {
            lock = try SharedHelperLock(path: root.appendingPathComponent("\(runtimeKey).lock").path)
            if lock != nil { break }
            usleep(10_000)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        guard let lock else {
            throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Computer Use application installation is still in progress")
        }
        defer { withExtendedLifetime(lock) {} }
        if files.fileExists(atPath: generation.path) {
            do { try validate(application, runtimeKey: runtimeKey) }
            catch {
                throw NativeFailure(code: "NATIVE_APPLICATION_INVALID", message: "Computer Use cached application is invalid: \(error.localizedDescription); remove \(generation.path) and retry")
            }
            return application
        }
        let staging = root.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try files.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            let stagedApplication = staging.appendingPathComponent(source.lastPathComponent, isDirectory: true)
            try files.copyItem(at: source, to: stagedApplication)
            try validate(stagedApplication, runtimeKey: runtimeKey)
            try files.moveItem(at: staging, to: generation)
        } catch {
            let failure = error
            do { try files.removeItem(at: staging) }
            catch {
                throw NativeFailure(code: "NATIVE_IO", message: "Computer Use installation failed: \(failure.localizedDescription); could not remove \(staging.path): \(error.localizedDescription)")
            }
            throw failure
        }
        return application
    }

    private static func validate(_ application: URL, runtimeKey: String) throws {
        guard !hasApplicationAncestor(application.resolvingSymlinksInPath()) else {
            throw NativeFailure(code: "NATIVE_APPLICATION_REQUIRED", message: "Computer Use application resolves inside another .app: \(application.path)")
        }
        let executable = application.appendingPathComponent("Contents/MacOS/dsh-cua-native")
        let bytes = try Data(contentsOf: executable, options: .mappedIfSafe)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        var code: SecStaticCode?
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
        guard digest == runtimeKey,
              SecStaticCodeCreateWithPath(application as CFURL, [], &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, flags, nil) == errSecSuccess else {
            throw NativeFailure(code: "NATIVE_APPLICATION_INVALID", message: "Computer Use application failed signature or executable verification at \(application.path)")
        }
    }
}
