// Permission requests exercise system dispatch without prompting or changing the machine's grants.
import Foundation
import Testing
@testable import CuaNative

@MainActor @Test(arguments: ["accessibility", "screenRecording"])
func permissionRequestOpensSettingsEvenWhenPermissionRemainsDenied(permission: String) throws {
    var requests: [String] = []
    var opened: [URL] = []
    let actions = SystemPermissionActions(accessibility: { false }, screenRecording: { false },
        requestAccessibility: { requests.append("accessibility") }, requestScreenRecording: { requests.append("screenRecording") },
        open: { opened.append($0); return true }, reveal: { _ in Issue.record("Unexpected Finder request") })
    let permissions = SystemPermissions(application: nil, actions: actions)
    #expect(permissions.status()[permission] == .bool(false))
    #expect(requests.isEmpty && opened.isEmpty)
    for _ in 0..<2 { #expect(try permissions.request(permission)[permission] == .bool(false)) }
    #expect(requests == [permission, permission])
    let pane = permission == "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
    #expect(opened.map(\.absoluteString) == Array(repeating: "x-apple.systempreferences:com.apple.preference.security?\(pane)", count: 2))
}

@MainActor @Test
func grantedPermissionOpensSettingsWithoutPromptingAndOpenFailureIsVisible() throws {
    var opens = 0
    var actions = SystemPermissionActions(accessibility: { true }, screenRecording: { true },
        requestAccessibility: { Issue.record("Unexpected permission prompt") },
        requestScreenRecording: { Issue.record("Unexpected permission prompt") },
        open: { _ in opens += 1; return true }, reveal: { _ in Issue.record("Unexpected Finder request") })
    let permissions = SystemPermissions(application: nil, actions: actions)
    #expect(try permissions.request("accessibility")["accessibility"] == .bool(true))
    #expect(try permissions.request("screenRecording")["screenRecording"] == .bool(true))
    #expect(opens == 2)
    actions.open = { _ in false }
    let failed = SystemPermissions(application: nil, actions: actions)
    #expect(throws: (any Error).self) { try failed.request("accessibility") }
    #expect(throws: (any Error).self) { try failed.openSettings("unknown") }
    #expect(throws: (any Error).self) { try failed.revealApplication("/Applications/Other.app") }
}

@MainActor @Test
func finderSelectionRejectsAnotherOrRemovedApplication() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-cua-permission-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("Permission Helper.app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/helper")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let identifier = "test.dsh.permissions." + UUID().uuidString
    let info = ["CFBundleIdentifier": identifier, "CFBundleExecutable": "helper", "CFBundlePackageType": "APPL"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    var revealed: [URL] = []
    let actions = SystemPermissionActions(accessibility: { false }, screenRecording: { false },
        requestAccessibility: {}, requestScreenRecording: {}, open: { _ in false }, reveal: { revealed += $0 })
    let permissions = SystemPermissions(application: .object(["path": .string(app.path), "bundleId": .string(identifier)]), actions: actions)
    #expect(throws: (any Error).self) { try permissions.revealApplication(root.appendingPathComponent("Other.app").path) }
    #expect(revealed.isEmpty)
    #expect(try permissions.revealApplication(app.path)["revealed"] == .bool(true))
    #expect(revealed == [app])
    try FileManager.default.removeItem(at: app)
    #expect(throws: (any Error).self) { try permissions.revealApplication(app.path) }
    #expect(revealed.count == 1)
}
