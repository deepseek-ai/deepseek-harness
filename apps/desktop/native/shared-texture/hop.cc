/**
 * Desktop Host side of the shared-texture channel: one connection to Main's `shared-texture-ingress.node` endpoint
 * that sends DSTX v3 present requests and settles each from Main's replies. Requests come from native modules in the
 * Host through the `dsh_shared_texture_sink_v2` ABI in `shared-texture-sink.h` and are answered through its C
 * callbacks; JavaScript opens and closes the connection and hands its `sink` to such a module. A reader thread
 * receives replies, enforces each request's delivery deadline, and settles every outstanding request as invalidated
 * when Main disconnects or JavaScript closes the connection. The platform transport lives in `hop-darwin.cc` (Mach
 * ports) and `hop-win32.cc` (named pipe). The addon depends on Node-API 8 only.
 *
 * Connection state: once the hop finds that the connection can no longer carry a frame (Main exited or closed the
 * endpoint, the pipe broke, the ingress port became a dead name, or Main dropped the connection because a reply could
 * not be delivered), whether the reader observes it or a send runs into it, the connection is disconnected: every
 * unsettled request settles as invalidated (after a failed delivery when it had none), JavaScript then receives
 * exactly one `disconnected` event, and every later `present` returns DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED. A
 * JavaScript `close` has the same effect without the event. A request whose send succeeded is settled this way even
 * when the connection ended during that send, and its `present` still returns DSH_SHARED_TEXTURE_PRESENT_OK. Any other
 * refusal (the 128-request limit, invalid frame fields, a send timeout) returns DSH_SHARED_TEXTURE_PRESENT_REJECTED and
 * leaves the connection usable.
 */
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <vector>
#include "addon-support.h"
#include "hop-transport.h"
#include "shared-texture-sink.h"

namespace {
using addon::property;
using addon::string;
using Clock = std::chrono::steady_clock;

/** Unsettled requests one connection admits. */
constexpr size_t kMaxPending = 128;
/** Longest delivery deadline a request may set. */
constexpr uint32_t kMaxTimeoutMs = 30000;
constexpr const char* kTimedOut = "Desktop shared-texture request timed out";
constexpr const char* kSettledEarly = "Desktop shared-texture request settled before delivery";
constexpr const char* kDisconnected = "Desktop shared-texture ingress disconnected";
constexpr const char* kClosedByHost = "Desktop shared-texture connection closed";
constexpr const char* kDeliveryFailed = "Desktop shared-texture delivery failed";
constexpr const char* kNotOpen = "Desktop shared-texture connection is closed";
constexpr const char* kLimit = "Shared-texture presentation limit reached";
constexpr const char* kInvalidFrame = "Expected a nonzero texture handle, dimensions of 1-8192, a bgra or rgba pixel format, at most "
  "4096 bytes of metadata, and a timeout of 1-30000 ms";

/** Request identifiers are unique across every connection of the process. */
std::atomic<uint64_t> next_request_id{1};

/** One presentation as its caller describes it; `metadata` points into the caller's buffer for the `present` call. */
struct Frame {
  uint64_t handle = 0;
  uint32_t width = 0, height = 0, timeout_ms = 0;
  uint8_t pixel_format = 0;
  std::string_view metadata;
};

bool valid_frame(const Frame& frame) {
  return frame.handle != 0 && frame.width >= 1 && frame.width <= dstx::kMaxDimension && frame.height >= 1
    && frame.height <= dstx::kMaxDimension && frame.timeout_ms >= 1 && frame.timeout_ms <= kMaxTimeoutMs
    && (frame.pixel_format == dstx::DSTX_PIXEL_BGRA || frame.pixel_format == dstx::DSTX_PIXEL_RGBA)
    && frame.metadata.size() <= dstx::kMaxMetadataBytes;
}

struct Pending {
  dsh_shared_texture_callbacks_v2 callbacks{};
  /** Local to the Host: Main never sees it, and its expiry fails only the delivery while the slot stays held. */
  Clock::time_point deadline;
  /** The request left the Host: its send succeeded or a reply arrived. An unsent request belongs to its `present` call. */
  bool sent = false;
  bool delivered = false;
};

/** One completion to report after the state lock is released. */
struct Completion {
  dsh_shared_texture_callbacks_v2 callbacks{};
  bool settled = false;   // false: delivered
  bool failed = false;    // delivered with `error`
  std::string error;
  bool invalidated = false;
};

class Connection {
 public:
  explicit Connection(std::unique_ptr<hop::Transport> transport) : transport_(std::move(transport)) {
    sink.magic = DSH_SHARED_TEXTURE_SINK_MAGIC;
    sink.version = DSH_SHARED_TEXTURE_SINK_VERSION;
    sink.ctx = this;
    sink.retain = [](void* ctx) { static_cast<Connection*>(ctx)->retain(); };
    sink.release = [](void* ctx) { static_cast<Connection*>(ctx)->release(); };
    sink.present = present_from_sink;
  }

  ~Connection() {
    if (!reader_.joinable()) return;
    if (reader_.get_id() == std::this_thread::get_id()) reader_.detach();
    else reader_.join();
  }

  void retain() { refs_.fetch_add(1, std::memory_order_relaxed); }
  void release() {
    if (refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this;
  }

  /**
   * Admit, send, and track one request.
   * @returns DSH_SHARED_TEXTURE_PRESENT_OK when the request reached Main. Otherwise the request did not leave the Host,
   *   no completion follows, and `error` holds the reason: DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED when the connection
   *   was closed or lost, DSH_SHARED_TEXTURE_PRESENT_REJECTED when only this request was refused.
   */
  int present(const Frame& frame, const dsh_shared_texture_callbacks_v2& callbacks, std::string& error) {
    if (!valid_frame(frame)) { error = kInvalidFrame; return DSH_SHARED_TEXTURE_PRESENT_REJECTED; }
    hop::Transport* transport = nullptr;
    uint64_t request_id = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!open_ || stop_requested_ || broken_) { error = kNotOpen; return DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED; }
      if (pending_.size() >= kMaxPending) { error = kLimit; return DSH_SHARED_TEXTURE_PRESENT_REJECTED; }
      request_id = next_request_id.fetch_add(1);
      Pending entry;
      entry.callbacks = callbacks;
      entry.deadline = Clock::now() + std::chrono::milliseconds(frame.timeout_ms);
      pending_.emplace(request_id, std::move(entry));
      ++sending_;
      transport = transport_.get();
    }
    dstx::DstxPresentHeader header{};
    header.magic = dstx::kDstxMagic;
    header.version = dstx::kDstxVersion;
    header.request_id = request_id;
    header.win32_nt_handle = hop::sends_handle_values() ? frame.handle : 0;
    header.width = frame.width;
    header.height = frame.height;
    header.pixel_format = frame.pixel_format;
    header.metadata_length = static_cast<uint16_t>(frame.metadata.size());
    const auto outcome = transport->send(header, frame.metadata, frame.handle, error);
    const bool sent = outcome == hop::Sent::Sent;
    std::lock_guard<std::mutex> lock(mutex_);
    if (--sending_ == 0) idle_.notify_all();
    // Main is unreachable: the reader settles every request and reports the disconnection.
    if (outcome == hop::Sent::Broken && !broken_) {
      broken_ = true;
      if (transport_) transport_->wake();
    }
    const auto found = pending_.find(request_id);
    // A request a reply already answered reached Main even when its send reported failure.
    if (found == pending_.end() || found->second.sent) return DSH_SHARED_TEXTURE_PRESENT_OK;
    if (!sent) {
      pending_.erase(found);
      if (outcome == hop::Sent::Broken) return DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED;
      // A failed send refuses only this request unless the connection ended meanwhile.
      if (!open_ || stop_requested_ || broken_) {
        error = kNotOpen;
        return DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED;
      }
      return DSH_SHARED_TEXTURE_PRESENT_REJECTED;
    }
    // Sent requests stay tracked even when the connection closed meanwhile: the reader settles them after this send.
    found->second.sent = true;
    if (open_ && found->second.deadline < wait_until_ && transport_) transport_->wake();
    return DSH_SHARED_TEXTURE_PRESENT_OK;
  }

  /** Start the reader thread; it owns one reference and the single thread slot of `events`. */
  void start(napi_threadsafe_function events) {
    events_ = events;
    retain();
    try {
      reader_ = std::thread([this] { read_loop(); });
    } catch (const std::system_error&) {
      release();
      throw;
    }
  }

  /** Stop the reader and settle every request; the JavaScript thread calls it and then receives no `disconnected` event. */
  void close() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_requested_ = true;
      if (transport_) transport_->wake();
    }
    if (reader_.joinable()) reader_.join();
  }

  dsh_shared_texture_sink_v2 sink{};
  bool closed = false;            // JavaScript thread only.
  bool cleanup_registered = false;  // JavaScript thread only.

 private:
  static int present_from_sink(void* ctx, const dsh_shared_texture_frame_v2* input, const dsh_shared_texture_callbacks_v2* callbacks,
                               char* err_buf, size_t err_cap) {
    std::string error;
    Frame frame;
    int result = DSH_SHARED_TEXTURE_PRESENT_REJECTED;
    if (!input || !callbacks || !callbacks->on_delivered || !callbacks->on_settled || (!input->metadata_json && input->metadata_len)
        || input->metadata_len > dstx::kMaxMetadataBytes) {
      error = kInvalidFrame;
    } else {
      frame.handle = input->handle;
      frame.width = input->width;
      frame.height = input->height;
      frame.timeout_ms = input->timeout_ms;
      frame.pixel_format = input->pixel_format;
      if (input->metadata_len) frame.metadata = std::string_view(input->metadata_json, input->metadata_len);
      result = static_cast<Connection*>(ctx)->present(frame, *callbacks, error);
      if (result == DSH_SHARED_TEXTURE_PRESENT_OK) return result;
    }
    if (err_buf && err_cap) std::snprintf(err_buf, err_cap, "%s", error.c_str());
    return result;
  }

  void deliver(Pending& entry, const char* error, std::vector<Completion>& out) {
    entry.delivered = true;
    Completion completion;
    completion.callbacks = entry.callbacks;
    completion.failed = error != nullptr;
    if (error) completion.error = error;
    out.push_back(std::move(completion));
  }

  void settle(std::map<uint64_t, Pending>::iterator found, bool invalidated, std::vector<Completion>& out) {
    Completion completion;
    completion.callbacks = found->second.callbacks;
    completion.settled = true;
    completion.invalidated = invalidated;
    out.push_back(std::move(completion));
    pending_.erase(found);
  }

  /** Apply one reply under the state lock; replies naming no unsettled request are ignored. */
  void apply(const hop::Reply& reply, std::vector<Completion>& out) {
    const auto found = pending_.find(reply.header.request_id);
    if (found == pending_.end()) return;
    auto& entry = found->second;
    entry.sent = true;
    switch (reply.header.kind) {
      case dstx::DSTX_DELIVERED_OK:
        if (!entry.delivered) deliver(entry, nullptr, out);
        return;
      case dstx::DSTX_DELIVERED_ERROR:
        // After the local deadline reported a failure, only the release this flag implies still matters.
        if (!entry.delivered) deliver(entry, reply.error.empty() ? kDeliveryFailed : reply.error.c_str(), out);
        if (reply.header.flags & dstx::kDstxNoReferenceKept) settle(found, false, out);
        return;
      default:
        if (!entry.delivered) deliver(entry, kSettledEarly, out);
        settle(found, reply.header.kind == dstx::DSTX_SETTLED_INVALIDATED, out);
        return;
    }
  }

  void report(std::vector<Completion>& completions) {
    for (auto& completion : completions) {
      if (completion.settled) {
        completion.callbacks.on_settled(completion.callbacks.user_data, completion.invalidated ? 1 : 0);
      } else {
        completion.callbacks.on_delivered(completion.callbacks.user_data, completion.failed ? completion.error.c_str() : nullptr);
      }
    }
    completions.clear();
  }

  void read_loop() {
    std::vector<Completion> completions;
    bool disconnected = false;
    for (;;) {
      int64_t timeout = -1;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stop_requested_) break;
        if (broken_) { disconnected = true; break; }
        const auto now = Clock::now();
        auto nearest = Clock::time_point::max();
        for (auto found = pending_.begin(); found != pending_.end(); ++found) {
          auto& entry = found->second;
          if (!entry.sent || entry.delivered) continue;
          if (entry.deadline <= now) deliver(entry, kTimedOut, completions);
          else nearest = std::min(nearest, entry.deadline);
        }
        wait_until_ = nearest;
        if (nearest != Clock::time_point::max()) {
          timeout = std::chrono::duration_cast<std::chrono::milliseconds>(nearest - now).count() + 1;
        }
      }
      report(completions);
      hop::Reply reply;
      const auto received = transport_->receive(timeout, reply);
      if (received == hop::Received::Disconnected) { disconnected = true; break; }
      if (received != hop::Received::Reply) continue;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        apply(reply, completions);
      }
      report(completions);
    }
    bool stopped = false;
    std::unique_ptr<hop::Transport> transport;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      open_ = false;
      stopped = stop_requested_;
      const char* reason = stopped ? kClosedByHost : kDisconnected;
      // No send starts once `open_` is false; after the sends in progress finish, every remaining request was sent.
      idle_.wait(lock, [this] { return sending_ == 0; });
      for (auto found = pending_.begin(); found != pending_.end();) {
        auto current = found++;
        if (!current->second.delivered) deliver(current->second, reason, completions);
        settle(current, true, completions);
      }
      transport = std::move(transport_);
    }
    // Closing the transport before reporting a settlement is what lets Main tell a request it may still import from
    // one whose handle the owner may already have closed: on Windows a request names its texture only by a handle
    // value, and Main keeps a duplicate only while this end of the pipe stays open.
    transport.reset();
    report(completions);
    // The call fails only while JavaScript is tearing down, when nobody is left to tell.
    if (disconnected && !stopped) napi_call_threadsafe_function(events_, nullptr, napi_tsfn_nonblocking);
    napi_release_threadsafe_function(events_, napi_tsfn_release);
    release();
  }

  std::atomic<uint32_t> refs_{1};
  std::thread reader_;
  napi_threadsafe_function events_ = nullptr;
  std::mutex mutex_;
  std::condition_variable idle_;
  // Guarded by mutex_. The reader alone destroys the transport, after `open_` is false and no send is in progress.
  std::unique_ptr<hop::Transport> transport_;
  std::map<uint64_t, Pending> pending_;
  bool open_ = true;
  bool stop_requested_ = false;
  /** A send found Main unreachable; the reader then ends the connection as if it had observed the disconnection. */
  bool broken_ = false;
  int sending_ = 0;
  /** The reader's next wake-up for a deadline; an earlier deadline wakes it. */
  Clock::time_point wait_until_ = Clock::time_point::max();
};

/** Report the disconnection, the only event a connection gives JavaScript. */
void dispatch(napi_env env, napi_value callback, void*, void*) {
  if (!env || !callback) return;
  napi_value object;
  napi_create_object(env, &object);
  property(env, object, "type", string(env, "disconnected"));
  napi_value global, result;
  napi_get_global(env, &global);
  napi_call_function(env, global, callback, 1, &object, &result);
}

/**
 * Environment teardown closes a connection JavaScript left open. It is registered after the event function, so it runs
 * first and the reader stops before Node-API frees that function.
 */
void environment_cleanup(void* data) {
  auto connection = static_cast<Connection*>(data);
  connection->cleanup_registered = false;
  if (connection->closed) return;
  connection->closed = true;
  connection->close();
}

void close_connection(napi_env env, Connection* connection) {
  if (connection->closed) return;
  connection->closed = true;
  connection->close();
  if (connection->cleanup_registered) {
    connection->cleanup_registered = false;
    napi_remove_env_cleanup_hook(env, environment_cleanup, connection);
  }
}

Connection* connection_argument(napi_env env, napi_value value) {
  void* result = nullptr;
  if (napi_get_value_external(env, value, &result) != napi_ok || !result) {
    napi_throw_type_error(env, nullptr, "Invalid shared-texture connection");
    return nullptr;
  }
  return static_cast<Connection*>(result);
}

napi_value connect(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  std::string endpoint;
  napi_valuetype callback_type;
  if (count != 2 || !addon::string_argument(env, args[0], 512, endpoint) || endpoint.empty()
      || napi_typeof(env, args[1], &callback_type) != napi_ok || callback_type != napi_function) {
    return addon::type_fail(env, "Expected a Desktop ingress endpoint and an event callback");
  }
  std::string error;
  auto transport = hop::connect(endpoint, error);
  if (!transport) return addon::fail(env, error.c_str());
  // This reference belongs to the `native` external.
  auto connection = new Connection(std::move(transport));
  napi_threadsafe_function events = nullptr;
  connection->retain();
  if (napi_create_threadsafe_function(env, args[1], nullptr, string(env, "DSH shared-texture hop"), 0, 1, connection,
      [](napi_env, void* data, void*) { static_cast<Connection*>(data)->release(); }, nullptr, dispatch, &events) != napi_ok) {
    connection->release();
    connection->release();
    return addon::fail(env, "Cannot create the shared-texture event function");
  }
  try {
    connection->start(events);
  } catch (const std::system_error&) {
    napi_release_threadsafe_function(events, napi_tsfn_abort);
    connection->release();
    return addon::fail(env, "Cannot start the shared-texture reader");
  }
  if (napi_add_env_cleanup_hook(env, environment_cleanup, connection) == napi_ok) connection->cleanup_registered = true;
  napi_value native, sink, result;
  if (napi_create_external(env, connection, [](napi_env env, void* data, void*) {
    auto connection = static_cast<Connection*>(data);
    close_connection(env, connection);
    connection->release();
  }, nullptr, &native) != napi_ok) {
    close_connection(env, connection);
    connection->release();
    return addon::fail(env, "Cannot create the shared-texture connection owner");
  }
  connection->retain();
  if (napi_create_external(env, &connection->sink, [](napi_env, void* data, void*) {
    auto sink = static_cast<dsh_shared_texture_sink_v2*>(data);
    sink->release(sink->ctx);
  }, nullptr, &sink) != napi_ok) {
    connection->release();
    close_connection(env, connection);
    return addon::fail(env, "Cannot create the shared-texture sink");
  }
  napi_create_object(env, &result);
  property(env, result, "native", native);
  property(env, result, "sink", sink);
  return result;
}

napi_value close(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) return addon::type_fail(env, "Expected a shared-texture connection");
  auto connection = connection_argument(env, args[0]);
  if (!connection) return nullptr;
  close_connection(env, connection);
  return addon::undefined(env);
}

napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"connect", nullptr, connect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
