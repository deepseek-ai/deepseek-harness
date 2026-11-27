#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <functional>
#include <chrono>
#define DSH_FRAME_FORWARDING_PROTOCOL_VERSION 2
#define DSH_FRAME_FORWARDING_TEXT_CAPACITY 16384
namespace dsh_frame_forwarding {
constexpr uint32_t magic = 0x44535231;
enum Kind : uint32_t { hello = 1, ready, frame, release, message, goodbye, allocate, allocated, deallocate };
/** hello.max_frames carries optional capabilities; zero is the legacy producer. */
constexpr uint32_t hello_keyed_mutex = 1;
/**
 * The producer holds a transferable TX credential and requires the connection identifier in ready.token. Receivers
 * refuse producers without it, so a producer that relied on PID binding never connects.
 */
constexpr uint32_t hello_transferable = 2;
/**
 * Every handle a producer names belongs to the producer: on Windows frame.resource is a handle value in the producer's
 * process, which the receiver duplicates from that process. Receivers refuse producers without it, and ready.stride
 * echoes the hello capabilities the receiver accepted, so producers refuse receivers that would read the value as a
 * handle of their own.
 */
constexpr uint32_t hello_producer_local_handles = 4;
/** The hello capabilities a receiver of these sources accepts and echoes in ready.stride. */
constexpr uint32_t hello_capabilities = hello_keyed_mutex | hello_transferable | hello_producer_local_handles;
/**
 * frame.max_frames carries per-frame flags; zero is an ordered frame. A replaceable frame may be dropped before
 * presentation once a newer replaceable frame of the same view is ready; receivers that ignore the flag present it.
 */
constexpr uint32_t frame_replaceable = 1;
/** goodbye.text of a candidate the receiver refuses before it receives a connection identifier. */
constexpr const char* reject_busy = "channel-busy";
constexpr const char* reject_capability = "transferable-tx-required";
constexpr const char* reject_local_handles = "producer-local-handles-required";
constexpr const char* reject_credential = "invalid-credential";
constexpr const char* reject_closed = "channel-closed";
/** Prefix of a refusal that names the producer's and the receiver's protocol versions. */
constexpr const char* reject_protocol = "protocol-mismatch";
struct Packet {
  uint32_t marker = magic, version = DSH_FRAME_FORWARDING_PROTOCOL_VERSION, kind = 0;
  uint32_t width = 0, height = 0, stride = 0, max_frames = 0;
  uint64_t frame_id = 0, allocation_id = 0, max_bytes = 0, resource = 0;
  /** hello: the TX secret. After the handshake: the decimal connection identifier. */
  char token[65] = {};
  char text[DSH_FRAME_FORWARDING_TEXT_CAPACITY] = {};
};
/**
 * Wire form of a Packet: this header, then text_size bytes of text. text_size counts the text before its terminating
 * NUL, or is DSH_FRAME_FORWARDING_TEXT_CAPACITY for a text without one, which is sent whole and stays unterminated so
 * the receiver refuses it. Mach messages pad the text with zeros to a multiple of 4 bytes. Protocol 1 sent the whole
 * Packet; only the marker, version, and kind of its hello are read, so that hello is refused as another version.
 */
struct WireHeader {
  uint32_t marker = magic, version = DSH_FRAME_FORWARDING_PROTOCOL_VERSION, kind = 0;
  uint32_t width = 0, height = 0, stride = 0, max_frames = 0;
  uint32_t text_size = 0;
  uint64_t frame_id = 0, allocation_id = 0, max_bytes = 0, resource = 0;
  char token[65] = {};
  char reserved[7] = {};
};
static_assert(sizeof(WireHeader) == 136, "WireHeader layout");
struct Received { Packet packet; uint32_t pid = 0; uintptr_t resource = 0; };
/**
 * One physical producer connection. receive returns 1 data, 0 timeout, -1 closed/error. After bind_connection, every
 * sent packet carries the connection identifier and a received packet without it closes the channel.
 */
class Channel {
 public:
  virtual ~Channel() = default;
  int receive(Received& out, uint32_t timeout_ms);
  bool send(const Packet& packet, uintptr_t resource = 0);
  void bind_connection(uint64_t id);
  uint64_t connection() const { return connection_; }
  /** The last receive closed because a packet named another connection. */
  bool foreign_packet() const { return foreign_; }
  /** The last receive closed because a packet named a handle its live sender does not own. */
  bool invalid_resource() const { return invalid_resource_; }
  virtual void interrupt() = 0;
  virtual uint32_t peer_pid() const = 0;
 protected:
  virtual int receive_packet(Received&, uint32_t timeout_ms) = 0;
  virtual bool send_packet(const Packet&, uintptr_t resource) = 0;
  bool invalid_resource_ = false;
 private:
  uint64_t connection_ = 0;
  char connection_text_[65] = {};
  bool foreign_ = false;
};
/** A producer whose hello reached the listener; its channel answers it before acceptance or refusal. */
struct Candidate { Received hello; std::unique_ptr<Channel> channel; };
/** The stable endpoint of one logical channel. Each producer connection gets a channel of its own. */
class Listener {
 public:
  virtual ~Listener() = default;
  /** 1 candidate, 0 timeout, -1 stopped or failed. Malformed or silent connections are dropped without affecting others. */
  virtual int accept(Candidate& candidate, uint32_t timeout_ms) = 0;
  virtual void interrupt() = 0;
};
struct Endpoint { uint32_t pid; std::string token, name; };
Endpoint parse_endpoint(const std::string& value);
/** Publish the endpoint name. handshake_ms bounds how long a connected client may withhold its hello. */
std::unique_ptr<Listener> listen(Endpoint& endpoint, uint32_t handshake_ms);
std::unique_ptr<Channel> connect_channel(const Endpoint& endpoint, const std::function<bool()>& cancelled = {});
/** Parse a decimal connection identifier from a token; 0 when it is not one. */
uint64_t parse_connection(const char (&token)[65]);
uint32_t process_id();
uintptr_t receive_resource(Received& received);
void release_resource(uintptr_t resource);
void clear_validation_device();
uint64_t resource_bytes(uintptr_t resource);
/**
 * Validate a producer frame's format and dimensions and report its adapter. On Windows a keyed-mutex texture is also
 * made ready: key 0 is acquired within the deadline and released, before Chromium's unbounded key-0 acquisition.
 */
bool resource_dimensions(uintptr_t resource, uint32_t width, uint32_t height, uint32_t stride,
    std::chrono::steady_clock::time_point deadline, std::string& diagnostic, std::string& adapter, bool* keyed_mutex = nullptr);
/** Adapter owning a shared resource, or an empty string when it cannot be identified. */
std::string resource_adapter(uintptr_t resource);
/** Adapter owning the producer's graphics device. */
std::string device_adapter(void* device);
#if defined(_WIN32)
struct RelayDevice;
struct RelayTexture;
struct RelayReadback;
struct RelaySource;
uintptr_t relay_handle(const std::shared_ptr<RelayTexture>& texture);
bool relay_begin(uintptr_t resource, uint32_t width, uint32_t height,
    const std::string& adapter, std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& stopped,
    std::shared_ptr<RelayDevice>& display, std::shared_ptr<RelayTexture>& slot, std::string& diagnostic);
int relay_advance(const std::shared_ptr<RelayTexture>& slot, const std::atomic<bool>& stopped,
    std::chrono::steady_clock::time_point deadline, std::string& diagnostic);
uintptr_t relay_completion_event(const std::shared_ptr<RelayTexture>& slot);
/** True only after every submitted copy completes or its device is removed. */
bool relay_gpu_idle(const std::shared_ptr<RelayTexture>& slot, std::string& diagnostic);
/** Validate each frame and copy under key 0; reuse the allocation's import only for the same NT object and dimensions. */
bool relay_readback_begin(uintptr_t resource, uint32_t width, uint32_t height, uint32_t stride,
    std::shared_ptr<RelayReadback>& slot, std::shared_ptr<RelaySource>& imported,
    std::string& diagnostic, std::string& adapter, bool* keyed_mutex,
    std::chrono::steady_clock::time_point deadline);
int relay_readback_ready(const std::shared_ptr<RelayReadback>& slot, bool retiring, std::string& diagnostic);
uintptr_t relay_readback_event(const std::shared_ptr<RelayReadback>& slot);
int relay_upload(const std::shared_ptr<RelayReadback>& source, uint32_t width, uint32_t height,
    const std::string& adapter, std::shared_ptr<RelayDevice>& display, std::shared_ptr<RelayTexture>& target,
    std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& stopped, std::string& diagnostic);
uintptr_t create_gpu_retry_timer();
/** Borrowed device; the relay image retains its lifetime. */
void* relay_output_device(const std::shared_ptr<RelayTexture>& texture);
void relay_forget_source(const std::shared_ptr<RelayTexture>& texture);
/** Copy the retained image and signal its existing completion fence. */
bool relay_copy_output(const std::shared_ptr<RelayTexture>& texture, void* destination, std::string& diagnostic);
bool relay_readback_image(const std::shared_ptr<RelayTexture>& texture, std::shared_ptr<RelayReadback>& staging, std::string& diagnostic);
int relay_with_pixels(const std::shared_ptr<RelayReadback>& staging,
    const std::function<bool(const uint8_t*, uint32_t)>& consume, std::string& diagnostic);
#endif
}
