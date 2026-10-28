// Socket cleanup remains prompt after peer half-close and while replies face backpressure.
import Foundation
import Darwin
import Testing
@testable import CuaNative

private func sockets() throws -> (SharedSocket, SharedSocket) {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw SharedSocket.failure("Creating fixture sockets") }
    return (SharedSocket(descriptor: descriptors[0]), SharedSocket(descriptor: descriptors[1]))
}

@Test func retainedChannelClosesTheDescriptorAfterPeerEOF() throws {
    let (channel, peer) = try sockets()
    defer { channel.shutdown(); peer.shutdown() }
    #expect(Darwin.shutdown(peer.descriptor, SHUT_WR) == 0)
    var byte = [UInt8](repeating: 0, count: 1)
    let eof = try byte.withUnsafeMutableBytes { try channel.read(into: $0) }
    #expect(eof == 0)
    channel.stopReading()
    channel.shutdown()
    var item = pollfd(fd: peer.descriptor, events: Int16(POLLIN), revents: 0)
    #expect(poll(&item, 1, 1000) == 1)
    let confirmed = try byte.withUnsafeMutableBytes { try peer.read(into: $0) }
    #expect(confirmed == 0)
    #expect(throws: NativeFailure.self) { try channel.write(Data([1]), timeout: 1) }
    withExtendedLifetime(channel) {}
}

@Test(.timeLimit(.minutes(1))) func backpressuredRepliesCannotBlockOtherSocketsOrDescriptorClose() async throws {
    let (slow, unread) = try sockets()
    let (other, reader) = try sockets()
    defer { slow.shutdown(); unread.shutdown(); other.shutdown(); reader.shutdown() }
    var capacity: Int32 = 4096
    #expect(setsockopt(slow.descriptor, SOL_SOCKET, SO_SNDBUF, &capacity, socklen_t(MemoryLayout<Int32>.size)) == 0)
    let writing = Task.detached {
        do {
            try slow.write(Data(repeating: 7, count: 4 * 1024 * 1024), timeout: 1)
            return false
        } catch let failure as NativeFailure { return failure.code == "NATIVE_IO" }
    }
    // Readability proves that the writer entered send, without consuming its pending reply.
    var pending = pollfd(fd: unread.descriptor, events: Int16(POLLIN), revents: 0)
    #expect(poll(&pending, 1, 1000) == 1)
    try other.write(Data([9]), timeout: 1)
    var byte = [UInt8](repeating: 0, count: 1)
    let beforeClose = try byte.withUnsafeMutableBytes { try reader.read(into: $0) }
    #expect(beforeClose == 1)
    #expect(byte == [9])
    #expect(Darwin.shutdown(unread.descriptor, SHUT_WR) == 0)
    slow.shutdown()
    #expect(try await writing.value)
    try other.write(Data([8]), timeout: 1)
    let afterClose = try byte.withUnsafeMutableBytes { try reader.read(into: $0) }
    #expect(afterClose == 1)
    #expect(byte == [8])
}
