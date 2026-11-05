// Installed application discovery is bounded to standard macOS application directories.
import AppKit
import Foundation

struct InstalledApplication: Sendable, Equatable {
    let path: String
    let executablePath: String
    let name: String
    let bundleID: String?

    static func read(_ url: URL) -> InstalledApplication? {
        let url = url.resolvingSymlinksInPath()
        guard url.pathExtension.lowercased() == "app",
              let info = CFBundleCopyInfoDictionaryInDirectory(url as CFURL) as? [String: Any],
              let executableName = info["CFBundleExecutable"] as? String, !executableName.isEmpty,
              let bundle = CFBundleCreate(nil, url as CFURL),
              let executable = CFBundleCopyAuxiliaryExecutableURL(bundle, executableName as CFString) else { return nil }
        let name = info["CFBundleDisplayName"] as? String
            ?? info["CFBundleName"] as? String
            ?? url.deletingPathExtension().lastPathComponent
        return InstalledApplication(path: url.path, executablePath: (executable as URL).resolvingSymlinksInPath().path,
                                    name: name, bundleID: info["CFBundleIdentifier"] as? String)
    }
    func matches(_ query: String, exact: Bool) -> Bool {
        let values = [name, URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, bundleID ?? "", path]
        return values.contains { exact ? $0.caseInsensitiveCompare(query) == .orderedSame : $0.localizedCaseInsensitiveContains(query) }
    }
    func json(catalog: ApplicationCatalogSnapshot) -> JSONValue {
        let process = catalog.applications.first { $0.executablePath.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == executablePath }
        var value: [String: JSONValue] = ["id": .string(bundleID ?? path), "displayName": .string(name), "path": .string(path),
                                        "isRunning": .bool(process != nil)]
        if let process { value["pid"] = .number(Double(process.pid)) }
        return .object(value)
    }
}

@MainActor enum ApplicationDiscovery {
    static func applications(matching query: String, exact: Bool, limit: Int, cancellation: CancellationLatch,
                             roots: [URL]? = nil) throws -> [InstalledApplication] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RequestParameters.invalid("Application query must not be empty")
        }
        if query.hasPrefix("/") {
            guard let app = InstalledApplication.read(URL(fileURLWithPath: query)) else { return [] }
            return [app]
        }
        let manager = FileManager.default
        let roots = roots ?? manager.urls(for: .applicationDirectory, in: [.localDomainMask, .systemDomainMask, .userDomainMask])
        var apps: [String: InstalledApplication] = [:]
        for root in roots {
            try cancellation.check()
            guard manager.fileExists(atPath: root.path),
                  let entries = manager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                                   options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in entries {
                try cancellation.check()
                if url.pathExtension.lowercased() == "app" {
                    entries.skipDescendants()
                    if let app = InstalledApplication.read(url), app.matches(query, exact: exact) { apps[app.path] = app }
                }
                if apps.count > limit { throw NativeFailure(code: "AMBIGUOUS_APP", message: "Too many matching applications; use a more specific name or path") }
            }
        }
        if roots.isEmpty || apps.isEmpty, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query),
           let app = InstalledApplication.read(url), app.matches(query, exact: exact) { apps[app.path] = app }
        return apps.values.sorted { $0.path < $1.path }
    }

    static func launch(_ app: InstalledApplication, cancellation: CancellationLatch) async throws -> Int32 {
        try cancellation.check()
        try NativePlatform.requireUnlocked(NativePlatform.sessionLocked())
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = true
        let running = try await NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: app.path), configuration: configuration)
        while !running.isFinishedLaunching {
            try cancellation.check()
            guard !running.isTerminated else {
                throw NativeFailure(code: "APP_UNAVAILABLE", message: "Application exited during launch")
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        try cancellation.check()
        let pid = running.processIdentifier
        guard pid > 0, !running.isTerminated else {
            throw NativeFailure(code: "APP_UNAVAILABLE", message: "Application exited during launch")
        }
        return pid
    }
}
