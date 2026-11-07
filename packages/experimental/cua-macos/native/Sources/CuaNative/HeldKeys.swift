// All connections to the shared helper deliver to the same desktop processes.
import CoreGraphics
import Foundation

/// The lock covers both the held-key records and their corresponding PID-targeted event posts.
/// Shutdown may release a connection's keys outside the ordinary request scheduler.
final class HeldKeys: @unchecked Sendable {
    struct Owner: Equatable {
        let connection: UUID
        let run: String
        let app: String
    }

    private struct Press {
        let owner: Owner
        let recipient: ProcessIdentity
        let code: CGKeyCode
        let flag: CGEventFlags
        let up: CGEvent
    }

    private let lock = NSLock()
    private var pressed: [Press] = []

    func snapshot(pid: Int32) -> [CGKeyCode: CGEventFlags] {
        lock.withLock { Dictionary(uniqueKeysWithValues: pressed.filter { $0.recipient.pid == pid }.map { ($0.code, $0.flag) }) }
    }

    func down(owner: Owner, recipient: ProcessIdentity, code: CGKeyCode, flag: CGEventFlags,
              down: CGEvent, up: CGEvent, post: (CGEvent, Int32) -> Void) throws {
        try lock.withLock {
            guard !pressed.contains(where: { $0.code == code && ($0.owner == owner || $0.recipient.pid == recipient.pid) }) else {
                throw RequestParameters.invalid("Key is already held for this target")
            }
            pressed.append(Press(owner: owner, recipient: recipient, code: code, flag: flag, up: up))
            down.flags = flags(for: recipient)
            post(down, recipient.pid)
        }
    }

    private func flags(for recipient: ProcessIdentity) -> CGEventFlags {
        pressed.reduce(into: CGEventFlags()) { if $1.recipient == recipient { $0.formUnion($1.flag) } }
    }

    /// An up always targets the process selected at down. Never post to a recycled PID.
    private func release(at index: Int, post: (CGEvent, Int32) -> Void) throws -> Bool {
        let key = pressed[index]
        do { try NativePlatform.verify(key.recipient) }
        catch let error as NativeFailure where error.code == "STALE_APP" || error.code == "APP_UNAVAILABLE" {
            pressed.remove(at: index)
            return false
        }
        pressed.remove(at: index)
        key.up.flags = flags(for: key.recipient)
        post(key.up, key.recipient.pid)
        return true
    }

    func up(owner: Owner, code: CGKeyCode, post: (CGEvent, Int32) -> Void) throws -> Bool {
        try lock.withLock {
            guard let index = pressed.firstIndex(where: { $0.owner == owner && $0.code == code }) else {
                throw RequestParameters.invalid("This run has not pressed that key for this application")
            }
            return try release(at: index, post: post)
        }
    }

    func release(connection: UUID, run: String?, post: (CGEvent, Int32) -> Void) throws {
        try lock.withLock {
            defer {
                // A closed connection cannot retry an unverifiable recipient.
                if run == nil { pressed.removeAll { $0.owner.connection == connection } }
            }
            var firstError: Error?
            for index in pressed.indices.reversed() {
                let owner = pressed[index].owner
                guard owner.connection == connection, run == nil || owner.run == run else { continue }
                do { _ = try release(at: index, post: post) }
                catch { firstError = firstError ?? error }
            }
            if let firstError { throw firstError }
        }
    }
}
