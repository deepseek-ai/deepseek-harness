// Installed application discovery uses isolated bundles and does not launch user applications.
import AppKit
import Darwin
import Foundation
import Testing
@testable import CuaNative

private func fixtureApplication(_ directory: URL, name: String, identifier: String?,
                                executableTarget: URL? = nil) throws -> InstalledApplication {
    let app = directory.appendingPathComponent(name + ".app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/app")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    var info = ["CFBundleName": name, "CFBundleExecutable": "app", "CFBundlePackageType": "APPL"]
    if let identifier { info["CFBundleIdentifier"] = identifier }
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    if let executableTarget { try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: executableTarget) }
    else { try Data("fixture executable".utf8).write(to: executable) }
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
        let selection = try await worker.execute("getApp", deadline: .now + .seconds(30), params: parameters("getApp", ["selector": .string(app.path)]),
                                                 catalog: catalog, installed: app)
        guard case .result(let selected) = selection else { throw NativeFailure(code: "TEST", message: "Expected pending selection") }
        let handle = try #require(selected["appHandle"].string)
        let launchParameters = try parameters("launchApp", ["appHandle": .string(handle)])
        let outcome = try await worker.execute("launchApp", deadline: .now + .seconds(30), params: launchParameters, catalog: catalog)
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
            _ = try await worker.execute("launchApp", deadline: .now + .seconds(30), params: launchParameters, catalog: catalog)
            Issue.record("A failed launch retained a handle that could launch another instance")
        } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
}

@Test(arguments: ["identifier", "executable"])
func launchRejectsInstallationsWhoseBundleMetadataChanged(change: String) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-launch-instance-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture", identifier: "test.dsh.instance." + UUID().uuidString)
    let process = ApplicationInfo(pid: 42, name: app.name, bundleID: app.bundleID, path: app.path,
                                  executablePath: app.executablePath, regular: true)
    #expect(try ApplicationDiscovery.installedApplication(for: process) == app)
    let url = URL(fileURLWithPath: app.path)
    let plist = url.appendingPathComponent("Contents/Info.plist")
    var info = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: String])
    switch change {
    case "identifier": info["CFBundleIdentifier"] = "test.dsh.replacement"
    case "executable":
        info["CFBundleExecutable"] = "replacement"
        try Data("replacement".utf8).write(to: url.appendingPathComponent("Contents/MacOS/replacement"))
    default: break
    }
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
    do {
        _ = try ApplicationDiscovery.installedApplication(for: process)
        Issue.record("Changed bundle metadata allowed a new instance launch")
    } catch let error as NativeFailure {
        #expect(error.code == "STALE_APP")
    }
}

@Test func launchAppPlansANewInstanceWithoutRebindingTheSelectedHandle() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-launch-instance-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = try NativePlatform.executablePathResult(getpid()).get()
    let executablePath = URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
    let bundle = ApplicationAuthorization.runningBundle(getpid())
    var identifier = bundle.identifier.flatMap { $0.isEmpty ? nil : $0 }
    if identifier == nil, let url = bundle.url, let installed = InstalledApplication.read(url),
       installed.executablePath == executablePath {
        identifier = installed.bundleID
    }
    let app = try fixtureApplication(root, name: "Fixture", identifier: identifier,
                                     executableTarget: URL(fileURLWithPath: executable))
    let process = ApplicationInfo(pid: getpid(), name: app.name, bundleID: identifier, path: app.path,
                                  executablePath: executable, regular: true)
    let catalog = ApplicationCatalogSnapshot(applications: [process], frontPID: nil)
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: { false })
    func parameters(_ method: String, _ values: [String: JSONValue]) throws -> RequestParameters {
        try RequestParameters(NativeRequest(data: JSONEncoder().encode(JSONValue.object([
            "id": .string("fixture"), "method": .string(method), "params": .object(values),
        ]))))
    }
    func select() async throws -> JSONValue {
        let outcome = try await worker.execute("getApp", deadline: .now + .seconds(30), params: parameters("getApp",
            ["selector": .string(String(getpid()))]), catalog: catalog)
        guard case .result(let value) = outcome else {
            throw NativeFailure(code: "TEST", message: "Expected application selection")
        }
        return value
    }
    do {
        let selected = try await select()
        let handle = try #require(selected["appHandle"].string)
        let outcome = try await worker.execute("launchApp", deadline: .now + .seconds(30), params: parameters("launchApp", ["appHandle": .string(handle)]),
                                               catalog: catalog)
        guard case .launch(let plan) = outcome else {
            throw NativeFailure(code: "TEST", message: "Expected new-instance launch plan")
        }
        #expect(plan.handle == handle)
        #expect(plan.source?.pid == getpid())
        #expect(plan.application == app)
        let dispatched = try await worker.finishLaunch(plan, pid: 4242,
                                                       catalog: ApplicationCatalogSnapshot(applications: [], frontPID: nil))
        #expect(dispatched["dispatched"] == .bool(true))
        let reselected = try await select()
        #expect(reselected["appHandle"].string == handle)
        let plist = URL(fileURLWithPath: app.path).appendingPathComponent("Contents/Info.plist")
        var info = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: String])
        info["CFBundleIdentifier"] = (identifier ?? "test.dsh.changed") + ".changed"
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
        do {
            _ = try await worker.execute("launchApp", deadline: .now + .seconds(30), params: parameters("launchApp", ["appHandle": .string(handle)]),
                                         catalog: catalog)
            Issue.record("Changed bundle metadata allowed a new instance launch")
        } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
}

@Test func launchRequiresTheSelectedAuthorizationWhenTheProcessReportsNoBundleIdentifier() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-launch-auth-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture", identifier: nil)
    let selected = try ApplicationAuthorization.describeInstalled(app)
    try ApplicationAuthorization.requireLaunchSelection(selected, application: app)
    let mismatched = JSONValue.object(["id": .string(String(repeating: "f", count: 64))])
    do {
        try ApplicationAuthorization.requireLaunchSelection(mismatched, application: app)
        Issue.record("A different authorization id allowed a new instance launch")
    } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
    let plist = URL(fileURLWithPath: app.path).appendingPathComponent("Contents/Info.plist")
    var info = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: String])
    info["CFBundleIdentifier"] = "test.dsh.changed"
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
    do {
        try ApplicationAuthorization.requireLaunchSelection(selected, application: app)
        Issue.record("Changed bundle metadata allowed a new instance launch")
    } catch let error as NativeFailure { #expect(error.code == "STALE_APP") }
}

@Test func reacquiringAChangedAuthorizationReplacesTheRunningHandle() async throws {
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: { false })
    let identity = ProcessIdentity(pid: 4242, startedSeconds: 1, startedMicroseconds: 1)
    let first = JSONValue.object(["id": .string(String(repeating: "a", count: 64))])
    let second = JSONValue.object(["id": .string(String(repeating: "b", count: 64))])
    do {
        let handle = try await worker.acquire(identity, authorization: first)
        let reused = try await worker.acquire(identity, authorization: first)
        #expect(reused == handle)
        let replacement = try await worker.acquire(identity, authorization: second)
        #expect(replacement != handle)
        do {
            _ = try await worker.validateIdentity(handle)
            Issue.record("Old handle survived an authorization change")
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
    #expect(running["identity"] == .string(app.path))
}

@Test func distinctInstallationsOfOneBundleKeepDistinctIdentities() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let identifier = "test.dsh.cua.installations." + UUID().uuidString
    let first = try fixtureApplication(root.appendingPathComponent("One"), name: "Editor", identifier: identifier)
    let second = try fixtureApplication(root.appendingPathComponent("Two"), name: "Editor", identifier: identifier)
    let catalog = ApplicationCatalogSnapshot(applications: [], frontPID: nil)
    let firstRow = first.json(catalog: catalog)
    let secondRow = second.json(catalog: catalog)
    #expect(firstRow["id"] == secondRow["id"])
    #expect(firstRow["identity"] == .string(first.path))
    #expect(secondRow["identity"] == .string(second.path))
    #expect(firstRow["identity"] != secondRow["identity"])
    #expect(firstRow["path"] == .null)
    let alias = root.appendingPathComponent("Alias.app")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: URL(fileURLWithPath: first.path))
    let linked = try #require(InstalledApplication.read(alias))
    #expect(linked.json(catalog: catalog)["identity"] == firstRow["identity"])
}

@Test func listAppsReportsIdentityAndAcceptsTheBundlePathAsASelector() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = try NativePlatform.executablePathResult(getpid()).get()
    let installed = try fixtureApplication(root, name: "Listed Editor", identifier: "test.dsh.listed." + UUID().uuidString)
    let alias = root.appendingPathComponent("Alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
    let aliasedBundle = alias.appendingPathComponent(URL(fileURLWithPath: installed.path).lastPathComponent).path
    let bundled = ApplicationInfo(pid: getpid(), name: "Listed Editor", bundleID: installed.bundleID, path: aliasedBundle,
                                  executablePath: executable, regular: true)
    let pathlessPID: Int32 = getpid() == 4242 ? 4243 : 4242
    let pathless = ApplicationInfo(pid: pathlessPID, name: "Pathless", bundleID: nil, path: nil,
                                   executablePath: executable, regular: true)
    let catalog = ApplicationCatalogSnapshot(applications: [bundled, pathless], frontPID: nil)
    let worker = AXWorker(cancellation: CancellationLatch(), axTimeout: 1, textEventInterval: 0, maxClickHoldMs: 5000,
                          sessionState: { false })
    func parameters(_ method: String, _ values: [String: JSONValue] = [:]) throws -> RequestParameters {
        try RequestParameters(NativeRequest(data: JSONEncoder().encode(JSONValue.object([
            "id": .string("fixture"), "method": .string(method), "params": .object(values),
        ]))))
    }
    do {
        let listed = try await worker.execute("listApps", deadline: .now + .seconds(30), params: parameters("listApps"), catalog: catalog)
        guard case .result(.array(let rows)) = listed else { throw NativeFailure(code: "TEST", message: "Expected listApps rows") }
        let byPID = Dictionary(uniqueKeysWithValues: rows.map { (Int($0["pid"].number ?? 0), $0) })
        let bundledRow = try #require(byPID[Int(getpid())])
        let pathlessRow = try #require(byPID[Int(pathlessPID)])
        let identity = try #require(bundledRow["identity"].string)
        #expect(identity == installed.path)
        #expect(bundled.matches(identity))
        #expect(pathlessRow.object?.keys.contains("identity") == true)
        #expect(pathlessRow["identity"] == .null)
        #expect(pathlessRow["pid"] == .number(Double(pathlessPID)))
        #expect(pathless.matches(String(pathlessPID)))
        #expect(pathlessRow["isRunning"] == .bool(true))
        let selected = try await worker.execute("getApp", deadline: .now + .seconds(30), params: parameters("getApp", ["selector": .string(identity)]),
                                                catalog: catalog)
        guard case .result(let application) = selected else {
            throw NativeFailure(code: "TEST", message: "Expected application selection")
        }
        #expect(application["pid"] == .number(Double(getpid())))
        #expect(application["identity"] == .null)
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
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
        let outcome = try await worker.execute("getApp", deadline: .now + .seconds(30), params: params, catalog: catalog, installed: installed)
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
        let byPID = try await worker.execute("getApp", deadline: .now + .seconds(30), params: RequestParameters(NativeRequest(data: request)), catalog: instances)
        guard case .result(let selected) = byPID else { throw NativeFailure(code: "TEST", message: "Expected PID selection") }
        #expect(selected["pid"] == .number(Double(getpid())))
        #expect(selected["appHandle"].string == handle)
    } catch {
        await worker.shutdown()
        throw error
    }
    await worker.shutdown()
}

@Test @MainActor func emptySearchListsAllApplicationsWhileBroadQueriesReject() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    _ = try fixtureApplication(root, name: "Fixture One", identifier: "test.dsh.one." + UUID().uuidString)
    _ = try fixtureApplication(root, name: "Fixture Two", identifier: "test.dsh.two." + UUID().uuidString)
    let all = try ApplicationDiscovery.applications(matching: "", exact: false, limit: 1,
                                                   cancellation: CancellationLatch(), roots: [root])
    #expect(all.map(\.name) == ["Fixture One", "Fixture Two"])
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
