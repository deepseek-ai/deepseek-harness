// Installed application discovery uses isolated bundles and does not launch user applications.
import AppKit
import Darwin
import Foundation
import Testing
@testable import CuaNative

private func fixtureApplication(_ directory: URL, name: String, identifier: String?) throws -> InstalledApplication {
    let app = directory.appendingPathComponent(name + ".app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/app")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    var info = ["CFBundleName": name, "CFBundleExecutable": "app", "CFBundlePackageType": "APPL"]
    if let identifier { info["CFBundleIdentifier"] = identifier }
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    try Data("fixture executable".utf8).write(to: executable)
    return try #require(InstalledApplication.read(app))
}

@Test(arguments: ["process-query", "authorization", "metadata", "ambiguity"])
func failedLaunchInspectionInvalidatesThePendingHandle(failure: String) async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-launch-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture", identifier: "test.dsh.launch." + UUID().uuidString)
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: { false })
    let catalog = ApplicationCatalogSnapshot(applications: [], frontPID: nil)
    func parameters(_ method: String, _ values: [String: JSONValue]) throws -> RequestParameters {
        try RequestParameters(NativeRequest(data: JSONEncoder().encode(JSONValue.object([
            "id": .string("fixture"), "method": .string(method), "params": .object(values),
        ]))))
    }
    do {
        let selection = try await worker.execute("getApp", params: parameters("getApp", ["selector": .string(app.path)]),
                                                 catalog: catalog, installed: app)
        guard case .result(let selected) = selection else { throw NativeFailure(code: "TEST", message: "Expected pending selection") }
        let handle = try #require(selected["appHandle"].string)
        let launchParameters = try parameters("launchApp", ["appHandle": .string(handle)])
        let outcome = try await worker.execute("launchApp", params: launchParameters, catalog: catalog)
        guard case .launch(let plan) = outcome else { throw NativeFailure(code: "TEST", message: "Expected launch plan") }
        let plist = URL(fileURLWithPath: app.path).appendingPathComponent("Contents/Info.plist")
        let original = try Data(contentsOf: plist)
        if failure == "metadata" { try FileManager.default.removeItem(at: plist) }
        do {
            let other = ApplicationInfo(pid: getppid(), name: app.name, bundleID: app.bundleID, path: app.path,
                                        executablePath: app.executablePath, regular: true)
            let afterLaunch = ApplicationCatalogSnapshot(applications: failure == "ambiguity" ? [other] : [], frontPID: nil)
            _ = try await worker.finishLaunch(plan, pid: failure == "process-query" ? Int32.max : getpid(), catalog: afterLaunch)
            Issue.record("Invalid post-launch inspection succeeded")
        } catch let error as NativeFailure {
            let expected = ["process-query": "APP_UNAVAILABLE", "ambiguity": "AMBIGUOUS_APP"]
            #expect(error.code == (expected[failure] ?? "STALE_APP"))
        }
        if failure == "metadata" { try original.write(to: plist) }
        do {
            _ = try await worker.execute("launchApp", params: launchParameters, catalog: catalog)
            Issue.record("A failed launch retained a handle that could launch another instance")
        } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
}

@Test @MainActor func findsStoppedApplicationsAndIdentifiesRunningMatchesWithoutLaunching() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture Editor", identifier: "test.dsh.cua." + UUID().uuidString)
    let matches = try ApplicationDiscovery.applications(matching: "fixture editor", exact: true, limit: 2,
                                                       cancellation: CancellationLatch(), roots: [root])
    #expect(matches == [app])
    #expect(app.json(catalog: ApplicationCatalogSnapshot(applications: [], frontPID: nil))["isRunning"] == .bool(false))
    let process = ApplicationInfo(pid: 123, name: app.name, bundleID: app.bundleID, path: app.path,
                                  executablePath: app.executablePath, regular: true)
    let running = app.json(catalog: ApplicationCatalogSnapshot(applications: [process], frontPID: nil))
    #expect(running["isRunning"] == .bool(true))
    #expect(running["pid"] == .number(123))
    #expect(running["path"] == .string(app.path))
}

@Test func selectsLocalizedProcessesByTheInstalledExecutable() async throws {
    let executable = try NativePlatform.executablePathResult(getpid()).get()
    let canonical = URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
    let installed = InstalledApplication(path: "/Fixture/Calculator.app", executablePath: canonical,
                                        name: "Calculator", bundleID: "test.dsh.calculator")
    func process(_ pid: Int32, executablePath: String) -> ApplicationInfo {
        ApplicationInfo(pid: pid, name: "计算器", bundleID: installed.bundleID, path: nil,
                        executablePath: executablePath, regular: true)
    }
    let running = process(getpid(), executablePath: executable)
    let otherCopy = process(42, executablePath: "/Other/Calculator.app/Contents/MacOS/Calculator")
    let accessory = ApplicationInfo(pid: 44, name: "计算器", bundleID: installed.bundleID, path: nil,
                                    executablePath: executable, regular: false)
    let unnamed = ApplicationInfo(pid: 45, name: nil, bundleID: installed.bundleID, path: nil,
                                  executablePath: executable, regular: true)
    let catalog = ApplicationCatalogSnapshot(applications: [otherCopy, accessory, unnamed, running], frontPID: nil)
    let params = try RequestParameters(NativeRequest(data: Data(#"{"id":"select","method":"getApp","params":{"selector":"calculator"}}"#.utf8)))
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: { false })
    func select(_ catalog: ApplicationCatalogSnapshot) async throws -> JSONValue {
        let outcome = try await worker.execute("getApp", params: params, catalog: catalog, installed: installed)
        guard case .result(let app) = outcome else { throw NativeFailure(code: "TEST", message: "Expected application selection") }
        return app
    }
    do {
        let first = try await select(catalog)
        #expect(first["running"] == .bool(true))
        #expect(first["pid"] == .number(Double(getpid())))
        let handle = try #require(first["appHandle"].string)
        #expect(try await select(catalog)["appHandle"].string == handle)
        let second = process(43, executablePath: executable)
        let instances = ApplicationCatalogSnapshot(applications: [second, running], frontPID: nil)
        do {
            _ = try await select(instances)
            Issue.record("Selected one of two processes at the same executable path")
        } catch let failure as NativeFailure { #expect(failure.code == "AMBIGUOUS_APP") }
        let request = Data(#"{"id":"select-pid","method":"getApp","params":{"selector":"\#(getpid())"}}"#.utf8)
        let byPID = try await worker.execute("getApp", params: RequestParameters(NativeRequest(data: request)), catalog: instances)
        guard case .result(let selected) = byPID else { throw NativeFailure(code: "TEST", message: "Expected PID selection") }
        #expect(selected["pid"] == .number(Double(getpid())))
        #expect(selected["appHandle"].string == handle)
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
}

@Test @MainActor func broadQueriesRejectInsteadOfHidingApplicationAmbiguity() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    _ = try fixtureApplication(root, name: "Fixture One", identifier: "test.dsh.one." + UUID().uuidString)
    _ = try fixtureApplication(root, name: "Fixture Two", identifier: "test.dsh.two." + UUID().uuidString)
    #expect(throws: NativeFailure.self) {
        try ApplicationDiscovery.applications(matching: "Fixture", exact: false, limit: 1, cancellation: CancellationLatch(), roots: [root])
    }
    let cancellation = CancellationLatch()
    cancellation.cancel()
    #expect(throws: NativeFailure.self) {
        try ApplicationDiscovery.applications(matching: "Fixture", exact: false, limit: 2, cancellation: cancellation, roots: [root])
    }
}

@Test(arguments: [nil, ""] as [String?]) func applicationsWithoutBundleIdentifiersRetainPathConsentAcrossUpdates(identifier: String?) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture", identifier: identifier)
    let before = try ApplicationAuthorization.describeInstalled(app)
    #expect(before["persistable"] == .bool(true))
    try Data("replacement executable".utf8).write(to: URL(fileURLWithPath: app.executablePath))
    let after = try ApplicationAuthorization.describeInstalled(app)
    #expect(before["id"] == after["id"])
    let copy = try fixtureApplication(root, name: "Other installation", identifier: identifier)
    #expect(try ApplicationAuthorization.describeInstalled(copy)["id"] != before["id"])
    let alias = root.appendingPathComponent("Alias.app")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: URL(fileURLWithPath: app.path))
    let linked = try #require(InstalledApplication.read(alias))
    #expect(try ApplicationAuthorization.describeInstalled(linked)["id"] == before["id"])
}

@Test func unsignedVersionsShareConsentOnlyForTheSameBundleIdentifier() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let identifier = "test.dsh.consent." + UUID().uuidString
    let first = try fixtureApplication(root, name: "Editor One", identifier: identifier)
    let second = try fixtureApplication(root, name: "Editor Two", identifier: identifier)
    let other = try fixtureApplication(root, name: "Other", identifier: identifier + ".other")
    let differentCase = try fixtureApplication(root, name: "Case", identifier: identifier.uppercased())
    let approved = try ApplicationAuthorization.describeInstalled(first)
    #expect(approved["persistable"] == .bool(true))
    let copy = try ApplicationAuthorization.describeInstalled(second)
    #expect(copy["id"] == approved["id"])
    #expect(copy["executablePath"] != approved["executablePath"])
    #expect(try ApplicationAuthorization.describeInstalled(other)["id"] != approved["id"])
    #expect(try ApplicationAuthorization.describeInstalled(differentCase)["id"] != approved["id"])
    try Data("new version".utf8).write(to: URL(fileURLWithPath: first.executablePath))
    #expect(try ApplicationAuthorization.describeInstalled(first)["id"] == approved["id"])
}

@Test(arguments: ["identifier", "missing-identifier", "executable", "missing-plist"])
func changedBundleMetadataInvalidatesACachedSelection(change: String) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let selected = try fixtureApplication(root, name: "Fixture", identifier: "test.dsh.consent." + UUID().uuidString)
    let url = URL(fileURLWithPath: selected.path)
    let plist = url.appendingPathComponent("Contents/Info.plist")
    let cachedBundle = try #require(Bundle(url: url))
    #expect(cachedBundle.bundleIdentifier == selected.bundleID)
    _ = try ApplicationAuthorization.describeInstalled(selected)
    var info = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: String])
    switch change {
    case "identifier": info["CFBundleIdentifier"] = "test.dsh.replacement"
    case "missing-identifier": info.removeValue(forKey: "CFBundleIdentifier")
    case "executable":
        info["CFBundleExecutable"] = "replacement"
        try Data("replacement".utf8).write(to: url.appendingPathComponent("Contents/MacOS/replacement"))
    default: break
    }
    if change == "missing-plist" { try FileManager.default.removeItem(at: plist) }
    else { try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist) }
    do {
        _ = try ApplicationAuthorization.describeInstalled(selected)
        Issue.record("Cached application metadata allowed a changed bundle")
    } catch let error as NativeFailure {
        #expect(error.code == "STALE_APP")
    }
    withExtendedLifetime(cachedBundle) {}
}
