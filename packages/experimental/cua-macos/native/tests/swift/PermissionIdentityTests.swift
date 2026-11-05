// The selected catalog entry must still identify the executable inspected for consent.
import AppKit
import Darwin
import Foundation
import Testing
@testable import CuaNative

@Test func rejectsAChangedExecutableBeforeProducingAnAuthorizationIdentity() throws {
    let identity = try NativePlatform.identity(getpid())
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: "/not/the/running/executable")
        Issue.record("A changed executable was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "STALE_APP")
    }
}

@Test func readsTheProcessPathWhenTheCatalogHasNoExecutableLocation() throws {
    let identity = try NativePlatform.identity(getpid())
    let path = try #require(NativePlatform.executablePath(identity.pid))
    let observed = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: nil)
    #expect(observed["persistable"] == .bool(true))
    #expect(try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: path) == observed)
}

@Test(arguments: [ENOENT, ESRCH, EIO, ENODEV, EPERM, EACCES, ENAMETOOLONG, EOVERFLOW, ENOMEM, ENOBUFS])
func liveBundleIdentitySurvivesAnUnavailableExecutablePath(error: Int32) throws {
    let identity = try NativePlatform.identity(getpid())
    let expectedPath = try #require(NativePlatform.executablePath(identity.pid))
    let bundle: (Int32) -> (identifier: String?, url: URL?) = { _ in ("test.dsh.bundle", nil) }
    let before = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: expectedPath, readBundle: bundle)
    var queries = 0
    let after = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: expectedPath,
        readBundle: bundle, readPath: { _ in queries += 1; return .failure(NativePlatform.executablePathFailure(error)) })
    try NativePlatform.verify(identity)
    #expect(after["id"] == before["id"])
    #expect(after["persistable"] == .bool(true))
    #expect(after.object?["executablePath"] == nil)
    #expect(queries == 1)
}

@Test(arguments: [ENOENT, ESRCH, EIO, ENODEV, EPERM, EACCES, ENAMETOOLONG, EOVERFLOW, ENOMEM, ENOBUFS])
func missingBundleAndPathReportsThePathFailureWithoutRetry(error: Int32) throws {
    let identity = try NativePlatform.identity(getpid())
    var queries = 0
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: nil,
            readBundle: { _ in (nil, nil) }, readPath: { _ in queries += 1; return .failure(NativePlatform.executablePathFailure(error)) })
        Issue.record("An application without either identity was accepted")
    } catch let failure as NativeFailure {
        #expect(failure.code == "APP_PATH_UNAVAILABLE")
        #expect(failure.message.contains("errno \(error)"))
        #expect(!failure.message.contains("exited"))
    }
    try NativePlatform.verify(identity)
    #expect(queries == 1)
}

@Test func availablePathsStillRejectADifferentTargetWithAValidBundleIdentifier() throws {
    let identity = try NativePlatform.identity(getpid())
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: "/another/executable",
            readBundle: { _ in ("test.dsh.bundle", nil) })
        Issue.record("A mismatched target path was accepted")
    } catch let failure as NativeFailure { #expect(failure.code == "STALE_APP") }
}

@Test func bundleIdentityCannotAuthorizeAProcessThatExitsDuringInspection() throws {
    let process = Process(), input = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/cat")
    process.standardInput = input
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    defer {
        input.fileHandleForWriting.closeFile()
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
    let identity = try NativePlatform.identity(process.processIdentifier)
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: nil,
            readBundle: { _ in ("test.dsh.bundle", nil) }, readPath: { _ in
                process.terminate()
                process.waitUntilExit()
                return .failure(NativePlatform.executablePathFailure(ENOENT))
            })
        Issue.record("An exited process was authorized by its bundle identifier")
    } catch let failure as NativeFailure { #expect(failure.code == "APP_UNAVAILABLE") }
}

@Test(arguments: [Int32(0), EIO, EPERM, EACCES, ENOMEM])
func failedProcessInspectionDoesNotReportAnExit(error: Int32) {
    let failure = NativePlatform.processIdentityFailure(error)
    #expect(failure.code == "PROCESS_INSPECTION_FAILED")
    #expect(!failure.message.contains("exited"))
    #expect(!failure.message.contains("Success"))
}

@MainActor @Test func applicationIconsUseBoundedNativePNGs() throws {
    let encoded = try #require(ApplicationCatalog.icon(at: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"))
    #expect(encoded.hasPrefix("data:image/png;base64,"))
    let data = try #require(Data(base64Encoded: String(encoded.dropFirst("data:image/png;base64,".count))))
    let bitmap = try #require(NSBitmapImageRep(data: data))
    #expect(bitmap.pixelsWide == 64)
    #expect(bitmap.pixelsHigh == 64)
    #expect(encoded.utf8.count <= 65536)
}

@Test func unbundledRunningProcessesReceivePersistentPathConsent() throws {
    var records: [JSONValue] = []
    for _ in 0..<2 {
        let process = Process()
        let input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/cat")
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        defer {
            input.fileHandleForWriting.closeFile()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        let identity = try NativePlatform.identity(process.processIdentifier)
        let executable = try #require(NativePlatform.executablePath(identity.pid))
        let authorization = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: executable)
        #expect(authorization["persistable"] == .bool(true))
        #expect(authorization["id"].string?.count == 64)
        records.append(authorization)
    }
    #expect(records[0] == records[1])
}

@Test func resolvesTheCurrentProcessResponsibility() throws {
    let responsible = try #require(NativePlatform.responsiblePID(getpid()))
    #expect(responsible > 0)
    #expect(NativePlatform.responsiblePID(responsible) == responsible)
}

@MainActor @Test func unknownResponsibilityDoesNotInventAnApplication() {
    #expect(SystemPermissions.responsibleApplication(for: 1) == nil)
    #expect(SystemPermissions.responsibleApplication(for: Int32.max) == nil)
    #expect(NativePlatform.responsiblePID(Int32.max) == nil)
}

@MainActor @Test func permissionStatusKeepsProcessDiagnosticsSeparateFromLaunchMetadata() {
    let permissions = SystemPermissions()
    let state = permissions.status()
    #expect(state["helper"]["pid"] == .number(Double(getpid())))
    #expect(state["parent"]["pid"] == .number(Double(getppid())))
    if let source = state["launchApplication"].object {
        #expect(source["name"]?.string?.isEmpty == false)
        #expect(source["path"]?.string?.hasSuffix(".app") == true)
    }
    #expect(permissions.status()["launchApplication"] == state["launchApplication"])
}
