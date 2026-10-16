// Installed application discovery uses isolated bundles and does not launch user applications.
import AppKit
import Foundation
import Testing
@testable import CuaNative

private func fixtureApplication(_ directory: URL, name: String, identifier: String) throws -> InstalledApplication {
    let app = directory.appendingPathComponent(name + ".app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/app")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let info = ["CFBundleIdentifier": identifier, "CFBundleName": name, "CFBundleExecutable": "app", "CFBundlePackageType": "APPL"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    try Data("fixture executable".utf8).write(to: executable)
    return try #require(InstalledApplication.read(app))
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

@Test func unsignedPendingIdentityChangesWhenTheExecutableChanges() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-apps-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = try fixtureApplication(root, name: "Fixture", identifier: "test.dsh.identity." + UUID().uuidString)
    let before = try ApplicationAuthorization.describeInstalled(app)
    #expect(before["persistable"] == .bool(false))
    try Data("replacement executable".utf8).write(to: URL(fileURLWithPath: app.executablePath))
    let after = try ApplicationAuthorization.describeInstalled(app)
    #expect(before["id"] != after["id"])
}
