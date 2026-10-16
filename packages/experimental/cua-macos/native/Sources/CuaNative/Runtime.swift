// Bounded line I/O and cooperative termination independent of the AX executor.
import Foundation
import Dispatch
import Darwin

final class CancellationLatch: @unchecked Sendable {
    // The synchronous AX/input loops cannot await a cancellation message on their own actor.
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }
    func check() throws {
        if Task.isCancelled || lock.withLock({ cancelled }) { throw NativeFailure(code: "NATIVE_CANCELLED", message: "Helper operation cancelled") }
    }
    var isCancelled: Bool { lock.withLock { cancelled } }
}

struct HelperConfiguration: Sendable {
    var maxRequestBytes = 1024 * 1024
    var maxResponseBytes = 32 * 1024 * 1024
    var axTimeoutSeconds: Float = 30
    var shutdownGraceSeconds: Double = 3
    var textEventIntervalSeconds: Double = 0.00025
    var timeoutSeconds: Double = 30
    var screenshotTimeoutSeconds: Double = 5
    init(arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            guard index + 1 < arguments.count else { throw RequestParameters.invalid("Missing value for \(arguments[index])") }
            let key = arguments[index]
            let text = arguments[index + 1]
            switch key {
            case "--max-request-bytes", "--max-response-bytes":
                guard let value = Int(text), value >= 1024, value < Int.max else { throw RequestParameters.invalid("\(key) must be a positive byte limit") }
                if key == "--max-request-bytes" { maxRequestBytes = value } else { maxResponseBytes = value }
            case "--ax-timeout-ms":
                guard let value = Float(text), value.isFinite, value > 0 else { throw RequestParameters.invalid("AX timeout must be positive") }
                axTimeoutSeconds = value / 1000
            case "--text-event-interval-ms":
                guard let value = Double(text), value.isFinite, (0...1000).contains(value) else {
                    throw RequestParameters.invalid("Text event interval must be between 0 and 1000 milliseconds")
                }
                textEventIntervalSeconds = value / 1000
            case "--shutdown-grace-ms":
                guard let value = Double(text), value.isFinite, value > 0 else { throw RequestParameters.invalid("Shutdown grace must be positive") }
                shutdownGraceSeconds = value / 1000
            case "--timeout-ms", "--screenshot-timeout-ms":
                guard let value = Double(text), value.isFinite, value > 0 else { throw RequestParameters.invalid("Operation timeout must be positive") }
                if key == "--timeout-ms" { timeoutSeconds = value / 1000 }
                else { screenshotTimeoutSeconds = value / 1000 }
            default: throw RequestParameters.invalid("Unknown helper option \(key)")
            }
            index += 2
        }
    }

    init(hello: Data, runtimeKey: String) throws {
        let decoded = try JSONDecoder().decode(JSONValue.self, from: hello)
        guard let fields = decoded.object, Set(fields.keys) == ["type", "protocol", "runtimeKey", "config"],
              fields["type"] == .string("hello"), fields["protocol"] == .number(1),
              fields["runtimeKey"] == .string(runtimeKey), let config = fields["config"]?.object,
              Set(config.keys) == ["maxRequestBytes", "maxResponseBytes", "axTimeoutMs", "textEventIntervalMs", "screenshotTimeoutMs", "timeoutMs", "graceMs"] else {
            throw NativeFailure(code: "NATIVE_PROTOCOL", message: "Expected shared helper protocol 1 hello for this runtime")
        }
        func number(_ name: String) throws -> String {
            guard let number = config[name]?.number, number.isFinite else { throw RequestParameters.invalid("\(name) must be finite") }
            if ["maxRequestBytes", "maxResponseBytes"].contains(name) {
                guard let integer = Int(exactly: number) else { throw RequestParameters.invalid("\(name) must be an integer") }
                return String(integer)
            }
            return String(number)
        }
        try self.init(arguments: [
            "--max-request-bytes", number("maxRequestBytes"), "--max-response-bytes", number("maxResponseBytes"),
            "--ax-timeout-ms", number("axTimeoutMs"), "--text-event-interval-ms", number("textEventIntervalMs"),
            "--screenshot-timeout-ms", number("screenshotTimeoutMs"), "--timeout-ms", number("timeoutMs"),
            "--shutdown-grace-ms", number("graceMs"),
        ])
    }
}

final class JSONLInput: Sendable {
    // Buffer and reads belong exclusively to queue; stop state uses the shared latch.
    private let queue = DispatchQueue(label: "dsh.cua.socket-input")
    private let cancellation: CancellationLatch
    private let limit: Int
    private let channel: SharedSocket
    init(limit: Int, cancellation: CancellationLatch, channel: SharedSocket) {
        self.limit = limit; self.cancellation = cancellation; self.channel = channel
    }
    func start(onFrame: @escaping @Sendable (Data) -> Void, onEOF: @escaping @Sendable () -> Void,
               onFailure: @escaping @Sendable (NativeFailure) -> Void) {
        queue.async {
            var buffer = Data()
            do {
                while !self.cancellation.isCancelled {
                    if let newline = buffer.firstIndex(of: 10) {
                        let frame = Data(buffer[..<newline])
                        buffer.removeSubrange(...newline)
                        guard frame.count + 1 <= self.limit else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
                        onFrame(frame)
                        continue
                    }
                    guard buffer.count <= self.limit else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
                    // POSIX read returns available socket bytes without waiting for full capacity.
                    var chunk = [UInt8](repeating: 0, count: min(65536, self.limit + 1 - buffer.count))
                    let count = try chunk.withUnsafeMutableBytes { try self.channel.read(into: $0) }
                    if count == 0 {
                        if !buffer.isEmpty { onFrame(buffer) }
                        onEOF()
                        return
                    }
                    buffer.append(contentsOf: chunk.prefix(count))
                }
            } catch let error as NativeFailure { onFailure(error) }
            catch { onFailure(NativeFailure(code: "NATIVE_IO", message: "Reading helper socket failed: \(error.localizedDescription)")) }
        }
    }
    func stop() { channel.stopReading() }
}

final class JSONLWriter: Sendable {
    private let queue = DispatchQueue(label: "dsh.cua.socket-output")
    let limit: Int
    private let channel: SharedSocket
    private let writeTimeout: Double
    init(limit: Int, channel: SharedSocket, writeTimeout: Double) {
        self.limit = limit; self.channel = channel; self.writeTimeout = writeTimeout
    }

    func diagnostic(_ value: JSONValue) {
        queue.async { [self] in
            // The operation reply owns transport failures; diagnostics remain best effort.
            try? send(value)
        }
    }

    private func send(_ value: JSONValue) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var frame = try encoder.encode(value)
        frame.append(10)
        guard frame.count <= limit else { throw NativeFailure(code: "NATIVE_RESPONSE_LIMIT", message: "Reply exceeded helper byte limit") }
        try channel.write(frame, timeout: writeTimeout)
    }
    func write(_ response: JSONValue, trace: ScreenshotTrace? = nil) async throws {
        let limit = self.limit
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    func mark(_ stage: String) {
                        guard let trace else { return }
                        try? self.send(trace.diagnosticValue(stage))
                    }
                    mark("response.encode.begin")
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                    var frame = try encoder.encode(response)
                    frame.append(10)
                    guard frame.count <= limit else { throw NativeFailure(code: "NATIVE_RESPONSE_LIMIT", message: "Reply exceeded helper byte limit") }
                    mark("response.encode.end")
                    mark("response.write.begin")
                    try self.channel.write(frame, timeout: self.writeTimeout)
                    mark("response.write.end")
                    continuation.resume()
                } catch let error as NativeFailure { continuation.resume(throwing: error) }
                catch { continuation.resume(throwing: NativeFailure(code: "NATIVE_IO", message: "Encoding or writing helper reply failed")) }
            }
        }
    }
}
