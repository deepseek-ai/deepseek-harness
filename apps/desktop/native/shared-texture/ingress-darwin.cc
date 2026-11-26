/**
 * macOS transport for `shared-texture-ingress.node`: a Mach receive port registered under a random bootstrap name.
 * Each present request carries the IOSurface port, and the first request of a Host connection also a send right to
 * the Host's reply port; the kernel audit trailer identifies the sending process, and messages from any process other
 * than the Desktop Host are destroyed unread. Main keeps the reply right of the current connection, sends replies with
 * a bounded timeout, and drops the right when a reply fails, which ends the connection for the Host. The reader blocks
 * until a message arrives; `stop` wakes it with an empty message of its own.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <bsm/libbsm.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <unistd.h>
#include <atomic>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include "ingress-transport.h"

namespace ingress {
namespace {

/** `stop`'s wake-up message. */
constexpr mach_msg_id_t kStopId = 0x44535451;  // "DSTQ"

constexpr size_t round4(size_t value) { return (value + 3) & ~size_t{3}; }

/** Host -> Main present request as received: the payload holds the DSTX header and metadata. */
struct PresentMessage {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  unsigned char payload[round4(dstx::kMaxPresentBytes)];
  mach_msg_audit_trailer_t trailer;
};

/** Main -> Host reply: the payload holds the DSTX reply header and error text. */
struct ReplyMessage {
  mach_msg_header_t header;
  unsigned char payload[round4(dstx::kMaxReplyBytes)];
};

class MachTransport final : public Transport {
 public:
  MachTransport(uint32_t peer, std::string name, mach_port_t port) : peer_(peer), name_(std::move(name)), port_(port) {}

  ~MachTransport() override {
    const auto ignored = bootstrap_register(bootstrap_port, const_cast<char*>(name_.c_str()), MACH_PORT_NULL);
    (void)ignored;
    mach_port_deallocate(mach_task_self(), port_);
    mach_port_mod_refs(mach_task_self(), port_, MACH_PORT_RIGHT_RECEIVE, -1);
    if (reply_port_ != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), reply_port_);
  }

  const std::string& endpoint() const override { return name_; }

  const char* run(Handler& handler) override {
    auto message = std::make_unique<PresentMessage>();
    while (!stopped_) {
      // The kernel writes the received bytes and the trailer; validation reads only those and the fixed fields.
      std::memset(message.get(), 0, offsetof(PresentMessage, payload));
      const auto result = mach_msg(&message->header, MACH_RCV_MSG | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)
          | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT), 0, sizeof(PresentMessage), port_, MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL);
      // The kernel discards a message larger than any request; only another process sends one.
      if (result == MACH_RCV_TOO_LARGE) continue;
      if (result != KERN_SUCCESS) return "Shared-texture ingress port failed";
      const auto* trailer = reinterpret_cast<const mach_msg_audit_trailer_t*>(
        reinterpret_cast<const char*>(&message->header) + round4(message->header.msgh_size));
      const bool audited = trailer->msgh_trailer_size >= sizeof(mach_msg_audit_trailer_t);
      const auto sender = audited ? static_cast<uint32_t>(audit_token_to_pid(trailer->msgh_audit)) : 0;
      // `stop` sets the flag before it sends its wake-up, so nothing received from then on is served; the loop
      // condition then ends the reader.
      if (stopped_ || (message->header.msgh_id == kStopId && audited && sender == static_cast<uint32_t>(getpid()))) {
        mach_msg_destroy(&message->header);
        continue;
      }
      // Another process that learned the endpoint name loses its message; requests from the Host continue.
      if (!audited || sender != peer_) {
        mach_msg_destroy(&message->header);
        continue;
      }
      dstx::DstxPresentHeader header{};
      const auto& received = message->header;
      const size_t fixed = offsetof(PresentMessage, payload);
      const size_t available = received.msgh_size >= fixed ? received.msgh_size - fixed : 0;
      if (available >= sizeof(header)) std::memcpy(&header, message->payload, sizeof(header));
      const size_t expected = sizeof(header) + header.metadata_length;
      // Only the first request of a Host connection carries a send right to its reply port.
      const bool carries_reply = received.msgh_remote_port != MACH_PORT_NULL;
      const auto reply_disposition = static_cast<mach_msg_bits_t>(carries_reply ? MACH_MSG_TYPE_PORT_SEND : 0);
      if (!(received.msgh_bits & MACH_MSGH_BITS_COMPLEX) || MACH_MSGH_BITS_REMOTE(received.msgh_bits) != reply_disposition
          || message->body.msgh_descriptor_count != 1
          || message->surface.type != MACH_MSG_PORT_DESCRIPTOR || message->surface.disposition != MACH_MSG_TYPE_PORT_SEND
          || message->surface.name == MACH_PORT_NULL || available < sizeof(header) || round4(expected) != available
          || !dstx::valid_present(header, expected - sizeof(header), false)) {
        mach_msg_destroy(&message->header);
        return "Shared-texture ingress received an invalid message";
      }
      const auto route = route_reply(received.msgh_remote_port);
      if (route == Route::Invalid) {
        mach_msg_destroy(&message->header);
        return "Shared-texture ingress received an invalid message";
      }
      if (route == Route::Discard) {
        // Sent on a connection Main has dropped; the Host settles it as invalidated once it observes the drop.
        mach_port_deallocate(mach_task_self(), message->surface.name);
        continue;
      }
      IOSurfaceRef surface = IOSurfaceLookupFromMachPort(message->surface.name);
      mach_port_deallocate(mach_task_self(), message->surface.name);
      if (!surface) {
        const char text[] = "Cannot import the shared-texture surface";
        reply(header.request_id, dstx::DSTX_DELIVERED_ERROR, dstx::kDstxNoReferenceKept, text, sizeof(text) - 1);
        continue;
      }
      Frame frame;
      frame.header = header;
      frame.metadata.assign(reinterpret_cast<const char*>(message->payload + sizeof(header)), header.metadata_length);
      frame.handle = reinterpret_cast<uintptr_t>(surface);
      const auto queued = handler.frame(frame);
      if (queued == Queued::Accepted) continue;
      CFRelease(surface);
      if (queued == Queued::Closed) return "Shared-texture ingress delivery is closed";
      const char text[] = "Shared-texture ingress queue is full";
      reply(header.request_id, dstx::DSTX_DELIVERED_ERROR, dstx::kDstxNoReferenceKept, text, sizeof(text) - 1);
    }
    return nullptr;
  }

  void stop() override {
    stopped_ = true;
    // This process holds a send right to its own port since `open_transport`. A full queue already wakes the reader,
    // so a wake-up that does not fit is not needed.
    mach_msg_header_t header{};
    header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    header.msgh_size = sizeof(header);
    header.msgh_remote_port = port_;
    header.msgh_id = kStopId;
    const auto result = mach_msg(&header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(header), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
    if ((result & ~MACH_MSG_MASK) == MACH_SEND_TIMED_OUT) mach_msg_destroy(&header);
  }

  void reply(uint64_t request_id, uint32_t kind, uint16_t flags, const char* error, size_t error_length) override {
    ReplyMessage message{};
    const dstx::DstxReplyHeader header{dstx::kDstxMagic, dstx::kDstxVersion, kind, flags, static_cast<uint16_t>(error_length), request_id};
    std::memcpy(message.payload, &header, sizeof(header));
    std::memcpy(message.payload + sizeof(header), error, error_length);
    std::lock_guard<std::mutex> lock(reply_mutex_);
    if (reply_port_ == MACH_PORT_NULL) return;
    message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    message.header.msgh_size = static_cast<mach_msg_size_t>(sizeof(mach_msg_header_t) + round4(sizeof(header) + error_length));
    message.header.msgh_remote_port = reply_port_;
    message.header.msgh_id = static_cast<mach_msg_id_t>(dstx::kDstxMagic);
    const auto result = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, message.header.msgh_size, 0, MACH_PORT_NULL,
      kReplyTimeoutMs, MACH_PORT_NULL);
    if (result == KERN_SUCCESS) return;
    // A timed-out send returns the copied right in the message, separately owned from the held one.
    if ((result & ~MACH_MSG_MASK) == MACH_SEND_TIMED_OUT) mach_msg_destroy(&message.header);
    // The Host closed the connection or stopped reading. Dropping the only send right Main holds ends the connection
    // for the Host, which receives a no-senders notification and settles every request; requests it sent meanwhile
    // carry no reply port and are discarded until its next connection brings a new one.
    mach_port_deallocate(mach_task_self(), reply_port_);
    reply_port_ = MACH_PORT_NULL;
    dropped_ = true;
  }

 private:
  enum class Route { Serve, Discard, Invalid };

  /**
   * Adopt the reply port that the first request of a Host connection carries, keeping one user reference to it, or
   * decide whether a later request, which carries none, can be answered.
   * @returns Serve while Main holds a reply port, Discard after Main dropped the connection, and Invalid when the Host
   *   sent no reply port at all.
   */
  Route route_reply(mach_port_t port) {
    std::lock_guard<std::mutex> lock(reply_mutex_);
    if (port == MACH_PORT_NULL) {
      if (reply_port_ != MACH_PORT_NULL) return Route::Serve;
      return dropped_ ? Route::Discard : Route::Invalid;
    }
    if (port == reply_port_) {
      mach_port_deallocate(mach_task_self(), port);
    } else {
      if (reply_port_ != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), reply_port_);
      reply_port_ = port;
    }
    dropped_ = false;
    return Route::Serve;
  }

  const uint32_t peer_;
  const std::string name_;
  const mach_port_t port_;
  std::atomic<bool> stopped_{false};
  std::mutex reply_mutex_;
  mach_port_t reply_port_ = MACH_PORT_NULL;  // Guarded by reply_mutex_.
  /** Guarded by reply_mutex_: Main dropped the reply port of the current Host connection. */
  bool dropped_ = false;
};

std::string random_name() {
  unsigned char random[16];
  arc4random_buf(random, sizeof(random));
  const char* hex = "0123456789abcdef";
  std::string result = "ai.deepseek.shared-texture.";
  for (auto byte : random) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}

}  // namespace

std::unique_ptr<Transport> open_transport(uint32_t peer_pid, std::string& error) {
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) {
    error = "Cannot allocate the shared-texture ingress port";
    return nullptr;
  }
  if (mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
    error = "Cannot allocate the shared-texture ingress port";
    return nullptr;
  }
  // The reader drains the port independently of JavaScript; the larger queue absorbs a burst of requests.
  mach_port_limits_t limits{MACH_PORT_QLIMIT_LARGE};
  mach_port_set_attributes(mach_task_self(), port, MACH_PORT_LIMITS_INFO, reinterpret_cast<mach_port_info_t>(&limits), MACH_PORT_LIMITS_INFO_COUNT);
  auto name = random_name();
  if (bootstrap_register(bootstrap_port, const_cast<char*>(name.c_str()), port) != KERN_SUCCESS) {
    mach_port_deallocate(mach_task_self(), port);
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
    error = "Cannot register the shared-texture ingress endpoint";
    return nullptr;
  }
  return std::make_unique<MachTransport>(peer_pid, std::move(name), port);
}

void release_handle(uint64_t handle) { CFRelease(reinterpret_cast<IOSurfaceRef>(static_cast<uintptr_t>(handle))); }

bool adapter_luid(uint64_t, std::string&) { return false; }

}  // namespace ingress
