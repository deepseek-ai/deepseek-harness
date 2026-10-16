// One daemon owns ScreenCaptureKit; each socket owns its AX identities and cancellation.
import Foundation
import AppKit
import Dispatch
import Darwin

final class SharedHelperLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var clients: [UUID: (SharedSocket, CancellationLatch, Double)] = [:]
    private var stopping = false
    private var status: Int32 = 0
    private let startupTimeout: Double

    init(startupTimeout: Double) { self.startupTimeout = startupTimeout }

    func add(_ id: UUID, channel: SharedSocket, cancellation: CancellationLatch) -> Bool {
        lock.withLock {
            guard !stopping else { return false }
            clients[id] = (channel, cancellation, startupTimeout)
            return true
        }
    }
    func remove(_ id: UUID) { _ = lock.withLock { clients.removeValue(forKey: id) } }
    func configure(_ id: UUID, grace: Double) {
        lock.withLock {
            guard let client = clients[id] else { return }
            clients[id] = (client.0, client.1, grace)
        }
    }
    var shutdownGrace: Double { lock.withLock { clients.values.map { $0.2 }.max() ?? startupTimeout } }
    func exitStatusIfEmpty() -> Int32? {
        lock.withLock {
            guard clients.isEmpty else { return nil }
            stopping = true
            return status
        }
    }
    var isStopping: Bool { lock.withLock { stopping } }
    func abort(grace: Double, status: Int32 = 1) {
        let owned: [(SharedSocket, CancellationLatch, Double)]? = lock.withLock {
            guard !stopping else { return nil }
            stopping = true
            self.status = status
            return Array(clients.values)
        }
        guard let owned else { return }
        for (channel, cancellation, _) in owned { cancellation.cancel(); channel.shutdown() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + grace) { _exit(status) }
    }
}

final class NativeSignals {
    private let queue = DispatchQueue(label: "dsh.cua.signals")
    private var sources: [DispatchSourceSignal] = []

    init(onSignal: @escaping @Sendable (Int32) -> Void) {
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            // Construction outside MainActor prevents Swift 6 from isolating the dispatch closure.
            source.setEventHandler(handler: { @Sendable in onSignal(number) })
            source.resume()
            sources.append(source)
        }
    }
    deinit { sources.forEach { $0.cancel() } }
}

@MainActor final class SharedHelperServer {
    private let options: SharedHelperOptions
    private let versionLock: SharedHelperLock
    private let executableLock: SharedHelperLock
    private let listener: SharedSocket
    private let lifetime: SharedHelperLifetime
    private let scheduler = RequestScheduler()
    private let capture = WindowCapture()
    private let instanceID = UUID().uuidString
    private var connections: [UUID: RequestCoordinator] = [:]
    private var startupDeadline: NativeDeadline?
    private var signals: NativeSignals?

    init?(options: SharedHelperOptions) throws {
        self.options = options
        lifetime = SharedHelperLifetime(startupTimeout: options.startupTimeout)
        try options.prepareDirectory()
        guard let versionLock = try SharedHelperLock(path: options.versionLockPath) else {
            try FileHandle.standardOutput.write(contentsOf: options.existingReady())
            return nil
        }
        self.versionLock = versionLock
        guard let executableLock = try SharedHelperLock(path: options.executableLockPath()) else {
            throw NativeFailure(code: "NATIVE_RUNTIME_CONFLICT", message: "Another helper version is using this executable path; close its clients before switching versions")
        }
        self.executableLock = executableLock
        if unlink(options.readyPath) != 0 && errno != ENOENT { throw SharedSocket.failure("Removing stale helper readiness record") }
        listener = try SharedSocket.listen(path: options.socketPath)
    }

    func start() throws {
        let lifetime = self.lifetime
        signals = NativeSignals { [weak self] number in
            lifetime.abort(grace: lifetime.shutdownGrace, status: 128 + number)
            Task { @MainActor in self?.closeConnections(); self?.exitIfEmpty() }
        }
        startupDeadline = NativeDeadline(seconds: options.startupTimeout) { [weak self] in
            Task { @MainActor in self?.exitIfEmpty() }
        }
        let ready = options.ready(pid: getpid(), instanceID: instanceID)
        let data = try JSONEncoder().encode(ready)
        try data.write(to: URL(fileURLWithPath: options.readyPath), options: .atomic)
        guard chmod(options.readyPath, 0o600) == 0 else { throw SharedSocket.failure("Protecting helper readiness record") }
        try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
        try FileHandle.standardOutput.close()
        let listener = self.listener
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while !lifetime.isStopping {
                let descriptor = accept(listener.descriptor, nil, nil)
                if descriptor < 0 && errno == EINTR { continue }
                guard descriptor >= 0 else {
                    if !lifetime.isStopping { lifetime.abort(grace: lifetime.shutdownGrace) }
                    return
                }
                let channel = SharedSocket(descriptor: descriptor)
                var uid: uid_t = 0
                var gid: gid_t = 0
                guard getpeereid(descriptor, &uid, &gid) == 0, uid == getuid() else { channel.shutdown(); continue }
                let id = UUID()
                let cancellation = CancellationLatch()
                guard lifetime.add(id, channel: channel, cancellation: cancellation) else { channel.shutdown(); return }
                Task { @MainActor in self?.admit(id, channel: channel, cancellation: cancellation) }
            }
        }
    }

    private func admit(_ id: UUID, channel: SharedSocket, cancellation: CancellationLatch) {
        let options = self.options
        DispatchQueue.global(qos: .utility).async { [weak self] in
            do {
                let configuration = try HelperConfiguration(hello: channel.readHello(timeout: options.startupTimeout), runtimeKey: options.runtimeKey)
                Task { @MainActor in await self?.connected(id, channel: channel, cancellation: cancellation, configuration: configuration) }
            } catch {
                let failure = error as? NativeFailure ?? NativeFailure(code: "NATIVE_PROTOCOL", message: "Invalid shared helper hello")
                let response = JSONValue.object(["type": .string("error"), "code": .string(failure.code), "message": .string(failure.message)])
                if let data = try? JSONEncoder().encode(response) { try? channel.write(data + Data([10]), timeout: options.startupTimeout) }
                channel.shutdown()
                Task { @MainActor in self?.disconnected(id) }
            }
        }
    }

    private func connected(_ id: UUID, channel: SharedSocket, cancellation: CancellationLatch, configuration: HelperConfiguration) async {
        guard !lifetime.isStopping else { channel.shutdown(); disconnected(id); return }
        lifetime.configure(id, grace: configuration.shutdownGraceSeconds)
        let writer = JSONLWriter(limit: configuration.maxResponseBytes, channel: channel, writeTimeout: configuration.shutdownGraceSeconds)
        do { try await writer.write(options.ready(pid: getpid(), instanceID: instanceID)) }
        catch { channel.shutdown(); disconnected(id); return }
        let lifetime = self.lifetime
        let coordinator = RequestCoordinator(configuration: configuration, capture: capture, channel: channel, cancellation: cancellation,
            scheduler: scheduler, writer: writer, onClose: { [weak self] in
                channel.shutdown()
                self?.disconnected(id)
            }, onFatal: { [weak self] _, grace in
                lifetime.abort(grace: grace)
                Task { @MainActor in self?.closeConnections() }
            })
        connections[id] = coordinator
        startupDeadline?.cancel()
        coordinator.start()
    }

    private func disconnected(_ id: UUID) {
        connections.removeValue(forKey: id)
        lifetime.remove(id)
        exitIfEmpty()
    }

    private func closeConnections() { for coordinator in connections.values { coordinator.close() } }

    private func exitIfEmpty() {
        guard let status = lifetime.exitStatusIfEmpty() else { return }
        listener.shutdown()
        unlink(options.socketPath)
        unlink(options.readyPath)
        // The lock descriptors stay open until process exit, including AX/input cleanup.
        withExtendedLifetime((versionLock, executableLock)) { exit(status) }
    }
}
