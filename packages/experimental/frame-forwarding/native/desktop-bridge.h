/**
 * Native hand-off of received frames to Desktop's `shared-texture-hop.node` through its `dsh_shared_texture_sink_v2`
 * (declared below with the field order and types of Desktop's `shared-texture-sink.h`; a sink of another ABI version
 * is refused). While a sink is attached, every frame event of the receiver is presented from the thread that produced
 * it, and Desktop's callbacks return the frame's credit, so steady-state frames never reach JavaScript; without a sink,
 * frames reach JavaScript as `frame` events. JavaScript attaches the sink with `attachSink(native, rx, sink, timeoutMs)`
 * and supplies the presentation gate with `setDeliverable(native, { connectionId, visible, maxGeneration } | null)`.
 *
 * Per frame, once the receiver still accepts frames of its connection, the frame is marked delivered and then:
 * metadata other than a JSON object with a `requestId` string of 1-512 UTF-16 units and `generation` and `revision`
 * integers from 0 to 2^53-1 releases the delivery and emits `presentation-error` with source `producer`; a frame of
 * another connection than the deliverable state, while it is invisible or absent, or whose generation exceeds
 * `maxGeneration` releases the delivery silently; otherwise the frame is presented with the producer fields plus `rx`,
 * `connectionId`, `frameId`, `width`, and `height` as metadata. When `present` returns nonzero, the bridge releases the
 * delivery and emits `presentation-error` with source `presentation`. When it returns
 * `DSH_SHARED_TEXTURE_PRESENT_REJECTED`, Desktop refused only that frame (its presentation limit, invalid frame fields,
 * a send timeout), so the sink stays attached and presents later frames; any other nonzero result means the sink lost
 * its connection, and the bridge detaches that sink when it is still attached, so later frames reach JavaScript until
 * it attaches a sink again. A failed delivery emits `presentation-error`; a released
 * settlement releases the delivery; an invalidated settlement emits `presentation-invalidated`, then stops the receiver
 * and the frame's connection before releasing the delivery, so the notice is queued before stopping lets the listener
 * release the dispatcher, and the producer never regains that texture's credit. `presentation-error` text is
 * JSON: `{ "source": "producer" | "presentation", "requestId"?: string, "error": string }`.
 *
 * Threads and locks: frame events reach the bridge from connection threads that hold no receiver, connection, or
 * ledger lock. The bridge lock guards only the attached sink with its immutable attach parameters, and the
 * deliverable state, and is never held while calling into the sink or the receiver; Desktop's callbacks may run on the
 * hop's reader thread before `present` returns, or on the calling thread, so each request's callback data is complete
 * before the call. The bridge retains a sink once per attach and releases it when it is replaced, detached, or the
 * bridge is destroyed and no frame being presented still shares it.
 *
 * Lifetime: the bridge is a member of the receiver and releases its sink reference when the receiver is destroyed.
 * Each presented request holds a strong reference to the receiver until its settlement, so callbacks that arrive
 * after `close`, after JavaScript drops the receiver, or during environment teardown act on a live receiver: `stop`
 * and `release` stay safe after close, and events are discarded once the dispatcher closed. The last reference can
 * drop on the hop's reader thread only after the receiver's listener thread was joined (the completion holder keeps a
 * reference until then, and the environment cleanup hook joins it during teardown), and that thread joins every
 * connection thread, so destroying the receiver there joins no thread. Callbacks run code of this addon, which Node
 * keeps loaded for the life of the process.
 */
#ifndef DSH_FRAME_FORWARDING_DESKTOP_BRIDGE_H
#define DSH_FRAME_FORWARDING_DESKTOP_BRIDGE_H

#include <node_api.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

extern "C" {
#define DSH_SHARED_TEXTURE_SINK_MAGIC 0x44535453u
#define DSH_SHARED_TEXTURE_SINK_VERSION 2u
/** `present` results: the request left the Host; Desktop refused only this frame; the sink lost its connection. */
#define DSH_SHARED_TEXTURE_PRESENT_OK 0
#define DSH_SHARED_TEXTURE_PRESENT_REJECTED 1
#define DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED 2
typedef struct dsh_shared_texture_callbacks_v2 {
  void* user_data;
  void (*on_delivered)(void* user_data, const char* error);
  void (*on_settled)(void* user_data, int invalidated);
} dsh_shared_texture_callbacks_v2;
typedef struct dsh_shared_texture_frame_v2 {
  uintptr_t handle;
  uint32_t width;
  uint32_t height;
  uint32_t timeout_ms;
  uint8_t pixel_format;
  const char* metadata_json;
  size_t metadata_len;
} dsh_shared_texture_frame_v2;
typedef struct dsh_shared_texture_sink_v2 {
  uint32_t magic;
  uint32_t version;
  void* ctx;
  void (*retain)(void* ctx);
  void (*release)(void* ctx);
  int (*present)(void* ctx, const dsh_shared_texture_frame_v2* frame, const dsh_shared_texture_callbacks_v2* cb,
                 char* err_buf, size_t err_cap);
} dsh_shared_texture_sink_v2;
}

namespace dsh_frame_forwarding {
namespace desktop_bridge {

/** Frames JavaScript lets the bridge present: those of `connection` up to `max_generation` while `visible`. */
struct Deliverable {
  uint64_t connection = 0;
  bool visible = false;
  uint64_t max_generation = 0;
};

/** Validated producer fields of one frame's metadata. */
struct ProducerFrame {
  /** `requestId` as a JSON string literal. */
  std::string request_id;
  uint64_t generation = 0, revision = 0;
};

/**
 * Validate producer metadata as `JSON.parse` followed by the Host's producer-frame schema would.
 * @returns Empty when valid, otherwise the reason.
 */
std::string parse_producer_frame(const char* text, ProducerFrame& frame);
/** @returns `text`, read as UTF-8 with invalid sequences replaced, as the JSON string literal `JSON.stringify` writes. */
std::string json_string(const std::string& text);
/** @returns `presentation-error` event text. `request_id` is a JSON string literal or empty. */
std::string error_text(const char* source, const std::string& request_id, const std::string& error);

/** One attach: a sink reference and the attach parameters, which never change; releases the reference when destroyed. */
struct AttachedSink {
  dsh_shared_texture_sink_v2* sink;
  /** `rx` as a JSON string literal. */
  std::string rx_json;
  uint32_t timeout_ms;
  /** Retain `sink`. */
  AttachedSink(dsh_shared_texture_sink_v2* sink, const std::string& rx, uint32_t timeout_ms);
  AttachedSink(const AttachedSink&) = delete;
  AttachedSink& operator=(const AttachedSink&) = delete;
  ~AttachedSink() { if (sink) sink->release(sink->ctx); }
};

/** The attached sink, the receiver, and the presentation gate, taken for one frame. */
struct Lease {
  std::shared_ptr<const AttachedSink> attached;
  std::shared_ptr<void> owner;
  bool has_deliverable = false;
  Deliverable deliverable;
};

/** The attached sink and presentation gate of one receiver. */
class Bridge {
 public:
  Bridge() = default;
  Bridge(const Bridge&) = delete;
  Bridge& operator=(const Bridge&) = delete;
  /** Retain `sink` and attach it, releasing a previously attached one once no frame being presented shares it. */
  void attach(dsh_shared_texture_sink_v2* sink, const std::string& rx, uint32_t timeout_ms, std::weak_ptr<void> owner);
  /** Replace the presentation gate; null closes it. */
  void set_deliverable(const Deliverable* state);
  /** @returns False when no sink is attached or the receiver is gone; otherwise `lease` shares the attached sink. */
  bool lease(Lease& lease);
  /** Detach `sink` when it is still the attached sink; its reference is released once no frame shares it. */
  void detach(const dsh_shared_texture_sink_v2* sink);

 private:
  std::mutex mutex_;
  std::shared_ptr<const AttachedSink> attached_;
  std::weak_ptr<void> owner_;
  bool has_deliverable_ = false;
  Deliverable deliverable_;
};

/** `attachSink(native, rx, sink, timeoutMs)` after the receiver holder is resolved. */
napi_value attach(napi_env env, const napi_value* args, Bridge& bridge, std::weak_ptr<void> owner);
/** `setDeliverable(native, state)` after the receiver holder is resolved. */
napi_value set_deliverable(napi_env env, napi_value state, Bridge& bridge);
napi_value throw_error(napi_env env, const char* text);

/** The receiver's shared owner held by a `native` external; throws and returns null for another value. */
template <class Receiver> std::shared_ptr<Receiver>* holder(napi_env env, napi_value value) {
  void* result = nullptr;
  if (napi_get_value_external(env, value, &result) != napi_ok || !result) {
    napi_throw_type_error(env, nullptr, "Invalid native receiver");
    return nullptr;
  }
  return static_cast<std::shared_ptr<Receiver>*>(result);
}

template <class Receiver, Bridge Receiver::*member> napi_value attach_sink(napi_env env, napi_callback_info info) {
  napi_value args[4]; size_t count = 4;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 4) return throw_error(env, "Expected receiver, rx, sink and timeout");
  auto owner = holder<Receiver>(env, args[0]);
  if (!owner) return nullptr;
  return attach(env, args + 1, (*owner).get()->*member, std::weak_ptr<void>(*owner));
}

template <class Receiver, Bridge Receiver::*member> napi_value set_deliverable(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) return throw_error(env, "Expected receiver and deliverable state");
  auto owner = holder<Receiver>(env, args[0]);
  if (!owner) return nullptr;
  return set_deliverable(env, args[1], (*owner).get()->*member);
}

/** One presented frame: the callback data Desktop passes back until its settlement. */
template <class Receiver, class Event> struct Request {
  std::shared_ptr<Receiver> receiver;
  uint64_t delivery, connection;
  std::string request_id, adapters;
  /** The receiver connection that delivered the frame. */
  decltype(Event::source) source;
};

template <class Event> void presentation_error(const decltype(Event::source)& source, std::string text) {
  // Desktop can answer on its own thread. Charge the frame's connection, never the receiver's current producer.
  if (auto connection = source.lock()) {
    auto event = new Event; event->type = "presentation-error"; event->text = std::move(text);
    connection->emit(event);
  }
}

template <class Receiver, class Event> void on_delivered(void* data, const char* error) {
  if (!error) return;
  auto request = static_cast<Request<Receiver, Event>*>(data);
  presentation_error<Event>(request->source,
    error_text("presentation", request->request_id, "Native frame transfer failed (" + request->adapters + "): " + error));
}

template <class Receiver, class Event> void on_settled(void* data, int invalidated) {
  std::unique_ptr<Request<Receiver, Event>> request(static_cast<Request<Receiver, Event>*>(data));
  auto& receiver = *request->receiver;
  if (invalidated) {
    // Stopping lets the listener release the dispatcher, which would drop a notice emitted afterwards.
    auto event = new Event; event->connection = request->connection;
    event->type = "presentation-invalidated"; event->text = "Desktop invalidated a presented frame"; receiver.emit(event);
    // The channel and the frame's connection stop first, so releasing the delivery returns no credit for a texture
    // Desktop may still reference. A concurrent stop of the receiver may still be ending that connection.
    receiver.stop();
    if (auto connection = request->source.lock()) connection->stop();
  }
  receiver.release(request->delivery);
}

/**
 * Present a `frame` event through the attached sink.
 * @returns False when the event is not a frame or no sink is attached, so the caller dispatches it to JavaScript;
 *   true after the bridge took ownership of the event.
 */
template <class Receiver, class Event> bool take_frame(Receiver& receiver, Bridge& bridge, Event* event) {
  if (event->type != "frame") return false;
  Lease lease;
  if (!bridge.lease(lease)) return false;
  std::unique_ptr<Event> frame(event);
  {
    std::lock_guard<std::mutex> lock(frame->ledger->mutex);
    if (!frame->ledger->accepting_frames) return true;
    frame->ledger->frames.at(frame->delivery).delivered = true;
    frame->delivered = true;
  }
  const auto delivery = frame->delivery, connection = frame->connection;
  const auto& packet = frame->packet;
  ProducerFrame producer;
  const auto invalid = parse_producer_frame(packet.text, producer);
  if (!invalid.empty()) {
    receiver.release(delivery);
    presentation_error<Event>(frame->source, error_text("producer", {}, "Invalid native frame metadata: " + invalid));
    return true;
  }
  const auto& gate = lease.deliverable;
  if (!lease.has_deliverable || !gate.visible || gate.connection != connection || producer.generation > gate.max_generation) {
    receiver.release(delivery);
    return true;
  }
  const auto adapters = "source=" + frame->adapter + ", presentation="
    + (frame->presentation_adapter.empty() ? std::string("IOSurface") : frame->presentation_adapter);
  // Desktop presents at most 8192 pixels per side; a larger frame fails without detaching the sink.
  if (packet.width > 8192 || packet.height > 8192) {
    receiver.release(delivery);
    presentation_error<Event>(frame->source, error_text("presentation", producer.request_id,
      "Native frame transfer failed (" + adapters + "): frame exceeds 8192 pixels per side"));
    return true;
  }
  const auto& attached = *lease.attached;
  // At most 3072 bytes of request identifier, 128 of rx, and 200 of names and numbers: within the 4096-byte limit.
  const auto metadata = "{\"requestId\":" + producer.request_id + ",\"generation\":" + std::to_string(producer.generation)
    + ",\"revision\":" + std::to_string(producer.revision) + ",\"rx\":" + attached.rx_json + ",\"connectionId\":"
    + std::to_string(connection) + ",\"frameId\":" + std::to_string(packet.frame_id) + ",\"width\":"
    + std::to_string(packet.width) + ",\"height\":" + std::to_string(packet.height) + "}";
  const dsh_shared_texture_frame_v2 texture{frame->resource, packet.width, packet.height, attached.timeout_ms, 0,
    metadata.data(), metadata.size()};
  auto request = new Request<Receiver, Event>{std::static_pointer_cast<Receiver>(lease.owner), delivery, connection, producer.request_id, adapters,
    frame->source};
  const dsh_shared_texture_callbacks_v2 callbacks{request, on_delivered<Receiver, Event>, on_settled<Receiver, Event>};
  char reason[512] = {};
  const int status = attached.sink->present(attached.sink->ctx, &texture, &callbacks, reason, sizeof(reason));
  if (status == DSH_SHARED_TEXTURE_PRESENT_OK) return true;
  delete request;
  receiver.release(delivery);
  // A rejected frame leaves the sink usable. Any other failure means it lost its connection: the sink is detached, and
  // this frame's share of it dropped, before the error is reported.
  if (status != DSH_SHARED_TEXTURE_PRESENT_REJECTED) {
    bridge.detach(attached.sink);
    lease.attached.reset();
  }
  presentation_error<Event>(frame->source, error_text("presentation", producer.request_id,
    "Native frame transfer failed (" + adapters + "): " + (reason[0] ? reason : "Desktop refused the frame")));
  return true;
}

}  // namespace desktop_bridge
}  // namespace dsh_frame_forwarding

#endif  // DSH_FRAME_FORWARDING_DESKTOP_BRIDGE_H
