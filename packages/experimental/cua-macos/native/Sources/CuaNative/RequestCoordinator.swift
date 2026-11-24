// Each connection retains one request through reply delivery; desktop work uses the shared scheduler.
import Foundation
import AppKit
import Dispatch
import Darwin

/// A client may cancel after the worker publishes a snapshot, even while the success reply is in flight.
struct AXReadDelivery {
    let id: String
    let scope: SnapshotScope
    let control: NativeRequestControl
    var refused = false

    init?(_ request: NativeRequest?, control: NativeRequestControl) {
        guard let request, request.method == "getState", let params = try? RequestParameters(request),
              let app = try? params.string("appHandle") else { return nil }
        id = request.id
        scope = SnapshotScope(appHandle: app, windowID: try? params.optionalWindowID())
        self.control = control
    }

    var scopeToDiscard: SnapshotScope? { refused || control.failure != nil ? scope : nil }
}

@MainActor final class RequestCoordinator {
    private let configuration: HelperConfiguration
    private let cancellation: CancellationLatch
    private let worker: AXWorker
    private let capture: WindowCapture
    private let permissions: SystemPermissions
    private let connectionID: UUID
    private let activity: RecentActivity
    private let inputMonitor: ExternalInputMonitor
    private let clipboard = ClipboardPaste()
    private let input: JSONLInput
    private let writer: JSONLWriter
    private let channel: SharedSocket
    private let scheduler: RequestScheduler
    private let onClose: @MainActor @Sendable () -> Void
    private let onFatal: @Sendable (NativeFailure, Double) -> Void
    private var deadline: NativeDeadline?
    private var active: UUID?
    private var operation: Task<Void, Never>?
    private var stopping = false
    private var requestControl: NativeRequestControl?
    private var lastRead: AXReadDelivery?
    private var activeRequestID: String?
    private var replying = false
    private var nextFrame: Data?
    private var nextCancelled = false

    init(configuration: HelperConfiguration, capture: WindowCapture, channel: SharedSocket,
         cancellation: CancellationLatch, scheduler: RequestScheduler, writer: JSONLWriter, permissions: SystemPermissions, connectionID: UUID,
         activity: RecentActivity, inputMonitor: ExternalInputMonitor,
         onClose: @escaping @MainActor @Sendable () -> Void,
         onFatal: @escaping @Sendable (NativeFailure, Double) -> Void) {
        self.configuration = configuration
        self.capture = capture
        self.permissions = permissions
        self.connectionID = connectionID
        self.activity = activity
        self.inputMonitor = inputMonitor
        if let lookback = configuration.recentActivityWindowMs { activity.connect(connectionID, lookbackMs: lookback) }
        self.cancellation = cancellation
        self.channel = channel
        self.scheduler = scheduler
        self.onClose = onClose
        self.onFatal = onFatal
        worker = AXWorker(cancellation: cancellation, axTimeout: configuration.axTimeoutSeconds,
                          textEventInterval: configuration.textEventIntervalSeconds, maxClickHoldMs: configuration.maxClickHoldMs,
                          heldInputs: scheduler.heldInputs, connectionID: connectionID)
        input = JSONLInput(limit: configuration.maxRequestBytes, cancellation: cancellation, channel: channel)
        self.writer = writer
    }
    func start() {
        let latch = cancellation
        input.start(onFrame: { [weak self] frame in
            DispatchQueue.main.async { self?.receive(frame) }
        }, onEOF: { [weak self] in
            latch.cancel()
            DispatchQueue.main.async { self?.shutdown() }
        }, onFailure: { [weak self] failure in
            latch.cancel()
            DispatchQueue.main.async { self?.transportFailed(failure) }
        })
    }
    private func receive(_ data: Data) {
        guard !stopping else { return }
        if let control = try? JSONDecoder().decode(JSONValue.self, from: data).object,
           Set(control.keys) == ["type", "id"], control["type"] == .string("cancel"), let id = control["id"]?.string {
            if lastRead?.id == id { lastRead?.refused = true }
            if id == activeRequestID { cancelRequest(NativeFailure(code: "NATIVE_CANCELLED", message: "Native operation cancelled")) }
            if let nextFrame, (try? NativeRequest(data: nextFrame).id) == id { nextCancelled = true }
            return
        }
        if active != nil, replying, nextFrame == nil { nextFrame = data; return }
        guard active == nil else { transportFailed(NativeFailure(code: "NATIVE_PROTOCOL", message: "Concurrent helper request admission")); return }
        let token = UUID()
        active = token
        let parsed = try? NativeRequest(data: data)
        activeRequestID = parsed?.id
        let control = NativeRequestControl()
        let discard = lastRead?.scopeToDiscard
        lastRead = AXReadDelivery(parsed, control: control)
        requestControl = control
        let trace: ScreenshotTrace?
        if let parsed, parsed.method == "screenshot" {
            let writer = self.writer
            trace = ScreenshotTrace(requestID: parsed.id, report: { writer.diagnostic($0) })
            trace?.mark("helper.received")
        } else { trace = nil }
        let seconds = parsed?.method == "screenshot"
            ? min(configuration.timeoutSeconds, configuration.screenshotTimeoutSeconds) : configuration.timeoutSeconds
        let grace = configuration.shutdownGraceSeconds
        let axTimeout = Double(configuration.axTimeoutSeconds)
        let onFatal = self.onFatal
        let channel = self.channel
        let requestDeadline = ContinuousClock.now + .seconds(seconds)
        deadline = NativeDeadline(seconds: seconds) {
            trace?.mark("helper.deadline", errorCode: "NATIVE_TIMEOUT")
            control.cancel(NativeFailure(code: "NATIVE_TIMEOUT", message: "Native operation exceeded its deadline"), grace: grace, axTimeout: axTimeout,
                unresponsive: {
                    onFatal(NativeFailure(code: "NATIVE_UNRESPONSIVE", message: "Native operation did not stop after cancellation"), grace)
                }, blockedReply: { channel.shutdown() })
        }
        operation = Task { [weak self] in
            guard let self else { return }
            defer { control.finish() }
            if let discard { await self.worker.discardSnapshot(discard) }
            var requestID: JSONValue = .null
            let response: JSONValue
            do {
                let request = try NativeRequest(data: data)
                requestID = .string(request.id)
                if request.method == "screenshot" { try self.capture.requireAvailable() }
                let result: JSONValue
                if request.method == "takeWindowActivity" || request.method == "clearWindowActivity" {
                    // This query reads in-memory history and must not wait for another client's desktop operation.
                    let params = try RequestParameters(request)
                    if request.method == "takeWindowActivity" {
                        guard let values = params.values["observations"]?.object else { throw RequestParameters.invalid("Missing window observations") }
                        let observations = try values.mapValues { value in
                            guard let time = value.string.flatMap(UInt64.init) else { throw RequestParameters.invalid("Invalid observation time") }
                            return time
                        }
                        result = .array(activity.take(owner: connectionID, handle: try params.string("appHandle"), observations: observations))
                    } else {
                        activity.clear(connectionID)
                        result = .null
                    }
                    if !activity.hasInterests { inputMonitor.stop() }
                } else {
                    result = try await self.scheduler.perform(cancellation: self.cancellation) {
                        control.startOperation()
                        return try await self.execute(request, deadline: requestDeadline, trace: trace)
                    }
                }
                if let failure = control.failure { throw failure }
                response = .object(["id": requestID, "result": result])
            } catch let error as NativeFailure {
                let failure = control.failure ?? error
                trace?.mark("helper.failed", errorCode: failure.code)
                response = .object(["id": requestID, "error": .object(["code": .string(failure.code), "message": .string(failure.message)])])
            } catch {
                let failure = control.failure ?? NativeFailure(code: requestID == .null ? "INVALID_REQUEST" : "NATIVE_ERROR", message: error.localizedDescription)
                trace?.mark("helper.failed", errorCode: failure.code)
                response = .object(["id": requestID, "error": .object([
                    "code": .string(failure.code), "message": .string(failure.message)])])
            }
            if response["error"] != .null { self.lastRead?.refused = true }
            control.finishOperation()
            guard !self.stopping, self.active == token else { return }
            self.replying = true
            do { try await self.writer.write(response, trace: trace) }
            catch let failure as NativeFailure {
                if failure.code == "NATIVE_RESPONSE_LIMIT" {
                    // The bounded writer rejects before emitting any bytes, so one small
                    // error frame can identify the limit before this helper is invalidated.
                    try? await self.writer.write(.object(["id": requestID, "error": .object([
                        "code": .string(failure.code), "message": .string(failure.message),
                    ])]))
                }
                self.transportFailed(failure)
                return
            }
            catch { self.transportFailed(NativeFailure(code: "NATIVE_IO", message: error.localizedDescription)); return }
            guard !self.stopping, self.active == token else { return }
            self.deadline?.cancel()
            self.deadline = nil
            self.active = nil
            self.activeRequestID = nil
            self.requestControl = nil
            self.operation = nil
            self.replying = false
            if let next = self.nextFrame {
                self.nextFrame = nil
                let cancelled = self.nextCancelled
                self.nextCancelled = false
                self.receive(next)
                if cancelled { self.cancelRequest(NativeFailure(code: "NATIVE_CANCELLED", message: "Native operation cancelled")) }
            }
        }
        if let operation { control.attach(operation) }
    }

    private func cancelRequest(_ failure: NativeFailure) {
        let grace = configuration.shutdownGraceSeconds
        let onFatal = self.onFatal
        let channel = self.channel
        requestControl?.cancel(failure, grace: grace, axTimeout: Double(configuration.axTimeoutSeconds), unresponsive: {
            onFatal(NativeFailure(code: "NATIVE_UNRESPONSIVE", message: "Native operation did not stop after cancellation"), grace)
        }, blockedReply: { channel.shutdown() })
    }
    private func execute(_ request: NativeRequest, deadline: ContinuousClock.Instant, trace: ScreenshotTrace?) async throws -> JSONValue {
        let params = try RequestParameters(request)
        try cancellation.check()
        if request.method == "getHeldInputs" {
            return try scheduler.heldInputs.held(connection: connectionID)
        }
        if request.method == "releaseHeldInputs" {
            return .array(try scheduler.heldInputs.release(connection: connectionID))
        }
        if request.method == "screenshot" { try capture.requireAvailable() }
        // A dispatched action can invalidate the snapshot that identifies its window.
        let target = configuration.recentActivityWindowMs != nil && params.contains("appHandle")
            ? await worker.activityTarget(params) : nil
        if let target, request.method == "getState" || request.method == "screenshot" {
            inputMonitor.start()
            defer { if !activity.hasInterests { inputMonitor.stop() } }
            return try await activity.withObservation(target, handle: params.string("appHandle"), owner: connectionID) {
                try await self.dispatch(request, params: params, deadline: deadline, trace: trace)
            }
        }
        let result = try await dispatch(request, params: params, deadline: deadline, trace: trace)
        if let target, result["dispatched"] == .bool(true) {
            activity.record(target, owner: connectionID)
            if activity.hasInterests { inputMonitor.start() }
        }
        return result
    }
    private func dispatch(_ request: NativeRequest, params: RequestParameters, deadline: ContinuousClock.Instant, trace: ScreenshotTrace?) async throws -> JSONValue {
        let requiresCatalog = ["getApp", "launchApp", "listApps", "findApps", "typeText", "pressKey", "sendKeyEvent", "click"].contains(request.method)
        let catalog = requiresCatalog ? ApplicationCatalog.snapshot() : ApplicationCatalogSnapshot(applications: [], frontPID: nil)
        let result: JSONValue
        if request.method == "toggleMouse", try params.string("direction") == "up" {
            let dispatched = try scheduler.heldInputs.pointerUp(owner: .init(connection: connectionID,
                app: params.string("appHandle")), window: params.windowID(), button: WindowPointerInput.button(params.string("mouseButton")))
            return .object(["dispatched": .bool(dispatched)])
        }
        if request.method == "permissionStatus" {
            result = permissions.status()
        } else if request.method == "applicationIcons" {
            var icons: [String: JSONValue] = [:]
            for path in try params.strings("paths") {
                try cancellation.check()
                if let icon = ApplicationCatalog.icon(at: path) { icons[path] = .string(icon) }
            }
            result = .object(icons)
        } else if request.method == "requestPermission" {
            let text = try PermissionGuideText(instruction: params.string("instruction"), backLabel: params.string("backLabel"),
                finderLabel: params.string("finderLabel"), unavailableMessage: params.string("unavailableMessage"),
                settingsMessage: params.string("settingsMessage"))
            result = try permissions.request(params.string("permission"), owner: connectionID, text: text,
                interval: Double(params.integer("pollIntervalMs", in: 100...Int(Int32.max))) / 1000)
        } else if request.method == "openPermissionSettings" {
            result = try permissions.openSettings(params.string("permission"), failureMessage: params.string("settingsMessage"))
        } else if request.method == "findApps" {
            let query = try (params.values["query"] == .null ? "" : params.string("query"))
            result = .array(try ApplicationDiscovery.applications(matching: query, exact: false,
                limit: params.integer("maxAppMatches", in: 1...1000), cancellation: cancellation).map { $0.json(catalog: catalog) })
        } else {
            var installed: InstalledApplication?
            if request.method == "getApp" {
                let selector = try params.string("selector")
                if !catalog.selectableApplications.contains(where: { $0.matches(selector) }) && Int32(selector) == nil {
                    installed = try ApplicationDiscovery.applications(matching: selector, exact: true, limit: 1,
                                                                       cancellation: cancellation).first
                }
            }
            trace?.mark("worker.begin")
            let outcome = try await worker.execute(request.method, deadline: deadline, params: params, catalog: catalog, installed: installed, trace: trace)
            trace?.mark("worker.end")
            switch outcome {
            case .result(let value):
                if request.method == "getApp", var fields = value.object {
                    let path = installed?.path ?? catalog.applications.first { Double($0.pid) == value["pid"].number }?.path
                    if let path, let icon = ApplicationCatalog.icon(at: path) { fields["applicationIcon"] = .string(icon) }
                    result = .object(fields)
                } else { result = value }
            case .capture(let target):
                let image = try await capture.capture(target, cancellation: cancellation, trace: trace)
                result = try await worker.finishCapture(target, image: image, trace: trace)
            case .foreground(let plan): result = try await performForeground(plan, requestID: request.id)
            case .mouseMove(let route, let point):
                let latch = cancellation
                let owner = HeldInputs.Owner(connection: connectionID, app: try params.string("appHandle"))
                try scheduler.systemPointer.move(owner: owner, in: route, at: point, checkCancellation: { try latch.check() })
                result = AXWorker.mouseMoveResult(route: "system-pointer", pointerMoved: true)
            case .systemButtonDown(let route, let button):
                try scheduler.systemPointer.down(owner: .init(connection: connectionID, app: params.string("appHandle")), in: route, button: button,
                                                 checkCancellation: { try cancellation.check() })
                result = AXWorker.actionResult
            case .paste(let plan):
                try await clipboard.perform(text: plan.text, format: plan.format, maxBytes: plan.maxBytes, readTimeout: plan.readTimeout,
                    checkCancellation: { try cancellation.check() }) { requireClipboard in
                    try await worker.performPaste(plan, beforeDispatch: requireClipboard)
                }
                result = AXWorker.actionResult
            case .launch(let plan):
                if plan.source != nil {
                    try ApplicationAuthorization.requireLaunchSelection(plan.authorization, application: plan.application)
                }
                let pid = try await ApplicationDiscovery.launch(plan.application, newInstance: plan.source != nil, cancellation: cancellation)
                result = try await worker.finishLaunch(plan, pid: pid, catalog: ApplicationCatalog.snapshot())
            }
        }
        return result
    }
    private func performForeground(_ plan: ForegroundPlan, requestID: String) async throws -> JSONValue {
        let before = try await worker.foregroundObservation(plan)
        var activationRequested = false
        if before.frontPID != plan.identity.pid {
            try cancellation.check()
            try ApplicationCatalog.activate(plan.identity)
            activationRequested = true
        }
        let after = try await worker.foregroundObservation(plan)
        let changed = ForegroundObservation.change(beforePID: before.frontPID, beforeWindow: before.frontWindowID,
                                                   afterPID: after.frontPID, afterWindow: after.frontWindowID)
        return .object(["dispatched": .bool(true), "foregroundChanged": changed, "foreground": .object([
            "requestId": .string(requestID), "targetPid": .number(Double(plan.identity.pid)),
            "before": before.json, "after": after.json, "activationRequested": .bool(activationRequested),
        ])])
    }
    private func transportFailed(_ failure: NativeFailure) {
        if let bytes = "\(failure.code): \(failure.message)\n".data(using: .utf8) { try? FileHandle.standardError.write(contentsOf: bytes) }
        shutdown()
    }
    func close() { shutdown() }

    private func shutdown() {
        guard !stopping else { return }
        stopping = true
        permissions.closeGuide(owner: connectionID)
        cancellation.cancel()
        deadline?.cancel()
        deadline = nil
        cancelRequest(NativeFailure(code: "NATIVE_CANCELLED", message: "Native client disconnected"))
        input.stop()
        do { try clipboard.cancel() }
        catch { fputs("Clipboard restoration failed during shutdown: \(error.localizedDescription)\n", stderr) }
        active = nil
        let pending = operation
        operation = nil
        pending?.cancel()
        Task { [self] in
            await pending?.value
            deadline?.cancel()
            deadline = nil
            do { try scheduler.heldInputs.release(connection: connectionID) }
            catch { fputs("Could not confirm input release on disconnect: \(error)\n", stderr) }
            await worker.shutdown()
            onClose()
        }
    }
}
