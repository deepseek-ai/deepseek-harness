// Real signed fixtures exercise cache publication, reuse, integrity and isolated permission ownership.
import CryptoKit
import Darwin
import Foundation
import Testing
@testable import CuaNative

private struct ApplicationFixture {
    let root: URL
    let application: URL
    let cache: URL
    var executable: URL { application.appendingPathComponent("Contents/MacOS/dsh-cua-native") }
    var resource: URL { application.appendingPathComponent("Contents/Resources/value.txt") }
    var key: String { get throws { SHA256.hash(data: try Data(contentsOf: executable)).map { String(format: "%02x", $0) }.joined() } }
    var deadline: UInt64 { DispatchTime.now().uptimeNanoseconds + 30_000_000_000 }

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("cua-application-\(UUID().uuidString)")
        application = root.appendingPathComponent("Desktop.app/Contents/Resources/DSH Computer Use.app")
        cache = root.appendingPathComponent("support")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: resource.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: executable)
        try Data("original resource".utf8).write(to: resource)
        let plist = try PropertyListSerialization.data(fromPropertyList: [
            "CFBundleIdentifier": "dev.dsh.cua.cache-test.\(UUID().uuidString)",
            "CFBundleExecutable": "dsh-cua-native", "CFBundleName": "DSH Computer Use", "CFBundlePackageType": "APPL",
        ], format: .xml, options: 0)
        try plist.write(to: application.appendingPathComponent("Contents/Info.plist"))
        try sign()
    }

    func sign() throws {
        let process = Process(), finished = DispatchSemaphore(value: 0)
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--force", "--sign", "-", "--timestamp=none", application.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        if finished.wait(timeout: .now() + 30) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
            throw NativeFailure(code: "FIXTURE_TIMEOUT", message: "Ad-hoc fixture signing did not exit")
        }
        #expect(process.terminationReason == .exit)
        try #require(process.terminationStatus == 0)
    }

    func close() {
        do { try FileManager.default.removeItem(at: root) }
        catch { Issue.record("Could not remove owned application fixture: \(error)") }
    }
}

@Test func onlyNestedApplicationsNeedAnIndependentInstallation() throws {
    #expect(StandaloneApplication.hasApplicationAncestor(URL(fileURLWithPath: "/Applications/Desktop.app/Contents/Helper.app")))
    #expect(StandaloneApplication.hasApplicationAncestor(URL(fileURLWithPath: "/Applications/Desktop.APP/Helper.app")))
    let standalone = URL(fileURLWithPath: "/Users/example/Helper.app")
    #expect(!StandaloneApplication.hasApplicationAncestor(standalone))
    #expect(try StandaloneApplication.prepare(standalone, runtimeKey: "unused", deadline: 0) == standalone)
}

@Test func aSignedHelperIsPublishedOutsideItsEnclosingApplicationAndReused() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let key = try f.key
    let installed = try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline)
    #expect(!StandaloneApplication.hasApplicationAncestor(installed))
    #expect(try Data(contentsOf: installed.appendingPathComponent("Contents/MacOS/dsh-cua-native")) == Data(contentsOf: f.executable))
    #expect(try Data(contentsOf: installed.appendingPathComponent("Contents/Resources/value.txt")) == Data(contentsOf: f.resource))
    #expect(try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline) == installed)
}

@Test func changingTheSignedApplicationRetainsTheEarlierGeneration() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let old = try StandaloneApplication.install(f.application, runtimeKey: f.key, root: f.cache, deadline: f.deadline)
    try Data("new resource".utf8).write(to: f.resource)
    try f.sign()
    let new = try StandaloneApplication.install(f.application, runtimeKey: f.key, root: f.cache, deadline: f.deadline)
    #expect(old != new)
    #expect(try String(contentsOf: old.appendingPathComponent("Contents/Resources/value.txt"), encoding: .utf8) == "original resource")
    #expect(try String(contentsOf: new.appendingPathComponent("Contents/Resources/value.txt"), encoding: .utf8) == "new resource")
}

@Test(arguments: ["Contents/Resources/value.txt", "Contents/MacOS/dsh-cua-native"])
func aChangedCachedApplicationIsRejected(file: String) throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let key = try f.key
    let installed = try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline)
    try Data("changed".utf8).write(to: installed.appendingPathComponent(file))
    #expect(throws: (any Error).self) {
        try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline)
    }
}

@Test func anInvalidSourceLeavesNoPartialPublishedApplication() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let key = try f.key
    try Data("unsigned change".utf8).write(to: f.resource)
    #expect(throws: (any Error).self) {
        try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline)
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.cache.path) == ["\(key).lock"])
}

@Test func applicationStorageCannotItselfBeNestedInAnotherApplication() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    #expect(throws: (any Error).self) {
        try StandaloneApplication.install(f.application, runtimeKey: f.key,
                                          root: f.root.appendingPathComponent("Other.app/cache"), deadline: f.deadline)
    }
}

@Test func aCachedSymlinkCannotRedirectTheHelperIntoAnEnclosingApplication() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let key = try f.key
    try FileManager.default.createDirectory(at: f.cache, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: f.cache.appendingPathComponent(key),
                                               withDestinationURL: f.application.deletingLastPathComponent())
    #expect(throws: (any Error).self) {
        try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache, deadline: f.deadline)
    }
}

@Test func aCompetingInstallerDoesNotUseAPartialGeneration() throws {
    let f = try ApplicationFixture(); defer { f.close() }
    let key = try f.key
    try FileManager.default.createDirectory(at: f.cache, withIntermediateDirectories: true)
    let lock = try #require(try SharedHelperLock(path: f.cache.appendingPathComponent("\(key).lock").path))
    defer { withExtendedLifetime(lock) {} }
    #expect(throws: (any Error).self) {
        try StandaloneApplication.install(f.application, runtimeKey: key, root: f.cache,
                                          deadline: DispatchTime.now().uptimeNanoseconds)
    }
    #expect(!FileManager.default.fileExists(atPath: f.cache.appendingPathComponent(key).path))
}
