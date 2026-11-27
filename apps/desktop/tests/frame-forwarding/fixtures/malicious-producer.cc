/** Test-only hostile peer. Uses the receiver transport, deliberately bypassing the producer API's validation. */
#include "transport.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <mach/notify.h>
#include <servers/bootstrap.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
using namespace dsh_frame_forwarding;

static void number(CFMutableDictionaryRef props, CFStringRef key, int value) {
  auto item = CFNumberCreate(nullptr, kCFNumberIntType, &value);
  CFDictionarySetValue(props, key, item); CFRelease(item);
}
static IOSurfaceRef surface(const std::string& mode) {
  auto props = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  number(props, kIOSurfaceWidth, 64); number(props, kIOSurfaceHeight, 64);
  number(props, kIOSurfaceBytesPerElement, 4);
  number(props, kIOSurfacePixelFormat, mode == "format" ? 'RGBA' : mode == "planes" ? '420v' : 'BGRA');
  if (mode == "planes") {
    auto planes = CFArrayCreateMutable(nullptr, 0, &kCFTypeArrayCallBacks);
    for (int i = 0; i < 2; ++i) {
      auto plane = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      number(plane, kIOSurfacePlaneWidth, i ? 32 : 64); number(plane, kIOSurfacePlaneHeight, i ? 32 : 64);
      number(plane, kIOSurfacePlaneBytesPerElement, i ? 2 : 1);
      number(plane, kIOSurfacePlaneBytesPerRow, 64); number(plane, kIOSurfacePlaneOffset, i ? 4096 : 0);
      number(plane, kIOSurfacePlaneSize, i ? 2048 : 4096);
      CFArrayAppendValue(planes, plane); CFRelease(plane);
    }
    CFDictionarySetValue(props, kIOSurfacePlaneInfo, planes); CFRelease(planes);
  }
  auto result = IOSurfaceCreate(props); CFRelease(props);
  if (!result) throw std::runtime_error("IOSurfaceCreate failed");
  return result;
}
static void send(Channel& channel, Packet packet, IOSurfaceRef resource = nullptr) {
  if (!channel.send(packet, reinterpret_cast<uintptr_t>(resource))) throw std::runtime_error("packet send failed");
}
static Packet receive(Channel& channel) {
  Received result{};
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (std::chrono::steady_clock::now() < deadline) {
    const int status = channel.receive(result, 100);
    if (status == 1) return result.packet;
    if (status < 0) throw std::runtime_error("peer closed");
  }
  throw std::runtime_error("peer did not answer");
}
static uint64_t generation = 0;
static void control(Channel& channel, const Packet& packet) {
  const std::string text(packet.text);
  if (text.find("\"type\":\"viewport\"") == std::string::npos) return;
  auto version = text.find("\"version\":");
  auto id = text.find("\"requestId\":\"");
  if (version == std::string::npos || id == std::string::npos) throw std::runtime_error("invalid viewport");
  generation = std::strtoull(text.c_str() + version + 10, nullptr, 10);
  id += 13; auto end = text.find('"', id);
  Packet response; response.kind = message;
  std::snprintf(response.text, sizeof(response.text), "{\"type\":\"viewport-applied\",\"version\":%llu,\"requestId\":\"%s\"}",
    static_cast<unsigned long long>(generation), text.substr(id, end - id).c_str());
  send(channel, response);
}
/** A receiver connection reached over raw Mach, keeping the port and identifier the transport channel hides. */
struct RawChannel {
  mach_port_t local = MACH_PORT_NULL, remote = MACH_PORT_NULL;
  uint64_t connection = 0;
};
/** One message in the receiver's layout, followed by room for the trailer the kernel appends after it. */
struct RawMessage {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  WireHeader wire;
  char text[DSH_FRAME_FORWARDING_TEXT_CAPACITY];
  mach_msg_audit_trailer_t trailer;
};
static mach_port_t receive_port() {
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS)
    throw std::runtime_error("cannot allocate a Mach port");
  return port;
}
/** Lay `packet` out exactly as the receiver decodes it, stamped with `token`. */
static void compose(RawMessage& message, const Packet& packet, const char* token) {
  std::memset(&message, 0, sizeof(message));
  message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  message.body.msgh_descriptor_count = 1;
  message.port.type = MACH_MSG_PORT_DESCRIPTOR;
  message.port.disposition = MACH_MSG_TYPE_COPY_SEND;
  message.wire.marker = magic; message.wire.version = DSH_FRAME_FORWARDING_PROTOCOL_VERSION; message.wire.kind = packet.kind;
  message.wire.max_frames = packet.max_frames;
  message.wire.text_size = static_cast<uint32_t>(std::strlen(packet.text));
  std::snprintf(message.wire.token, sizeof(message.wire.token), "%s", token);
  std::memcpy(message.text, packet.text, message.wire.text_size);
  message.header.msgh_size = static_cast<mach_msg_size_t>(offsetof(RawMessage, text) + ((message.wire.text_size + 3u) & ~3u));
}
static void send_raw(mach_port_t destination, RawMessage& message) {
  message.header.msgh_remote_port = destination;
  const auto result = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, message.header.msgh_size, 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
  if (result != KERN_SUCCESS) throw std::runtime_error("raw Mach message send failed");
}
/** Receive one raw message; false when none arrives within `timeout` milliseconds. */
static bool receive_raw(mach_port_t port, uint32_t timeout, RawMessage& received) {
  std::memset(&received, 0, sizeof(received));
  const auto result = mach_msg(&received.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(received), port, timeout, MACH_PORT_NULL);
  if (result == MACH_RCV_TIMED_OUT) return false;
  if (result != KERN_SUCCESS) throw std::runtime_error("raw Mach message receive failed");
  return true;
}
/** The kind of a received message, or zero for anything that is not a protocol packet. */
static uint32_t packet_kind(const RawMessage& received) {
  if (received.header.msgh_size < offsetof(RawMessage, wire) + sizeof(WireHeader)) return 0;
  if (received.wire.marker != magic || received.wire.version != DSH_FRAME_FORWARDING_PROTOCOL_VERSION) return 0;
  return received.wire.kind;
}
/** Connect straight over Mach, so the hostile message can name the receiver's own connection port. */
static RawChannel connect_raw(const Endpoint& endpoint) {
  RawChannel channel;
  channel.local = receive_port();
  mach_port_t listener = MACH_PORT_NULL;
  if (bootstrap_look_up(bootstrap_port, endpoint.name.c_str(), &listener) != KERN_SUCCESS) throw std::runtime_error("listener lookup failed");
  Packet greeting; greeting.kind = hello; greeting.max_frames = hello_capabilities;
  RawMessage outbound;
  compose(outbound, greeting, endpoint.token.c_str());
  outbound.port.name = channel.local;
  send_raw(listener, outbound);
  mach_port_deallocate(mach_task_self(), listener);
  RawMessage response;
  if (!receive_raw(channel.local, 10000, response)) throw std::runtime_error("receiver did not answer the handshake");
  if (packet_kind(response) != ready || !response.port.name) throw std::runtime_error("handshake refused");
  channel.connection = parse_connection(response.wire.token);
  if (!channel.connection) throw std::runtime_error("handshake returned no connection identifier");
  // The descriptor is the receiver's connection port; this producer keeps the send right it received.
  channel.remote = response.port.name;
  return channel;
}
/** Wait for the send right of `port` to become a dead name, which the destroyed receive right leaves behind. */
static bool dead_name_within(mach_port_t port, uint32_t timeout) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
  for (;;) {
    mach_port_type_t type = 0;
    if (mach_port_type(mach_task_self(), port, &type) == KERN_SUCCESS && (type & MACH_PORT_TYPE_DEAD_NAME)) return true;
    if (std::chrono::steady_clock::now() >= deadline) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}
/** Wait for the send-once notice the kernel posts when the receiver destroys the reply right it was handed. */
static bool send_once_within(mach_port_t port, uint32_t timeout) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
  while (std::chrono::steady_clock::now() < deadline) {
    RawMessage received;
    if (!receive_raw(port, 50, received)) continue;
    const bool notice = received.header.msgh_id == MACH_NOTIFY_SEND_ONCE;
    mach_msg_destroy(&received.header);
    if (notice) return true;
  }
  return false;
}
/** Wait for the receiver's answer to the normal message sent behind the hostile one. */
static bool answer_within(mach_port_t port, uint32_t timeout) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
  while (std::chrono::steady_clock::now() < deadline) {
    RawMessage received;
    if (!receive_raw(port, 50, received)) continue;
    const bool answer = packet_kind(received) == dsh_frame_forwarding::message && std::strcmp(received.text, "go") == 0;
    mach_msg_destroy(&received.header);
    if (answer) return true;
  }
  return false;
}
/** Send a non-complex message posing as a kernel notification (`id`), optionally carrying a send-once reply right. */
static void send_forged_notice(mach_port_t destination, mach_msg_id_t id, mach_port_t reply) {
  struct {
    mach_msg_header_t header;
    char body[12];
  } notice{};
  notice.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, reply ? MACH_MSG_TYPE_MAKE_SEND_ONCE : 0);
  notice.header.msgh_size = sizeof(notice);
  notice.header.msgh_remote_port = destination;
  notice.header.msgh_local_port = reply;
  notice.header.msgh_id = id;
  const auto sent = mach_msg(&notice.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(notice), 0, MACH_PORT_NULL, 5000, MACH_PORT_NULL);
  if (sent != KERN_SUCCESS) throw std::runtime_error("forged Mach notice send failed");
}
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  std::vector<IOSurfaceRef> surfaces;
  try {
    const std::string mode(argv[2]);
    if (mode == "mach-oversize") {
      // A message larger than the receiver's buffer, sent straight to the listener port without a hello.
      auto endpoint = parse_endpoint(argv[1]);
      mach_port_t listener = MACH_PORT_NULL;
      if (bootstrap_look_up(bootstrap_port, endpoint.name.c_str(), &listener) != KERN_SUCCESS) throw std::runtime_error("listener lookup failed");
      static struct { mach_msg_header_t header; char payload[64 * 1024]; } message;
      message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
      message.header.msgh_size = sizeof(message);
      message.header.msgh_remote_port = listener;
      const auto sent = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(message), 0, MACH_PORT_NULL, 5000, MACH_PORT_NULL);
      mach_port_deallocate(mach_task_self(), listener);
      if (sent != KERN_SUCCESS) throw std::runtime_error("oversized Mach message send failed");
      return 0;
    }
    if (mode == "mach-forged-notice-listener") {
      // Forged dead-name and no-senders notices carrying send-once reply rights, sent straight to the listener port
      // without a handshake. The receiver must destroy every reply right so the sender observes send-once notices.
      auto endpoint = parse_endpoint(argv[1]);
      mach_port_t listener = MACH_PORT_NULL;
      if (bootstrap_look_up(bootstrap_port, endpoint.name.c_str(), &listener) != KERN_SUCCESS) throw std::runtime_error("listener lookup failed");
      mach_port_t watched_dead = receive_port();
      mach_port_t watched_no_senders = receive_port();
      send_forged_notice(listener, MACH_NOTIFY_DEAD_NAME, watched_dead);
      send_forged_notice(listener, MACH_NOTIFY_NO_SENDERS, watched_no_senders);
      mach_port_deallocate(mach_task_self(), listener);
      const bool dead_destroyed = send_once_within(watched_dead, 10000);
      const bool no_senders_destroyed = send_once_within(watched_no_senders, 10000);
      mach_port_destroy(mach_task_self(), watched_dead);
      mach_port_destroy(mach_task_self(), watched_no_senders);
      if (!dead_destroyed) { std::fputs("the listener kept the reply right of a forged dead-name notice\n", stderr); return 1; }
      if (!no_senders_destroyed) { std::fputs("the listener kept the reply right of a forged no-senders notice\n", stderr); return 1; }
      return 0;
    }
    if (mode == "mach-forged-notice-channel") {
      // Forged dead-name and no-senders notices sent on an active connection port: two carrying send-once reply rights
      // and a bare no-senders notice trying to end the connection. All three must be rejected while the connection stays up.
      auto channel = connect_raw(parse_endpoint(argv[1]));
      char token[65];
      std::snprintf(token, sizeof(token), "%llu", static_cast<unsigned long long>(channel.connection));
      mach_port_t watched_dead = receive_port();
      mach_port_t watched_no_senders = receive_port();
      send_forged_notice(channel.remote, MACH_NOTIFY_DEAD_NAME, watched_dead);
      send_forged_notice(channel.remote, MACH_NOTIFY_NO_SENDERS, watched_no_senders);
      send_forged_notice(channel.remote, MACH_NOTIFY_NO_SENDERS, MACH_PORT_NULL);
      Packet armed; armed.kind = message; std::strcpy(armed.text, "armed");
      RawMessage normal;
      compose(normal, armed, token);
      send_raw(channel.remote, normal);
      const bool dead_destroyed = send_once_within(watched_dead, 10000);
      const bool no_senders_destroyed = send_once_within(watched_no_senders, 10000);
      mach_port_destroy(mach_task_self(), watched_dead);
      mach_port_destroy(mach_task_self(), watched_no_senders);
      if (!dead_destroyed) { std::fputs("the channel kept the reply right of a forged dead-name notice\n", stderr); return 1; }
      if (!no_senders_destroyed) { std::fputs("the channel kept the reply right of a forged no-senders notice\n", stderr); return 1; }
      if (!answer_within(channel.local, 10000)) { std::fputs("a forged notice ended the connection\n", stderr); return 1; }
      Packet bye; bye.kind = goodbye;
      RawMessage close;
      compose(close, bye, token);
      send_raw(channel.remote, close);
      return 0;
    }
    if (mode == "mach-move-receive" || mode == "mach-reply-port") {
      // A message of the protocol's shape that carries a port right the protocol never sends. The receiver must
      // destroy the whole message; the producer then observes the right die, and reports it when it survives.
      auto channel = connect_raw(parse_endpoint(argv[1]));
      char token[65];
      std::snprintf(token, sizeof(token), "%llu", static_cast<unsigned long long>(channel.connection));
      mach_port_t watched = receive_port();
      Packet smuggled; smuggled.kind = message; std::strcpy(smuggled.text, "smuggled");
      RawMessage hostile;
      compose(hostile, smuggled, token);
      if (mode == "mach-move-receive") { hostile.port.disposition = MACH_MSG_TYPE_MOVE_RECEIVE; hostile.port.name = watched; }
      else {
        // A reply right in the header, with the complex bit kept so the shape still passes without the fix.
        hostile.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE) | MACH_MSGH_BITS_COMPLEX;
        hostile.header.msgh_local_port = watched;
      }
      send_raw(channel.remote, hostile);
      // A normal message behind it proves the receiver dropped the hostile one and kept the connection.
      Packet armed; armed.kind = message; std::strcpy(armed.text, "armed");
      RawMessage normal;
      compose(normal, armed, token);
      send_raw(channel.remote, normal);
      const bool destroyed = mode == "mach-move-receive" ? dead_name_within(watched, 10000) : send_once_within(watched, 10000);
      if (!destroyed) {
        std::fprintf(stderr, "%s\n", mode == "mach-move-receive"
          ? "the receiver kept the transferred receive right" : "the receiver kept the send-once reply right");
        return 1;
      }
      if (!answer_within(channel.local, 10000)) { std::fputs("the connection stopped answering\n", stderr); return 1; }
      Packet bye; bye.kind = goodbye;
      RawMessage close;
      compose(close, bye, token);
      send_raw(channel.remote, close);
      return 0;
    }
    auto endpoint = parse_endpoint(argv[1]); auto channel = connect_channel(endpoint);
    Packet greeting; greeting.kind = hello; greeting.max_frames = hello_capabilities;
    std::snprintf(greeting.token, sizeof(greeting.token), "%s", endpoint.token.c_str()); send(*channel, greeting);
    auto readyPacket = receive(*channel);
    if (readyPacket.kind != ready) throw std::runtime_error("handshake refused");
    channel->bind_connection(parse_connection(readyPacket.token));
    if (mode == "foreign") {
      channel->bind_connection(channel->connection() + 1);
      Packet invalid; invalid.kind = message; send(*channel, invalid);
    } else {
      auto image = surface(mode); surfaces.push_back(image);
      Packet allocation; allocation.kind = allocate; allocation.allocation_id = 1;
      allocation.max_bytes = mode == "allocation" ? readyPacket.max_bytes + 1 : IOSurfaceGetAllocSize(image);
      send(*channel, allocation);
      if (mode != "allocation") {
        for (;;) { auto packet = receive(*channel); if (packet.kind == allocated) break; control(*channel, packet); }
        if (mode == "allocation-reuse") send(*channel, allocation);
        else {
          Packet armed; armed.kind = message; std::strcpy(armed.text, "armed"); send(*channel, armed);
          // Tests send "go" after their viewport acknowledgement, so metadata has a deterministic generation.
          for (;;) { auto packet = receive(*channel); control(*channel, packet); if (std::strcmp(packet.text, "go") == 0) break; }
          Packet value; value.kind = frame; value.frame_id = 1; value.allocation_id = 1;
          value.width = mode == "oversize" ? 16385 : mode == "zero" ? 0 : 64;
          value.height = mode == "oversize" ? 65535 : mode == "zero" ? 0 : 64;
          value.stride = IOSurfaceGetBytesPerRow(image) + (mode == "stride-plus" ? 1 : mode == "stride-minus" ? -1 : 0);
          std::snprintf(value.text, sizeof(value.text), "{\"requestId\":\"\",\"generation\":%llu,\"revision\":1}", static_cast<unsigned long long>(generation));
          if (mode == "metadata") std::memset(value.text, 'x', sizeof(value.text));
          if (mode == "metadata-deep") { std::string deep(2000, '['); deep += "0"; deep += std::string(2000, ']'); std::strcpy(value.text, deep.c_str()); }
          if (mode == "metadata-utf8") { value.text[0] = char(0xff); value.text[1] = 0; }
          send(*channel, value, image);
          if (mode == "frame-reuse") send(*channel, value, image);
          if (mode == "deallocate") { Packet invalid; invalid.kind = deallocate; invalid.allocation_id = 1; send(*channel, invalid); }
          std::puts("submitted"); std::fflush(stdout);
          if (mode == "flood") {
            unsigned submitted = 1, attempts = 0; bool credit = false;
            const auto start = std::chrono::steady_clock::now();
            for (; attempts < 1000; ++attempts) {
              Received result{}; const int status = channel->receive(result, 0);
              if (status < 0) throw std::runtime_error("flood peer closed");
              if (status == 1) { control(*channel, result.packet); if (result.packet.kind == release) credit = true; }
              if (credit) { value.frame_id++; send(*channel, value, image); submitted++; credit = false; }
              std::this_thread::sleep_until(start + std::chrono::milliseconds(attempts + 1));
            }
            Packet done; done.kind = message; std::snprintf(done.text, sizeof(done.text), "{\"attempts\":1000,\"submitted\":%u}", submitted); send(*channel, done);
          }
        }
      }
    }
    for (;;) {
      Received result{}; const int status = channel->receive(result, 10000);
      if (status < 0) break;
      if (status == 0) continue;
      if (result.packet.kind == goodbye) break;
      control(*channel, result.packet);
      if (std::strcmp(result.packet.text, "exit") == 0) { Packet bye; bye.kind = goodbye; send(*channel, bye); break; }
      if (std::strcmp(result.packet.text, "check") == 0) {
        int inUse = 0; for (auto image : surfaces) inUse += IOSurfaceIsInUse(image) ? 1 : 0;
        Packet report; report.kind = message; std::snprintf(report.text, sizeof(report.text), "{\"inUse\":%d}", inUse); send(*channel, report);
      }
    }
    for (auto image : surfaces) CFRelease(image);
    return 0;
  } catch (const std::exception& error) {
    for (auto image : surfaces) CFRelease(image);
    std::fprintf(stderr, "%s\n", error.what()); return 3;
  }
}
