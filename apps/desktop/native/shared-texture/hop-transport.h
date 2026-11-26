/**
 * Platform transport behind `shared-texture-hop.node`: sends DSTX present requests to Main's ingress endpoint and
 * receives replies on the hop's reader thread. `hop.cc` owns request bookkeeping and the Node-API side.
 */
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include "dstx-protocol.h"

namespace hop {

struct Reply {
  dstx::DstxReplyHeader header{};
  std::string error;
};

enum class Received { Reply, Woken, TimedOut, Disconnected };

/** `Failed` leaves the connection usable (for example a send timeout); `Broken` means Main can no longer be reached. */
enum class Sent { Sent, Failed, Broken };

class Transport {
 public:
  virtual ~Transport() = default;
  /**
   * Send one request followed by its `metadata`, carrying the Host-local texture `handle` (an `IOSurfaceRef` or NT
   * `HANDLE`); the caller keeps ownership of `handle` and of the `metadata` bytes, which are read only during the call.
   * Callable from any thread; concurrent sends are serialized.
   * @returns `Sent`, or `Failed` / `Broken` with `error` set when the request did not reach Main.
   */
  virtual Sent send(const dstx::DstxPresentHeader& header, std::string_view metadata, uint64_t handle, std::string& error) = 0;
  /**
   * Wait for one reply on the reader thread. `timeout_ms` < 0 waits until a reply, `wake`, or disconnection. A message
   * that violates the protocol counts as `Disconnected`.
   */
  virtual Received receive(int64_t timeout_ms, Reply& reply) = 0;
  /** Make a pending or the next `receive` return `Woken`; callable from any thread. */
  virtual void wake() = 0;
};

/** Bound on writing one request before `send` fails. */
constexpr uint32_t kSendTimeoutMs = 1000;

/** Connect to Main's endpoint; nullptr with `error` set when it is unavailable. */
std::unique_ptr<Transport> connect(const std::string& endpoint, std::string& error);
/** Whether this platform sends NT handle values in `win32_nt_handle`. */
bool sends_handle_values();

}  // namespace hop
