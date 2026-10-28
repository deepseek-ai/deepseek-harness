// Shared helper admission preserves connection settings and private runtime ownership.
import Foundation
import Darwin
import Testing
@testable import CuaNative

private let runtimeKey = String(repeating: "a", count: 64)

private func hello(overrides: [String: JSONValue] = [:]) throws -> Data {
    var config: [String: JSONValue] = [
        "maxRequestBytes": .number(4096), "maxResponseBytes": .number(8192), "axTimeoutMs": .number(250),
        "textEventIntervalMs": .number(0.5), "maxClickHoldMs": .number(7000), "screenshotTimeoutMs": .number(2000),
        "timeoutMs": .number(8000), "graceMs": .number(500),
    ]
    config.merge(overrides) { _, value in value }
    return try JSONEncoder().encode(JSONValue.object([
        "type": .string("hello"), "protocol": .number(1), "runtimeKey": .string(runtimeKey), "config": .object(config),
    ]))
}

@Test func admitsPerConnectionConfiguration() throws {
    let configuration = try HelperConfiguration(hello: hello(), runtimeKey: runtimeKey)
    #expect(configuration.maxRequestBytes == 4096)
    #expect(configuration.maxResponseBytes == 8192)
    #expect(configuration.axTimeoutSeconds == 0.25)
    #expect(configuration.textEventIntervalSeconds == 0.0005)
    #expect(configuration.maxClickHoldMs == 7000)
    #expect(configuration.screenshotTimeoutSeconds == 2)
    #expect(configuration.timeoutSeconds == 8)
    #expect(configuration.shutdownGraceSeconds == 0.5)
    #expect(throws: NativeFailure.self) {
        try HelperConfiguration(hello: hello(), runtimeKey: String(repeating: "b", count: 64))
    }
}

@Test func resolvesClickHoldLimitFromHelperArguments() throws {
    #expect(try HelperConfiguration(arguments: []).maxClickHoldMs == 5000)
    for limit in [0, 7000] {
        #expect(try HelperConfiguration(arguments: ["--max-click-hold-ms", String(limit)]).maxClickHoldMs == limit)
    }
    for invalid in ["-1", "0.5", "2147483648", "nan"] {
        #expect(throws: NativeFailure.self) { try HelperConfiguration(arguments: ["--max-click-hold-ms", invalid]) }
    }
}

@Test(arguments: [
    ("maxRequestBytes", JSONValue.number(1023)), ("maxResponseBytes", .number(1.5)),
    ("axTimeoutMs", .number(0)), ("textEventIntervalMs", .number(-1)),
    ("screenshotTimeoutMs", .number(0)), ("timeoutMs", .string("8000")), ("graceMs", .number(-1)),
    ("maxClickHoldMs", .number(-1)), ("maxClickHoldMs", .number(0.5)),
    ("maxClickHoldMs", .number(2147483648)), ("unexpected", .bool(true)),
])
func refusesInvalidSharedConfiguration(_ name: String, _ value: JSONValue) throws {
    #expect(throws: NativeFailure.self) { try HelperConfiguration(hello: hello(overrides: [name: value]), runtimeKey: runtimeKey) }
}

@Test func rejectsSharedHelloFieldsAndProtocolVersions() throws {
    let base = try JSONDecoder().decode(JSONValue.self, from: hello())
    for (name, value) in [("protocol", JSONValue.number(2)), ("type", .string("request")), ("extra", .null)] {
        var fields = try #require(base.object)
        fields[name] = value
        let data = try JSONEncoder().encode(JSONValue.object(fields))
        #expect(throws: NativeFailure.self) { try HelperConfiguration(hello: data, runtimeKey: runtimeKey) }
    }
}

@Test func versionLocksStayExclusiveUntilOwnerRelease() throws {
    let directory = "/tmp/cua-\(UUID().uuidString.prefix(12))"
    let options = try SharedHelperOptions(arguments: ["--ensure-shared", "--runtime-key", runtimeKey,
                                                     "--runtime-directory", directory, "--startup-timeout-ms", "1000"])
    try options.prepareDirectory()
    defer { try? FileManager.default.removeItem(atPath: directory) }
    var first = try SharedHelperLock(path: options.versionLockPath)
    #expect(first != nil)
    try withExtendedLifetime(first) {
        let competing = try SharedHelperLock(path: options.versionLockPath)
        #expect(competing == nil)
    }
    first = nil
    let successor = try SharedHelperLock(path: options.versionLockPath)
    #expect(successor != nil)
}

@Test func refusesSymlinkRuntimeDirectories() throws {
    let directory = "/tmp/cua-\(UUID().uuidString.prefix(12))"
    guard symlink("/tmp", directory) == 0 else { throw SharedSocket.failure("Creating fixture symlink") }
    defer { unlink(directory) }
    let options = try SharedHelperOptions(arguments: ["--ensure-shared", "--runtime-key", runtimeKey,
                                                     "--runtime-directory", directory, "--startup-timeout-ms", "1000"])
    #expect(throws: NativeFailure.self) { try options.prepareDirectory() }
}

@Test func validatesSharedLaunchIdentityAndSocketPath() throws {
    for arguments in [
        ["--ensure-shared", "--runtime-key", "invalid", "--runtime-directory", "/tmp/cua", "--startup-timeout-ms", "1000"],
        ["--serve", "--runtime-key", runtimeKey, "--runtime-directory", "relative", "--startup-timeout-ms", "1000"],
        ["--serve", "--runtime-key", runtimeKey, "--runtime-directory", "/tmp/cua", "--startup-timeout-ms", "1000", "--startup-id", "invalid"],
        ["--ensure-shared", "--runtime-key", runtimeKey, "--runtime-directory", "/tmp/cua", "--startup-timeout-ms", "1000", "--startup-id", UUID().uuidString],
        ["--serve", "--runtime-key", runtimeKey, "--runtime-directory", "/tmp/cua", "--startup-timeout-ms", "0"],
        ["--serve", "--runtime-key", runtimeKey, "--runtime-directory", "/" + String(repeating: "x", count: 100), "--startup-timeout-ms", "1000"],
    ] {
        #expect(throws: NativeFailure.self) { try SharedHelperOptions(arguments: arguments) }
    }
}

@Test func startupFailuresAreScopedToOneLaunchAttempt() throws {
    let directory = "/tmp/cua-\(UUID().uuidString.prefix(12))"
    let arguments = ["--serve", "--runtime-key", runtimeKey, "--runtime-directory", directory,
                     "--startup-timeout-ms", "5000", "--startup-id"]
    let options = try SharedHelperOptions(arguments: arguments + [UUID().uuidString])
    try options.prepareDirectory()
    defer { try? FileManager.default.removeItem(atPath: directory) }
    let other = try SharedHelperOptions(arguments: arguments + [UUID().uuidString])
    try options.recordStartupFailure(NativeFailure(code: "NATIVE_RUNTIME_CONFLICT", message: "path is occupied"))
    let failure = try SharedHelperOptions.startupFailure(at: options.failurePath)
    #expect(failure?.code == "NATIVE_RUNTIME_CONFLICT")
    #expect(failure?.message == "path is occupied")
    #expect(try SharedHelperOptions.startupFailure(at: other.failurePath) == nil)
    var info = stat()
    #expect(lstat(try #require(options.failurePath), &info) == 0)
    #expect(info.st_mode & 0o777 == 0o600)
}

@Test func readinessUsesTheRemainingStartupBudget() throws {
    let directory = "/tmp/cua-\(UUID().uuidString.prefix(12))"
    let options = try SharedHelperOptions(arguments: ["--ensure-shared", "--runtime-key", runtimeKey,
        "--runtime-directory", directory, "--startup-timeout-ms", "5000"])
    try options.prepareDirectory()
    defer { try? FileManager.default.removeItem(atPath: directory) }
    let start = DispatchTime.now().uptimeNanoseconds
    do {
        _ = try options.existingReady(deadline: start)
        Issue.record("Expired startup returned readiness")
    } catch let error as NativeFailure { #expect(error.code == "NATIVE_STARTUP_TIMEOUT") }
    #expect(DispatchTime.now().uptimeNanoseconds - start < 1_000_000_000)
}

@Test func exitedStartupProcessFailsWithoutRunningTheMainRunLoop() throws {
    let directory = "/tmp/cua-\(UUID().uuidString.prefix(12))"
    let options = try SharedHelperOptions(arguments: ["--ensure-shared", "--runtime-key", runtimeKey,
        "--runtime-directory", directory, "--startup-timeout-ms", "5000"])
    try options.prepareDirectory()
    defer { try? FileManager.default.removeItem(atPath: directory) }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try child.run()
    child.waitUntilExit()
    let start = DispatchTime.now().uptimeNanoseconds
    do {
        _ = try options.existingReady(deadline: options.startupDeadline(), launchedPID: child.processIdentifier)
        Issue.record("Exited startup returned readiness")
    } catch let error as NativeFailure { #expect(error.code == "NATIVE_STARTUP") }
    #expect(DispatchTime.now().uptimeNanoseconds - start < 1_000_000_000)
}
