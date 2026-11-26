/**
 * Platform transport behind `shared-texture-ingress.node`: owns Main's endpoint, authenticates the Desktop Host,
 * converts each valid present request into a Main-local handle, and writes replies. `ingress.cc` owns the Node-API side.
 */
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include "dstx-protocol.h"

namespace ingress {

/** One validated present request whose `handle` is a Main-local `IOSurfaceRef` or NT `HANDLE`. */
struct Frame {
  dstx::DstxPresentHeader header{};
  std::string metadata;
  uint64_t handle = 0;
};

enum class Queued { Accepted, Full, Closed };

/** Receives transport events on the reader thread. */
class Handler {
 public:
  virtual ~Handler() = default;
  /**
   * Offer one frame to JavaScript. `Accepted` takes ownership of `frame.handle`; with `Full` or `Closed` the transport
   * still owns it, releases it, and either rejects the request (`Full`) or stops with a terminal error (`Closed`).
   */
  virtual Queued frame(Frame& frame) = 0;
};

class Transport {
 public:
  virtual ~Transport() = default;
  /** Name the Host passes to `connect`. */
  virtual const std::string& endpoint() const = 0;
  /**
   * Serve the endpoint on the calling thread until `stop` or a terminal failure.
   * @returns nullptr after `stop`, otherwise the terminal error text.
   */
  virtual const char* run(Handler& handler) = 0;
  /** Make `run` return promptly; callable from any thread. */
  virtual void stop() = 0;
  /**
   * Send one reply; callable from any thread, never blocks longer than the reply timeout, and drops the reply silently
   * when no Host is reachable. A reply that cannot be written within the timeout drops the Host connection.
   */
  virtual void reply(uint64_t request_id, uint32_t kind, uint16_t flags, const char* error, size_t error_length) = 0;
};

/** Bound on writing one reply before the Host connection counts as lost. */
constexpr uint32_t kReplyTimeoutMs = 100;

/** Create the endpoint that accepts requests from `peer_pid` only; nullptr with `error` set on failure. */
std::unique_ptr<Transport> open_transport(uint32_t peer_pid, std::string& error);
/** Release a Main-local handle a frame carried: `CFRelease` or `CloseHandle`. */
void release_handle(uint64_t handle);
/**
 * Windows: identify the adapter on which the shared resource behind the Main-local NT `handle` was created, as the
 * adapter's LUID in lowercase hexadecimal without leading zeros, `HighPart` (read as unsigned) and `LowPart` joined by
 * a colon, such as `0:1234`. The caller keeps `handle`.
 * @returns false when the adapter cannot be read, and always on macOS.
 */
bool adapter_luid(uint64_t handle, std::string& luid);

}  // namespace ingress
