// Permission control tests replace native presentation and never change the machine's grants.
import AppKit
import Foundation
import Testing
@testable import CuaNative

@MainActor private final class GuideFixture: PermissionGuidePresenting {
    var isOpen = false
    var owner: UUID?
    var application: PermissionGuideApplication?
    var text: PermissionGuideText?
    var granted: (@MainActor () -> Bool)?
    var settingsFailure = false
    func show(application: PermissionGuideApplication, text: PermissionGuideText, owner: UUID,
              interval: TimeInterval, granted: @escaping @MainActor () -> Bool) throws {
        self.application = application
        self.text = text
        self.owner = owner
        self.granted = granted
        isOpen = true
    }
    func reportSettingsFailure() { settingsFailure = true }
    func close(owner: UUID) {
        if self.owner == owner { isOpen = false; granted = nil }
    }
}

private let copy = PermissionGuideText(instruction: "Drag {application} to allow access", backLabel: "Back",
    finderLabel: "Show in Finder", unavailableMessage: "Application unavailable", settingsMessage: "Open System Settings manually")
private let application = JSONValue.object(["name": .string("Helper.app"), "path": .string("/generation/Helper.app"), "bundleId": .string("test.helper")])

@MainActor @Test(arguments: ["accessibility", "screenRecording"])
func permissionRequestOpensTheNativeGuideAndMatchingSettings(permission: String) throws {
    var opened: [URL] = []
    var allowed = false
    let guide = GuideFixture()
    let owner = UUID()
    let actions = SystemPermissionActions(accessibility: { allowed }, screenRecording: { allowed }, open: { opened.append($0); return true })
    let permissions = SystemPermissions(application: application, actions: actions, guide: guide)
    #expect(!guide.isOpen)
    let state = try permissions.request(permission, owner: owner, text: copy, interval: 1)
    #expect(state[permission] == .bool(false))
    #expect(guide.isOpen)
    #expect(guide.application?.url.path == "/generation/Helper.app")
    #expect(guide.text?.instruction == copy.instruction)
    let pane = permission == "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
    #expect(opened.first?.absoluteString == "x-apple.systempreferences:com.apple.preference.security?\(pane)")
    allowed = true
    #expect(guide.granted?() == true)
    #expect(permissions.status()[permission] == .bool(true))
    permissions.closeGuide(owner: UUID())
    #expect(guide.isOpen)
    permissions.closeGuide(owner: owner)
    #expect(!guide.isOpen)
}

@MainActor @Test
func settingsFailureRetainsTheNativeGuideWithManualInstructions() throws {
    let guide = GuideFixture()
    let permissions = SystemPermissions(application: application,
        actions: SystemPermissionActions(accessibility: { false }, screenRecording: { false }, open: { _ in false }), guide: guide)
    do {
        _ = try permissions.request("accessibility", owner: UUID(), text: copy, interval: 1)
        Issue.record("Settings-open failure was accepted")
    } catch let failure as NativeFailure { #expect(failure.code == "SETTINGS_UNAVAILABLE") }
    #expect(guide.isOpen && guide.settingsFailure)
}

@MainActor @Test
func grantedPermissionsOpenSettingsWithoutCreatingAGuide() throws {
    let guide = GuideFixture()
    var opened = false
    let permissions = SystemPermissions(application: application,
        actions: SystemPermissionActions(accessibility: { true }, screenRecording: { true }, open: { _ in opened = true; return true }), guide: guide)
    #expect(try permissions.request("screenRecording", owner: UUID(), text: copy, interval: 1)["screenRecording"] == .bool(true))
    #expect(opened && !guide.isOpen)
}

@MainActor @Test
func anUnknownPermissionApplicationDoesNotOfferAnotherBundle() throws {
    let guide = GuideFixture()
    let permissions = SystemPermissions(application: nil,
        actions: SystemPermissionActions(accessibility: { false }, screenRecording: { false }, open: { _ in true }), guide: guide)
    do {
        _ = try permissions.request("accessibility", owner: UUID(), text: copy, interval: 1)
        Issue.record("Unknown application was accepted")
    } catch let failure as NativeFailure { #expect(failure.code == "APPLICATION_UNAVAILABLE") }
    #expect(!guide.isOpen)
}

@Test func theGuideOverlaysTheSettingsBottomAndStaysWithinItsDisplay() {
    let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
    let settings = CGRect(x: 300, y: 100, width: 800, height: 700)
    let frame = PermissionGuidePlacement.frame(settings: settings, visible: visible, size: CGSize(width: 620, height: 128))
    #expect(frame.midX == settings.midX)
    #expect(frame.minY == settings.minY + 8)
    #expect(visible.contains(frame))
    let secondary = CGRect(x: -800, y: -600, width: 800, height: 600)
    let outside = PermissionGuidePlacement.frame(settings: CGRect(x: -1000, y: -800, width: 700, height: 700),
        visible: secondary, size: CGSize(width: 620, height: 128))
    #expect(secondary.contains(outside))
    let fallback = PermissionGuidePlacement.frame(settings: nil, visible: secondary, size: CGSize(width: 1200, height: 900))
    #expect(secondary.contains(fallback))
}

@Test func theDragSourceRejectsReplacedAndMissingApplications() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-guide-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("Helper.app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/helper")
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let info = ["CFBundleIdentifier": "test.helper", "CFBundleExecutable": "helper", "CFBundlePackageType": "APPL"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
    let target = PermissionGuideApplication(url: app, identifier: "test.helper")
    #expect(try target.validatedURL().path == app.path)
    #expect(target.name == "Helper")
    #expect(throws: (any Error).self) { try PermissionGuideApplication(url: app, identifier: "test.other").validatedURL() }
    try FileManager.default.removeItem(at: app)
    #expect(throws: (any Error).self) { try target.validatedURL() }
}

@Test func permissionGuideChoosesTheSettingsMainWindowBehindAuthentication() {
    let main = PermissionGuideWindow(id: 10, frame: CGRect(x: 100, y: 80, width: 800, height: 700))
    let authentication = PermissionGuideWindow(id: 11, frame: CGRect(x: 300, y: 250, width: 260, height: 340))
    #expect(PermissionGuidePlacement.target(in: [authentication, main], pinned: nil)?.id == main.id)
    #expect(PermissionGuidePlacement.target(in: [main, authentication], pinned: nil)?.id == main.id)
    #expect(PermissionGuidePlacement.target(in: [], pinned: nil) == nil)
}

@Test func permissionGuideKeepsItsWindowIdentityAcrossDialogsAndResizing() {
    let resized = PermissionGuideWindow(id: 10, frame: CGRect(x: -800, y: 50, width: 600, height: 500))
    let other = PermissionGuideWindow(id: 11, frame: CGRect(x: 100, y: 80, width: 1200, height: 900))
    #expect(PermissionGuidePlacement.target(in: [other, resized], pinned: resized.id)?.frame == resized.frame)
    #expect(PermissionGuidePlacement.target(in: [other], pinned: resized.id) == nil)
}

@MainActor @Test(arguments: [NSSize(width: 360, height: 160), NSSize(width: 620, height: 128)])
func permissionGuideMaterialKeepsTransparentCornersWhenResized(size: NSSize) throws {
    let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    let context = try #require(NSGraphicsContext(bitmapImageRep: bitmap))
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    PermissionGuideAppearance.materialMask().draw(in: NSRect(origin: .zero, size: size),
        from: .zero, operation: .copy, fraction: 1)
    for x in [0, bitmap.pixelsWide - 1] {
        for y in [0, bitmap.pixelsHigh - 1] {
            #expect(try #require(bitmap.colorAt(x: x, y: y)).alphaComponent == 0)
        }
    }
    #expect(try #require(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)).alphaComponent == 1)
    #expect(try #require(bitmap.colorAt(x: 25, y: 0)).alphaComponent == 1)
    #expect(try #require(bitmap.colorAt(x: 0, y: 25)).alphaComponent == 1)
}
