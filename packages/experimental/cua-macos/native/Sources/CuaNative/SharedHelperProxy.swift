// Stdio diagnostic clients use the same daemon and never create a second capture backend.
import Foundation
import CryptoKit
import Darwin

@MainActor enum SharedHelperProxy {
    static func run(configuration: HelperConfiguration) async throws {
        guard let executable = NativePlatform.executablePath(getpid()) else { throw SharedSocket.failure("Resolving helper executable") }
        let digest = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: executable), options: .mappedIfSafe))
            .map { String(format: "%02x", $0) }.joined()
        let options = try SharedHelperOptions(arguments: ["--ensure-shared", "--runtime-key", digest,
            "--runtime-directory", "/tmp/dsh-cua-\(getuid())", "--startup-timeout-ms", String(configuration.timeoutSeconds * 1000)])
        let channel = try await connect(options)
        defer { channel.shutdown() }
        let hello = JSONValue.object(["type": .string("hello"), "protocol": .number(1), "runtimeKey": .string(digest), "config": .object([
            "maxRequestBytes": .number(Double(configuration.maxRequestBytes)), "maxResponseBytes": .number(Double(configuration.maxResponseBytes)),
            "axTimeoutMs": .number(Double(configuration.axTimeoutSeconds) * 1000), "textEventIntervalMs": .number(configuration.textEventIntervalSeconds * 1000),
            "maxClickHoldMs": .number(Double(configuration.maxClickHoldMs)),
            "screenshotTimeoutMs": .number(configuration.screenshotTimeoutSeconds * 1000), "timeoutMs": .number(configuration.timeoutSeconds * 1000),
            "graceMs": .number(configuration.shutdownGraceSeconds * 1000),
        ])])
        try channel.write(JSONEncoder().encode(hello) + Data([10]), timeout: configuration.timeoutSeconds)
        let frames = Frames(channel: channel, limit: configuration.maxResponseBytes)
        guard let handshake = try frames.next(timeout: configuration.timeoutSeconds),
              try JSONDecoder().decode(JSONValue.self, from: handshake)["type"] == .string("ready") else {
            throw NativeFailure(code: "NATIVE_PROTOCOL", message: "Shared helper rejected stdio client hello")
        }
        var buffer = Data()
        while true {
            if let newline = buffer.firstIndex(of: 10) {
                let frame = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                try exchange(frame, channel: channel, frames: frames, configuration: configuration)
                continue
            }
            guard buffer.count <= configuration.maxRequestBytes else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
            var bytes = [UInt8](repeating: 0, count: min(65536, configuration.maxRequestBytes + 1 - buffer.count))
            let count = bytes.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw SharedSocket.failure("Reading helper stdin") }
            if count == 0 { break }
            buffer.append(contentsOf: bytes.prefix(count))
        }
        if !buffer.isEmpty { try exchange(buffer, channel: channel, frames: frames, configuration: configuration) }
        Darwin.shutdown(channel.descriptor, SHUT_WR)
        while let frame = try frames.next(timeout: configuration.shutdownGraceSeconds) {
            guard try diagnostic(frame) else { throw NativeFailure(code: "NATIVE_PROTOCOL", message: "Unexpected response during stdio cleanup") }
        }
    }

    private static func exchange(_ data: Data, channel: SharedSocket, frames: Frames, configuration: HelperConfiguration) throws {
        guard data.count + 1 <= configuration.maxRequestBytes else { throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Request exceeded helper byte limit") }
        try channel.write(data + Data([10]), timeout: configuration.timeoutSeconds)
        while let frame = try frames.next(timeout: configuration.timeoutSeconds) {
            if try diagnostic(frame) { continue }
            try FileHandle.standardOutput.write(contentsOf: frame + Data([10]))
            return
        }
        throw NativeFailure(code: "NATIVE_EOF", message: "Shared helper closed before its operation reply")
    }

    private static func diagnostic(_ data: Data) throws -> Bool {
        guard var fields = try JSONDecoder().decode(JSONValue.self, from: data).object, fields["type"] == .string("diagnostic") else { return false }
        fields.removeValue(forKey: "type")
        let value = try JSONEncoder().encode(JSONValue.object(fields))
        try FileHandle.standardError.write(contentsOf: Data("[cua-screenshot] ".utf8) + value + Data([10]))
        return true
    }

    private static func connect(_ options: SharedHelperOptions) async throws -> SharedSocket {
        let deadline = options.startupDeadline()
        repeat {
            try await SharedHelperLauncher.ensure(options, publishReady: false, deadline: deadline)
            let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
            guard descriptor >= 0 else { throw SharedSocket.failure("Creating stdio client socket") }
            let channel = SharedSocket(descriptor: descriptor)
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(options.socketPath.utf8) + [0]) }
            let connected = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            if connected == 0 { return channel }
            let error = errno
            guard error == ENOENT || error == ECONNREFUSED else { throw SharedSocket.failure("Connecting stdio client") }
            usleep(10_000)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Shared helper did not accept the stdio client")
    }

    private final class Frames {
        private let channel: SharedSocket
        private let limit: Int
        private var buffer = Data()
        init(channel: SharedSocket, limit: Int) { self.channel = channel; self.limit = limit }
        func next(timeout: Double) throws -> Data? {
            let started = DispatchTime.now().uptimeNanoseconds
            while true {
                if let newline = buffer.firstIndex(of: 10) {
                    let frame = Data(buffer[..<newline])
                    buffer.removeSubrange(...newline)
                    guard frame.count + 1 <= limit else { throw NativeFailure(code: "NATIVE_RESPONSE_LIMIT", message: "Shared helper reply exceeded its byte limit") }
                    return frame
                }
                let remaining = timeout - Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
                guard remaining > 0 else { throw NativeFailure(code: "NATIVE_TIMEOUT", message: "Shared helper response timed out") }
                var item = pollfd(fd: channel.descriptor, events: Int16(POLLIN), revents: 0)
                let ready = poll(&item, 1, Int32(min(remaining * 1000, Double(Int32.max)).rounded(.up)))
                if ready < 0 && errno == EINTR { continue }
                guard ready > 0 else { throw NativeFailure(code: "NATIVE_TIMEOUT", message: "Shared helper response timed out") }
                guard buffer.count <= limit else { throw NativeFailure(code: "NATIVE_RESPONSE_LIMIT", message: "Shared helper reply exceeded its byte limit") }
                var bytes = [UInt8](repeating: 0, count: min(65536, limit + 1 - buffer.count))
                let count = bytes.withUnsafeMutableBytes { Darwin.read(channel.descriptor, $0.baseAddress, $0.count) }
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw SharedSocket.failure("Reading shared helper reply") }
                if count == 0 {
                    guard buffer.isEmpty else { throw NativeFailure(code: "NATIVE_PROTOCOL", message: "Shared helper ended inside a reply") }
                    return nil
                }
                buffer.append(contentsOf: bytes.prefix(count))
            }
        }
    }
}
