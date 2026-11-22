// WindowManager exposes Stage Manager piles as accessibility buttons with member window IDs.
import AppKit
import ApplicationServices
import Foundation

struct StageManagerShelf {
    struct Pile {
        let button: AXUIElement
        let ids: [UInt32]
    }

    private let manager: ProcessIdentity

    @MainActor static func current() throws -> Self? {
        guard UserDefaults(suiteName: "com.apple.WindowManager")?.bool(forKey: "GloballyEnabled") == true else { return nil }
        guard let process = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WindowManager").first(where: {
            !$0.isTerminated && $0.bundleURL?.path == "/System/Library/CoreServices/WindowManager.app"
        }) else { throw Self.unavailable("Stage Manager is enabled but its window list is unavailable.") }
        return Self(manager: try NativePlatform.identity(process.processIdentifier))
    }

    func piles(_ access: AXAccess) throws -> [Pile] {
        try NativePlatform.verify(manager)
        var result: [Pile] = []
        for group in try access.children(AXUIElementCreateApplication(manager.pid)) where try access.string(group, "AXRole") == "AXGroup" {
            for list in try access.children(group) where try access.string(list, "AXRole") == "AXList" {
                for button in try access.children(list) where try access.string(button, "AXRole") == "AXButton" {
                    guard let ids = try windowIDs(button, access) else { continue }
                    result.append(Pile(button: button, ids: ids))
                }
            }
        }
        return result
    }

    private func windowIDs(_ button: AXUIElement, _ access: AXAccess) throws -> [UInt32]? {
        guard let raw = try access.attribute(button, "AXWindowsIDs"), let numbers = raw as? [NSNumber], !numbers.isEmpty else { return nil }
        let ids = numbers.compactMap { CFGetTypeID($0) == CFNumberGetTypeID() ? UInt32(exactly: $0.doubleValue) : nil }
        return ids.count == numbers.count && !ids.contains(0) ? ids : nil
    }

    /// Compare sizes in screen points, allowing outward rounding at fractional window edges.
    static func matchesWindowSize(_ displayed: WindowBounds, _ actual: WindowBounds) -> Bool {
        displayed.width > 0 && displayed.height > 0 && actual.width > 0 && actual.height > 0 &&
            abs(displayed.width - actual.width) <= 1 && abs(displayed.height - actual.height) <= 1
    }

    static func canAdd(_ id: UInt32, members: [UInt32], owned: Set<UInt32>, appScoped: Bool) -> Bool {
        members.contains(id) && owned.contains(id) && (members.count == 1 || (appScoped && members.allSatisfy(owned.contains)))
    }

    /// The action selects the top member. An app-scoped call can accept any member only if all belong to that app.
    func join(_ pile: Pile, windowID: UInt32, owner: ProcessIdentity, appScoped: Bool, foreground: (pid: Int32?, windowID: UInt32?), access: AXAccess) throws {
        try NativePlatform.verify(manager)
        try NativePlatform.verify(owner)
        let owned = Set(NativePlatform.applicationWindows(owner.pid).map(\.windowID))
        guard Self.canAdd(windowID, members: pile.ids, owned: owned, appScoped: appScoped) else {
            throw Self.unavailable("The pile contains multiple windows and Stage Manager only offers to add its top window.")
        }
        var buttonPID: pid_t = 0
        guard AXUIElementGetPid(pile.button, &buttonPID) == .success, buttonPID == manager.pid,
              try access.actions(pile.button).contains("AXAddToStage"), try windowIDs(pile.button, access) == pile.ids else {
            throw Self.unavailable("The Stage Manager pile changed or does not offer Add Window to Stage.")
        }
        guard NativePlatform.foregroundAppWindow() == foreground else { throw Self.unavailable("The active group changed before the window could be added.") }
        try access.perform(pile.button, "AXAddToStage")
    }

    private static func unavailable(_ message: String) -> NativeFailure {
        NativeFailure(code: "BACKGROUND_RESTORE_UNAVAILABLE", message: message + " Inspect the desktop before using app.activate().")
    }
}
