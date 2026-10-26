// Actor-owned native identities, scoped AX snapshots and desktop operations.
import Foundation
import Dispatch
import ApplicationServices

final class NativeSerialExecutor: SerialExecutor {
    private let queue = DispatchQueue(label: "dsh.cua.ax")
    func enqueue(_ job: consuming ExecutorJob) {
        let unowned = UnownedJob(job)
        let executor = asUnownedSerialExecutor()
        queue.async { unowned.runSynchronously(on: executor) }
    }
    func checkIsolated() { dispatchPrecondition(condition: .onQueue(queue)) }
}

struct SnapshotScope: Hashable { let appHandle: String; let windowID: UInt32? }
struct NativeSnapshot {
    let id: String
    let scope: SnapshotScope
    let elements: [Int: AXUIElement]
}
struct CaptureTarget: Sendable {
    let appHandle: String
    let process: ProcessIdentity
    let window: WindowInfo
}
struct ForegroundPlan: Sendable {
    let appHandle: String
    let identity: ProcessIdentity
    let snapshotID: String?
    let index: Int?
    let targetWindowID: UInt32?
    let role: String?
    let main: Bool?
    let minimized: Bool?
    var isRaise: Bool { index != nil }
}
struct ForegroundObservation: Sendable {
    let frontPID: Int32?
    let focusedWindowID: UInt32?
    let frontWindowID: UInt32?
    let frontWindowPID: Int32?
    var json: JSONValue {
        .object(["frontPid": frontPID.map { .number(Double($0)) } ?? .null,
                 "focusedWindowId": focusedWindowID.map { .number(Double($0)) } ?? .null,
                 "frontWindowId": frontWindowID.map { .number(Double($0)) } ?? .null,
                 "frontWindowPid": frontWindowPID.map { .number(Double($0)) } ?? .null])
    }
}
struct PastePlan: Sendable {
    let handle: String
    let text: String
    let format: String
    let maxBytes: Int
    let readTimeout: Duration
    let maxElements: Int
    let maxDepth: Int
}
struct ApplicationLaunch: Sendable {
    let handle: String
    let application: InstalledApplication
    let authorization: JSONValue
}
private enum ApplicationTarget {
    case running(ProcessIdentity)
    case pending(InstalledApplication, JSONValue)
}
enum DriverOutcome: Sendable { case result(JSONValue), capture(CaptureTarget), foreground(ForegroundPlan), launch(ApplicationLaunch), paste(PastePlan), hover(WindowRoute, WindowPoint) }

actor AXWorker {
    nonisolated let executor = NativeSerialExecutor()
    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }
    private let namespace = UUID().uuidString
    private var generation: UInt64 = 0
    private var targets: [String: ApplicationTarget] = [:]
    private var snapshots: [SnapshotScope: NativeSnapshot] = [:]
    private var observedWindowBounds: [String: [UInt32: WindowBounds]] = [:]
    private let cancellation: CancellationLatch
    private let axTimeout: Float
    private let textEventInterval: Double
    private let maxClickHoldMs: Int
    private let sessionState: @Sendable () -> Bool?
    private var access: AXAccess?
    private var keyboard: KeyboardInput?
    private var pointer: WindowPointerInput?
    private var hovers: [String: AXHover] = [:]
    private var closed = false

    init(cancellation: CancellationLatch, axTimeout: Float, textEventInterval: Double, maxClickHoldMs: Int,
         sessionState: @escaping @Sendable () -> Bool? = NativePlatform.sessionLocked) {
        self.cancellation = cancellation
        self.axTimeout = axTimeout
        self.textEventInterval = textEventInterval
        self.maxClickHoldMs = maxClickHoldMs
        self.sessionState = sessionState
    }
    private func identifier(_ kind: String) throws -> String {
        guard generation < UInt64.max else { throw NativeFailure(code: "NATIVE_ERROR", message: "Native identity space exhausted") }
        generation += 1
        return "\(namespace):\(kind):\(generation)"
    }
    private func ax() -> AXAccess {
        if let access { return access }
        let created = AXAccess(timeout: axTimeout, cancellation: cancellation)
        access = created
        return created
    }
    private func inputs() -> (KeyboardInput, WindowPointerInput) {
        if let keyboard, let pointer { return (keyboard, pointer) }
        let poster = PIDEventPoster()
        let latch = cancellation
        let key = KeyboardInput(poster: poster, textEventInterval: textEventInterval, checkCancellation: { try latch.check() })
        let mouse = WindowPointerInput(poster: poster, checkCancellation: { try latch.check() })
        keyboard = key; pointer = mouse
        return (key, mouse)
    }
    private func observeSession() -> Bool? {
        let state = sessionState()
        if state != false { snapshots.removeAll(); observedWindowBounds.removeAll() }
        return state
    }
    private func forget(_ handle: String) {
        hovers.removeValue(forKey: handle)
        targets.removeValue(forKey: handle)
        snapshots = snapshots.filter { $0.key.appHandle != handle }
        observedWindowBounds.removeValue(forKey: handle)
    }
    func validateIdentity(_ handle: String) throws -> ProcessIdentity {
        guard !closed else { throw NativeFailure(code: "STALE_APP", message: "Helper is closing; acquire fresh application handles") }
        guard case .running(let identity)? = targets[handle] else { throw NativeFailure(code: "STALE_APP", message: "Application handle expired; call getApp again") }
        do { try NativePlatform.verify(identity) }
        catch { forget(handle); throw error }
        return identity
    }
    private func acquire(_ identity: ProcessIdentity) throws -> String {
        if let old = targets.first(where: { if case .running(let value) = $0.value { return value.pid == identity.pid }; return false }) {
            if case .running(let value) = old.value, value == identity { return old.key }
            forget(old.key)
        }
        let id = try identifier("app")
        targets[id] = .running(identity)
        return id
    }
    private func snapshot(_ handle: String, _ id: String) throws -> NativeSnapshot {
        guard let result = snapshots.values.first(where: { $0.scope.appHandle == handle && $0.id == id }) else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Snapshot expired; read fresh getAXState")
        }
        return result
    }
    private func element(_ handle: String, _ params: RequestParameters) throws -> AXUIElement {
        let value = try snapshot(handle, params.string("snapshotId"))
        let index = try params.integer("elementIndex", in: 0...Int.max)
        guard let element = value.elements[index] else { throw RequestParameters.invalid("elementIndex is absent from the selected snapshot") }
        return element
    }
    private func coordinateSnapshot(_ handle: String, _ params: RequestParameters, _ windowID: UInt32) throws {
        guard let id = try params.optionalString("snapshotId") else { return }
        let value = try snapshot(handle, id)
        guard value.scope.windowID == nil || value.scope.windowID == windowID else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Snapshot belongs to another window")
        }
    }
    private func coordinateWindow(_ identity: ProcessIdentity, _ windowID: UInt32, trace: ScreenshotTrace? = nil) throws -> WindowInfo {
        try WindowGeometry.resolve(owner: identity, windowID: windowID, readWindow: { pid, id in
            trace?.mark("window-info.begin")
            let window = try NativePlatform.ownedWindow(pid, id)
            trace?.mark("window-info.end")
            return window
        }) {
            // Capture without Accessibility permission retains its CG/SCK checks.
            guard AXIsProcessTrusted() else { return nil }
            trace?.mark("ax-geometry.begin")
            let bounds = try ax().windowBounds(windowID, owner: identity)
            trace?.mark("ax-geometry.end")
            return bounds
        }
    }
    private func observedCoordinateWindow(_ handle: String, _ identity: ProcessIdentity, _ windowID: UInt32) throws -> WindowInfo {
        let window = try coordinateWindow(identity, windowID)
        try WindowGeometry.validateObservedSize(observed: observedWindowBounds[handle]?[windowID], current: window.bounds)
        return window
    }
    static func actionKey(_ value: String) -> String {
        let name = AXTextFormatter.actionName(value)
        return name.filter { !$0.isWhitespace }.lowercased()
    }
    static func resolveAction(_ requested: String, names: [String]) throws -> String {
        if names.contains(requested) { return requested }
        let matches = names.filter { actionKey($0) == actionKey(requested) }
        guard matches.count == 1, let action = matches.first else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Action is missing or ambiguous; read details=true and use its complete name")
        }
        return action
    }
    static var actionResult: JSONValue { .object(["dispatched": .bool(true), "verified": .bool(false)]) }

    // Only observation failures allow a fresh read. Input failures can follow
    // partial effects and keep their original classification.
    static func observationFailure(_ failure: NativeFailure) -> NativeFailure {
        guard failure.accessibilityError == AXError.invalidUIElement.rawValue else { return failure }
        return NativeFailure(code: "STALE_SNAPSHOT",
                             message: "Accessibility tree changed during observation; read fresh getAXState",
                             accessibilityError: failure.accessibilityError)
    }

    func execute(_ method: String, params: RequestParameters, catalog: ApplicationCatalogSnapshot, installed: InstalledApplication? = nil,
                 trace: ScreenshotTrace? = nil) async throws -> DriverOutcome {
        try cancellation.check()
        guard !closed else { throw NativeFailure(code: "NATIVE_CLOSED", message: "Helper is closing") }
        let locked = observeSession()
        if method == "getCapabilities" {
            return .result(.object(["platform": .string("macos"), "permissions": .object([
                "accessibility": .bool(AXIsProcessTrusted()), "screenRecording": .bool(CGPreflightScreenCaptureAccess())]),
                "sessionLocked": locked.map(JSONValue.bool) ?? .null,
                "methods": .array(NativeProtocol.modelMethods.map(JSONValue.string)), "coordinateSpace": .string("window-points"), "browser": .bool(false)]))
        }
        if method == "listApps" { return .result(.array(catalog.applications.filter { $0.regular && $0.name != nil }.map(\.json))) }
        try NativePlatform.requireUnlocked(locked)
        if method == "getApp" {
            let selector = try params.string("selector")
            let matches = catalog.applications.filter { $0.matches(selector) }
            if matches.isEmpty, let installed {
                let authorization = try ApplicationAuthorization.describeInstalled(installed)
                let previous = targets.filter { if case .pending(let app, _) = $0.value { return app.path == installed.path }; return false }
                if let same = previous.first(where: { if case .pending(_, let value) = $0.value { return value == authorization }; return false }) {
                    return .result(pendingApplication(installed, handle: same.key, authorization: authorization))
                }
                for (handle, _) in previous { forget(handle) }
                let handle = try identifier("app")
                targets[handle] = .pending(installed, authorization)
                return .result(pendingApplication(installed, handle: handle, authorization: authorization))
            }
            guard !matches.isEmpty else { throw NativeFailure(code: "APP_UNAVAILABLE", message: "No running or installed application matches selector") }
            guard matches.count == 1, let app = matches.first else { throw NativeFailure(code: "AMBIGUOUS_APP", message: "Select an exact PID from listApps") }
            let identity = try NativePlatform.identity(app.pid)
            let authorization = try ApplicationAuthorization.describe(identity, name: app.name ?? selector, expectedExecutablePath: app.executablePath)
            let handle = try acquire(identity)
            var response = app.json.object ?? [:]
            response["appHandle"] = .string(handle)
            response["authorization"] = authorization
            return .result(.object(response))
        }
        let handle = try params.string("appHandle")
        if method == "launchApp" {
            guard case .pending(let app, let authorization)? = targets[handle] else {
                throw NativeFailure(code: "STALE_APP", message: "Pending application selection expired; call getApp again")
            }
            guard try ApplicationAuthorization.describeInstalled(app) == authorization else {
                forget(handle)
                throw NativeFailure(code: "STALE_APP", message: "Application executable changed before launch; select it again")
            }
            return .launch(ApplicationLaunch(handle: handle, application: app, authorization: authorization))
        }
        let identity = try validateIdentity(handle)
        if method == "listWindows" {
            let windows = NativePlatform.windows().filter { $0.pid == identity.pid }
            // Remove closed window scopes using the current WindowServer identity set.
            let ids = Set(windows.map(\.windowID))
            snapshots = snapshots.filter { key, _ in key.appHandle != handle || (key.windowID.map { ids.contains($0) } ?? true) }
            observedWindowBounds[handle] = observedWindowBounds[handle]?.filter { ids.contains($0.key) }
            return .result(.array(windows.map(\.json)))
        }
        if method == "getState" {
            let windowID = try params.optionalWindowID()
            snapshots.removeValue(forKey: SnapshotScope(appHandle: handle, windowID: windowID))
            if let windowID { observedWindowBounds[handle]?.removeValue(forKey: windowID) }
            else { observedWindowBounds.removeValue(forKey: handle) }
        }
        if method != "screenshot" { try NativePlatform.requireAccessibility() }
        switch method {
        case "show":
            let windowID = try params.optionalWindowID()
            if let windowID { _ = try NativePlatform.ownedWindow(identity.pid, windowID) }
            let beforePID = NativePlatform.frontPID()
            let beforeWindow = NativePlatform.windows().first { $0.isOnScreen }?.windowID
            let restored = try ax().restoreWindow(windowID, owner: identity)
            _ = try validateIdentity(handle)
            try NativePlatform.requireUnlocked(observeSession())
            let afterPID = NativePlatform.frontPID()
            let afterWindow = NativePlatform.windows().first { $0.isOnScreen }?.windowID
            let changed: JSONValue
            if let beforePID, let afterPID, let beforeWindow, let afterWindow {
                changed = .bool(beforePID != afterPID || beforeWindow != afterWindow)
            } else { changed = .null }
            return .result(.object(["dispatched": .bool(true), "verified": .bool(false),
                "windowId": restored.map { .number(Double($0)) } ?? .null, "foregroundChanged": changed]))
        case "activate":
            return .foreground(ForegroundPlan(appHandle: handle, identity: identity, snapshotID: nil, index: nil, targetWindowID: nil, role: nil, main: nil, minimized: nil))
        case "getState":
            let window = try params.optionalWindowID()
            if let window { _ = try NativePlatform.ownedWindow(identity.pid, window) }
            let projection: AXProjection
            do {
                projection = try ax().project(identity: identity, windowID: window,
                    maxElements: params.integer("maxElements", in: 1...10000), maxDepth: params.integer("maxDepth", in: 1...100),
                    includeMenus: params.optionalBoolean("includeMenus") ?? false, details: params.optionalBoolean("details") ?? false)
            } catch let failure as NativeFailure {
                throw Self.observationFailure(failure)
            }
            _ = try validateIdentity(handle)
            try NativePlatform.requireUnlocked(observeSession())
            try NativePlatform.requireAccessibility()
            if let window { _ = try NativePlatform.ownedWindow(identity.pid, window) }
            try cancellation.check()
            let observedWindows = NativePlatform.windows().filter { $0.pid == identity.pid }
            let id = try identifier("snapshot")
            let scope = SnapshotScope(appHandle: handle, windowID: window)
            snapshots[scope] = NativeSnapshot(id: id, scope: scope, elements: projection.indexed)
            for observed in observedWindows where window == nil || observed.windowID == window {
                observedWindowBounds[handle, default: [:]][observed.windowID] = observed.bounds
            }
            return .result(.object(["appHandle": .string(handle), "pid": .number(Double(identity.pid)),
                "windowId": window.map { .number(Double($0)) } ?? .null,
                "focusedWindowId": projection.focusedWindowID.map { .number(Double($0)) } ?? .null,
                "snapshotId": .string(id), "tree": .string(projection.tree), "elements": .array(projection.elements),
                "windows": .array(observedWindows.map(\.json)), "truncated": .bool(projection.truncated)]))
        case "screenshot":
            trace?.mark("screen-permission.begin")
            try NativePlatform.requireScreenRecording()
            trace?.mark("screen-permission.end")
            trace?.mark("geometry.before.begin")
            let window = try coordinateWindow(identity, params.windowID(), trace: trace)
            trace?.mark("geometry.before.end")
            return .capture(CaptureTarget(appHandle: handle, process: identity, window: window))
        case "paste":
            return .paste(PastePlan(handle: handle, text: try params.string("text"), format: try params.optionalString("format") ?? "text",
                                   maxBytes: try params.integer("maxClipboardBytes", in: 1024...Int.max),
                                   readTimeout: .milliseconds(try params.integer("pasteReadTimeoutMs", in: 1...2147483647)),
                                   maxElements: try params.integer("maxElements", in: 1...10000), maxDepth: try params.integer("maxDepth", in: 1...100)))
        case "typeText", "pressKey":
            let recipient = try ax().keyboardRecipient(identity, catalog: catalog)
            try NativePlatform.verify(recipient)
            if method == "typeText" { try inputs().0.typeText(params.string("text"), to: recipient.pid) }
            else { try inputs().0.pressKey(params.string("key"), modifiers: params.modifiers(), to: recipient.pid) }
        case "setValue": try ax().setValue(element(handle, params), params.string("value"))
        case "selectText":
            try ax().selectText(element(handle, params), text: params.string("text"), prefix: params.optionalString("prefix"),
                                suffix: params.optionalString("suffix"), mode: params.optionalString("selectionType") ?? "text")
        case "performSecondaryAction":
            let selected = try element(handle, params)
            let requested = try params.string("action")
            let action = try Self.resolveAction(requested, names: ax().actions(selected))
            if action == "AXRaise" {
                try ax().requireEnabled(selected)
                return .foreground(ForegroundPlan(appHandle: handle, identity: identity, snapshotID: try params.string("snapshotId"),
                    index: try params.integer("elementIndex", in: 0...Int.max), targetWindowID: try ax().windowID(selected),
                    role: try ax().string(selected, "AXRole"), main: try ax().boolean(selected, "AXMain"), minimized: try ax().boolean(selected, "AXMinimized")))
            }
            try ax().perform(selected, action)
        case "click", "hover":
            let holdMs = params.contains("holdMs") ? try params.integer("holdMs", in: 0...maxClickHoldMs) : nil
            let button = try params.optionalString("mouseButton") ?? "left"
            let count = params.contains("clickCount") ? try params.integer("clickCount", in: 1...2) : 1
            guard button == "left" || (["right", "middle"].contains(button) && count == 1) else { throw RequestParameters.invalid("Unsupported mouse button or click count") }
            let modifiers = try params.modifiers()
            let window: WindowInfo
            let point: WindowPoint
            var hoverElement: AXUIElement?
            if params.contains("elementIndex") {
                guard !params.contains("x"), !params.contains("y"), !params.contains("windowId") else { throw RequestParameters.invalid("Element and coordinate targets cannot be combined") }
                let selected = try element(handle, params)
                hoverElement = selected
                if method == "click" {
                    let names = try ax().actions(selected)
                    let action: String? = holdMs != nil || !modifiers.isEmpty ? nil : button == "right" && names.contains("AXShowMenu") ? "AXShowMenu"
                        : (button == "left" && count == 1 ? (names.contains("AXPress") ? "AXPress" : names.contains("AXPick") ? "AXPick" : nil) : nil)
                    if let action {
                        try ax().perform(selected, action)
                        return .result(Self.actionResult)
                    }
                    try ax().requireEnabled(selected)
                }
                guard let bounds = try ax().bounds(selected), bounds.width > 0, bounds.height > 0 else { throw NativeFailure(code: "NATIVE_ERROR", message: "Element has no pointer bounds") }
                window = try ax().enclosingWindow(selected, owner: identity)
                point = WindowPoint(x: bounds.x + bounds.width / 2 - window.bounds.x, y: bounds.y + bounds.height / 2 - window.bounds.y)
            } else {
                let id = try params.windowID()
                try coordinateSnapshot(handle, params, id)
                window = try observedCoordinateWindow(handle, identity, id)
                point = try params.point()
            }
            let route = WindowRoute(owner: identity, windowID: window.windowID, bounds: window.bounds)
            if method == "hover" {
                try WindowPointerInput.validate(point, in: route)
                if hoverElement == nil {
                    hoverElement = try ax().element(at: CGPoint(x: window.bounds.x + point.x, y: window.bounds.y + point.y), owner: identity)
                    if let hit = hoverElement, try ax().windowID(hit) != window.windowID { hoverElement = nil }
                }
                let hover = hovers[handle] ?? AXHover()
                hovers[handle] = hover
                if try hover.move(to: hoverElement, in: route, access: ax()) {
                    return .result(Self.hoverResult(route: "accessibility", pointerMoved: false))
                }
                return .hover(route, point)
            }
            try await inputs().1.click(in: route, at: point, button: button, count: count, modifiers: modifiers, holdMs: holdMs)
        case "scroll", "drag":
            let id = try params.windowID()
            try coordinateSnapshot(handle, params, id)
            let window = try observedCoordinateWindow(handle, identity, id)
            let route = WindowRoute(owner: identity, windowID: id, bounds: window.bounds)
            if method == "scroll" {
                let dx = params.contains("deltaLinesX") ? try params.integer("deltaLinesX", in: -10...10) : 0
                let dy = params.contains("deltaLinesY") ? try params.integer("deltaLinesY", in: -10...10) : 0
                try inputs().1.scroll(in: route, at: params.point(), deltaLinesX: Int32(dx), deltaLinesY: Int32(dy))
            } else {
                try inputs().1.drag(in: route, from: params.point("fromX", "fromY"), to: params.point("toX", "toY"),
                    durationMs: params.integer("durationMs", in: 1...5000), steps: params.integer("steps", in: 1...240),
                                      button: params.optionalString("mouseButton") ?? "left", modifiers: params.modifiers())
            }
        default: throw NativeFailure(code: "UNSUPPORTED", message: method)
        }
        return .result(Self.actionResult)
    }

    func performPaste(_ plan: PastePlan, beforeDispatch: @MainActor @Sendable () throws -> Void) async throws {
        let identity = try validateIdentity(plan.handle)
        let command = try ax().pasteCommand(identity.pid, maxElements: plan.maxElements, maxDepth: plan.maxDepth)
        try await beforeDispatch()
        try cancellation.check()
        _ = try validateIdentity(plan.handle)
        try NativePlatform.requireUnlocked(observeSession())
        try ax().perform(command, "AXPress")
    }

    private func pendingApplication(_ app: InstalledApplication, handle: String, authorization: JSONValue) -> JSONValue {
        var value: [String: JSONValue] = ["appHandle": .string(handle), "pid": .null, "name": .string(app.name), "authorization": authorization]
        if let bundleID = app.bundleID { value["bundleId"] = .string(bundleID) }
        return .object(value)
    }
    func finishLaunch(_ plan: ApplicationLaunch, pid: Int32) throws -> JSONValue {
        do {
            try cancellation.check()
            guard case .pending(let app, let original)? = targets[plan.handle], app == plan.application, original == plan.authorization,
                  try ApplicationAuthorization.describeInstalled(app) == original else {
                throw NativeFailure(code: "STALE_APP", message: "Application selection changed during launch")
            }
            let identity = try NativePlatform.identity(pid)
            let actual = try ApplicationAuthorization.describe(identity, name: app.name, expectedExecutablePath: app.executablePath)
            if original["persistable"] == .bool(true), actual["id"] != original["id"] {
                throw NativeFailure(code: "STALE_APP", message: "Launched application does not match the approved application identity")
            }
            targets[plan.handle] = .running(identity)
            var value: [String: JSONValue] = ["appHandle": .string(plan.handle), "pid": .number(Double(pid)), "name": .string(app.name)]
            if let bundleID = app.bundleID { value["bundleId"] = .string(bundleID) }
            return .object(value)
        } catch {
            forget(plan.handle)
            throw error
        }
    }

    func foregroundObservation(_ plan: ForegroundPlan) throws -> ForegroundObservation {
        _ = try validateIdentity(plan.appHandle)
        try NativePlatform.requireUnlocked(observeSession())
        let top = NativePlatform.windows().first { $0.isOnScreen }
        return ForegroundObservation(frontPID: NativePlatform.frontPID(), focusedWindowID: try ax().focusedWindowID(plan.identity.pid),
                                     frontWindowID: top?.windowID, frontWindowPID: top?.pid)
    }
    static func shouldRaise(_ plan: ForegroundPlan, before: ForegroundObservation) -> Bool {
        guard let id = plan.targetWindowID else { return true }
        return !(plan.role == "AXWindow" && plan.main == true && plan.minimized == false && before.frontPID == plan.identity.pid
                 && before.focusedWindowID == id && before.frontWindowID == id && before.frontWindowPID == plan.identity.pid)
    }
    func raise(_ plan: ForegroundPlan) throws {
        _ = try validateIdentity(plan.appHandle)
        try NativePlatform.requireUnlocked(observeSession())
        try NativePlatform.requireAccessibility()
        guard let id = plan.snapshotID, let index = plan.index, let element = try snapshot(plan.appHandle, id).elements[index] else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Raise target is no longer available")
        }
        try ax().perform(element, "AXRaise")
    }
    func finishCapture(_ target: CaptureTarget, image: CapturedPNG, trace: ScreenshotTrace? = nil) throws -> JSONValue {
        trace?.mark("postflight.begin")
        try cancellation.check()
        let identity = try validateIdentity(target.appHandle)
        guard identity == target.process else { throw NativeFailure(code: "STALE_APP", message: "Capture process identity changed") }
        try NativePlatform.requireUnlocked(observeSession())
        try NativePlatform.requireScreenRecording()
        trace?.mark("geometry.after.begin")
        let after = try coordinateWindow(identity, target.window.windowID, trace: trace)
        trace?.mark("geometry.after.end")
        guard after.bounds == target.window.bounds else { throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized during capture; observe again") }
        observedWindowBounds[target.appHandle, default: [:]][after.windowID] = after.bounds
        trace?.mark("base64.begin")
        let encoded = image.bytes.base64EncodedString()
        trace?.mark("base64.end")
        trace?.mark("postflight.end")
        return .object(["mimeType": .string("image/png"), "data": .string(encoded),
            "pixelWidth": .number(Double(image.width)), "pixelHeight": .number(Double(image.height)), "bounds": after.bounds.json,
            "coordinateSpace": .string("window-points"), "windowId": .number(Double(after.windowID))])
    }
    static func hoverResult(route: String, pointerMoved: Bool) -> JSONValue {
        .object(["dispatched": .bool(true), "verified": .bool(false), "hoverRoute": .string(route), "systemPointerMoved": .bool(pointerMoved)])
    }
    func shutdown() { closed = true; snapshots.removeAll(); observedWindowBounds.removeAll(); targets.removeAll(); hovers.removeAll(); access = nil; keyboard = nil; pointer = nil }
}
