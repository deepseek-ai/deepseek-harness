/**
 * macOS transport for `shared-texture-hop.node`: sends each request to Main's bootstrap-registered ingress port with
 * the IOSurface port, and receives replies on this connection's reply port. The first request that reaches Main
 * carries the only send right to the reply port, and Main keeps it for the connection's later requests. Two
 * notifications delivered to the reply port end the connection: a dead name for the ingress port when Main is gone,
 * and no senders when Main dropped its right because it could not answer.
 */
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <mach/notify.h>
#include <servers/bootstrap.h>
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <set>
#include "hop-transport.h"

namespace hop {
namespace {

constexpr char kEndpointPrefix[] = "ai.deepseek.shared-texture.";
constexpr mach_msg_id_t kWakeId = 0x44535457;  // "DSTW"

constexpr size_t round4(size_t value) { return (value + 3) & ~size_t{3}; }

/** Host -> Main present request: the payload holds the DSTX header and metadata. */
struct PresentMessage {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  unsigned char payload[round4(dstx::kMaxPresentBytes)];
};

/** Receive buffer for replies, wake-ups, and kernel notifications. */
struct ReceiveBuffer {
  mach_msg_header_t header;
  unsigned char payload[round4(dstx::kMaxReplyBytes)];
  mach_msg_max_trailer_t trailer;
};
static_assert(sizeof(ReceiveBuffer) >= sizeof(mach_dead_name_notification_t), "dead-name notification fits");

/**
 * Ingress port names with a live connection in this process. Mach merges rights to one port under one name, and a
 * name holds one dead-name request, so a second connection to the same endpoint is refused.
 */
std::mutex connected_mutex;
std::set<mach_port_t> connected_ports;

/** Drop send rights to our own reply port that a timed-out send returned; this process holds none on purpose. */
void drop_reply_sends(mach_port_t reply) {
  mach_port_urefs_t refs = 0;
  if (mach_port_get_refs(mach_task_self(), reply, MACH_PORT_RIGHT_SEND, &refs) == KERN_SUCCESS && refs > 0) {
    mach_port_mod_refs(mach_task_self(), reply, MACH_PORT_RIGHT_SEND, -static_cast<mach_port_delta_t>(refs));
  }
}

/** Release this process's right to the ingress port, whether still a send right or already a dead name. */
void release_ingress(mach_port_t ingress) {
  mach_port_type_t type = 0;
  if (mach_port_type(mach_task_self(), ingress, &type) != KERN_SUCCESS) return;
  if (type & MACH_PORT_TYPE_DEAD_NAME) {
    mach_port_urefs_t refs = 0;
    if (mach_port_get_refs(mach_task_self(), ingress, MACH_PORT_RIGHT_DEAD_NAME, &refs) == KERN_SUCCESS && refs > 0) {
      mach_port_mod_refs(mach_task_self(), ingress, MACH_PORT_RIGHT_DEAD_NAME, -static_cast<mach_port_delta_t>(refs));
    }
  } else {
    mach_port_deallocate(mach_task_self(), ingress);
  }
}

class MachTransport final : public Transport {
 public:
  MachTransport(mach_port_t ingress, mach_port_t reply) : ingress_(ingress), reply_(reply) {}

  ~MachTransport() override {
    mach_port_t previous = MACH_PORT_NULL;
    mach_port_request_notification(mach_task_self(), ingress_, MACH_NOTIFY_DEAD_NAME, 0, MACH_PORT_NULL, MACH_MSG_TYPE_MOVE_SEND_ONCE, &previous);
    if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);
    // Destroying the name also destroys queued replies and any send right a timed-out send left behind.
    mach_port_destroy(mach_task_self(), reply_);
    release_ingress(ingress_);
    std::lock_guard<std::mutex> lock(connected_mutex);
    connected_ports.erase(ingress_);
  }

  Sent send(const dstx::DstxPresentHeader& header, std::string_view metadata, uint64_t handle, std::string& error) override {
    const auto surface = IOSurfaceCreateMachPort(reinterpret_cast<IOSurfaceRef>(static_cast<uintptr_t>(handle)));
    if (surface == MACH_PORT_NULL) { error = "Cannot export the shared-texture surface"; return Sent::Failed; }
    std::lock_guard<std::mutex> lock(send_mutex_);
    const bool carries_reply = !reply_sent_;
    auto& message = message_;
    const size_t payload = sizeof(header) + metadata.size();
    // Every header and descriptor field is set and the alignment padding cleared, so no byte of `msgh_size` is stale.
    message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, carries_reply ? MACH_MSG_TYPE_MAKE_SEND : 0) | MACH_MSGH_BITS_COMPLEX;
    message.header.msgh_size = static_cast<mach_msg_size_t>(offsetof(PresentMessage, payload) + round4(payload));
    message.header.msgh_remote_port = ingress_;
    message.header.msgh_local_port = carries_reply ? reply_ : MACH_PORT_NULL;
    message.header.msgh_voucher_port = MACH_PORT_NULL;
    message.header.msgh_id = static_cast<mach_msg_id_t>(dstx::kDstxMagic);
    message.body.msgh_descriptor_count = 1;
    message.surface = mach_msg_port_descriptor_t{};
    message.surface.name = surface;
    message.surface.disposition = MACH_MSG_TYPE_COPY_SEND;
    message.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    std::memcpy(message.payload, &header, sizeof(header));
    if (!metadata.empty()) std::memcpy(message.payload + sizeof(header), metadata.data(), metadata.size());
    std::memset(message.payload + payload, 0, round4(payload) - payload);
    const auto result = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, message.header.msgh_size, 0, MACH_PORT_NULL,
      kSendTimeoutMs, MACH_PORT_NULL);
    if ((result & ~MACH_MSG_MASK) == MACH_SEND_TIMED_OUT) {
      // A timed-out send returns the copied rights in the message, separately owned from the originals.
      mach_msg_destroy(&message.header);
      if (carries_reply) drop_reply_sends(reply_);
    }
    mach_port_deallocate(mach_task_self(), surface);
    if (result == KERN_SUCCESS) {
      if (carries_reply) {
        reply_sent_ = true;
        watch_reply_senders();
      }
      return Sent::Sent;
    }
    // The ingress port is a dead name once Main closed it or exited.
    if (result == MACH_SEND_INVALID_DEST) {
      error = "Desktop shared-texture ingress disconnected";
      return Sent::Broken;
    }
    error = "Cannot deliver the shared texture to Desktop";
    return Sent::Failed;
  }

  Received receive(int64_t timeout_ms, Reply& reply) override {
    if (unwatched_) return Received::Disconnected;
    ReceiveBuffer buffer{};
    const mach_msg_option_t options = MACH_RCV_MSG | (timeout_ms >= 0 ? MACH_RCV_TIMEOUT : 0);
    const auto timeout = timeout_ms >= 0 ? static_cast<mach_msg_timeout_t>(std::min<int64_t>(timeout_ms, UINT32_MAX)) : MACH_MSG_TIMEOUT_NONE;
    const auto result = mach_msg(&buffer.header, options, 0, sizeof(buffer), reply_, timeout, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT) return Received::TimedOut;
    // Only Main and this process hold send rights to the reply port; an oversized message is a protocol violation.
    if (result != KERN_SUCCESS) return Received::Disconnected;
    const auto& header = buffer.header;
    if (header.msgh_id == MACH_NOTIFY_DEAD_NAME && !(header.msgh_bits & MACH_MSGH_BITS_COMPLEX)
        && header.msgh_size >= sizeof(mach_dead_name_notification_t) - sizeof(mach_msg_format_0_trailer_t)) {
      const auto* notification = reinterpret_cast<const mach_dead_name_notification_t*>(&buffer);
      if (notification->not_port != ingress_) return Received::Woken;
      // The notification carries one more dead-name reference, which the receiver owns.
      mach_port_deallocate(mach_task_self(), notification->not_port);
      return Received::Disconnected;
    }
    if (header.msgh_id == MACH_NOTIFY_NO_SENDERS && !(header.msgh_bits & MACH_MSGH_BITS_COMPLEX)) {
      // Main dropped its right to the reply port, so it answers none of this connection's requests any more.
      mach_msg_destroy(&buffer.header);
      return Received::Disconnected;
    }
    if (header.msgh_id != static_cast<mach_msg_id_t>(dstx::kDstxMagic)) {
      // Wake-ups and other kernel notifications (send-once, port-deleted) only make the reader re-check its state.
      mach_msg_destroy(&buffer.header);
      return Received::Woken;
    }
    const size_t available = header.msgh_size >= sizeof(mach_msg_header_t) ? header.msgh_size - sizeof(mach_msg_header_t) : 0;
    if ((header.msgh_bits & MACH_MSGH_BITS_COMPLEX) || available < sizeof(reply.header)) {
      mach_msg_destroy(&buffer.header);
      return Received::Disconnected;
    }
    std::memcpy(&reply.header, buffer.payload, sizeof(reply.header));
    const size_t expected = sizeof(reply.header) + reply.header.error_length;
    if (round4(expected) != available || !dstx::valid_reply(reply.header, expected - sizeof(reply.header))) {
      mach_msg_destroy(&buffer.header);
      return Received::Disconnected;
    }
    reply.error.assign(reinterpret_cast<const char*>(buffer.payload + sizeof(reply.header)), reply.header.error_length);
    mach_msg_destroy(&buffer.header);
    return Received::Reply;
  }

  void wake() override {
    mach_msg_header_t header{};
    header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MAKE_SEND, 0);
    header.msgh_size = sizeof(header);
    header.msgh_remote_port = reply_;
    header.msgh_id = kWakeId;
    // A full queue already wakes the reader, so a wake-up that does not fit is not needed.
    const auto result = mach_msg(&header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(header), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
    if ((result & ~MACH_MSG_MASK) == MACH_SEND_TIMED_OUT) mach_msg_destroy(&header);
  }

 private:
  /**
   * Request the no-senders notification once Main holds the only send right to the reply port; transient rights in
   * wake-ups never bring the count to zero while Main keeps its own. Without the request the reader ends the connection
   * instead of waiting for replies that might never come.
   */
  void watch_reply_senders() {
    mach_port_t previous = MACH_PORT_NULL;
    if (mach_port_request_notification(mach_task_self(), reply_, MACH_NOTIFY_NO_SENDERS, 1, reply_, MACH_MSG_TYPE_MAKE_SEND_ONCE,
        &previous) != KERN_SUCCESS) {
      unwatched_ = true;
      wake();
      return;
    }
    if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);
  }

  const mach_port_t ingress_;
  const mach_port_t reply_;
  std::mutex send_mutex_;
  /** Guarded by send_mutex_: a request carrying the reply port reached Main. */
  bool reply_sent_ = false;
  /** Guarded by send_mutex_; allocated with the connection so that a request costs no allocation. */
  PresentMessage message_{};
  std::atomic<bool> unwatched_{false};
};

}  // namespace

std::unique_ptr<Transport> connect(const std::string& endpoint, std::string& error) {
  error = "Desktop shared-texture ingress endpoint is unavailable";
  if (endpoint.compare(0, sizeof(kEndpointPrefix) - 1, kEndpointPrefix) != 0 || endpoint.size() >= sizeof(name_t)) return nullptr;
  mach_port_t ingress = MACH_PORT_NULL;
  if (bootstrap_look_up(bootstrap_port, const_cast<char*>(endpoint.c_str()), &ingress) != KERN_SUCCESS) return nullptr;
  {
    std::lock_guard<std::mutex> lock(connected_mutex);
    if (!connected_ports.insert(ingress).second) {
      mach_port_deallocate(mach_task_self(), ingress);
      error = "Desktop shared-texture ingress endpoint is already connected";
      return nullptr;
    }
  }
  auto fail = [&](const char* text, mach_port_t reply) -> std::unique_ptr<Transport> {
    if (reply != MACH_PORT_NULL) mach_port_destroy(mach_task_self(), reply);
    release_ingress(ingress);
    std::lock_guard<std::mutex> lock(connected_mutex);
    connected_ports.erase(ingress);
    error = text;
    return nullptr;
  };
  mach_port_t reply = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply) != KERN_SUCCESS) {
    return fail("Cannot allocate the shared-texture reply port", MACH_PORT_NULL);
  }
  // Up to two replies per admitted request can wait while the reader runs callbacks.
  mach_port_limits_t limits{MACH_PORT_QLIMIT_LARGE};
  mach_port_set_attributes(mach_task_self(), reply, MACH_PORT_LIMITS_INFO, reinterpret_cast<mach_port_info_t>(&limits), MACH_PORT_LIMITS_INFO_COUNT);
  mach_port_t previous = MACH_PORT_NULL;
  if (mach_port_request_notification(mach_task_self(), ingress, MACH_NOTIFY_DEAD_NAME, 1, reply, MACH_MSG_TYPE_MAKE_SEND_ONCE, &previous) != KERN_SUCCESS) {
    return fail("Cannot watch the Desktop shared-texture ingress", reply);
  }
  if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);
  error.clear();
  return std::make_unique<MachTransport>(ingress, reply);
}

bool sends_handle_values() { return false; }

}  // namespace hop
