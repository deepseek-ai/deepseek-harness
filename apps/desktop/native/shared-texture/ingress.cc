/**
 * Electron Main's shared-texture ingress: one endpoint per Desktop Host that accepts DSTX v3 present requests only from
 * that Host's process, hands each frame with a Main-local texture handle to JavaScript, and writes the replies
 * JavaScript issues. The platform transport lives in `ingress-darwin.cc` (Mach ports) and `ingress-win32.cc` (named
 * pipe); this file owns the Node-API delivery queue and lifecycle. On Windows the addon also reads the adapter of a
 * Main-local shared texture. It carries no frame semantics beyond the protocol limits and depends on Node-API 8 only.
 */
#include <node_api.h>
#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "addon-support.h"
#include "ingress-transport.h"

namespace {
using addon::property;
using addon::string;

/** Frames waiting for the JavaScript thread; a frame beyond them is rejected with `no_reference_kept`. */
constexpr size_t kDeliveryCapacity = 32;

struct Ingress : ingress::Handler {
  napi_env env = nullptr;
  std::unique_ptr<ingress::Transport> transport;
  std::atomic<bool> stopped{false};
  std::thread reader;
  const char* terminal_error = nullptr;  // Written by the reader, read on the JavaScript thread after joining it.
  napi_threadsafe_function deliver = nullptr;
  napi_threadsafe_function done = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  std::vector<napi_deferred> close_deferreds;
  napi_ref keep = nullptr;
  bool closing = false, ended = false, finished = false, environment_closing = false;

  void stop() {
    stopped = true;
    if (transport) transport->stop();
  }

  ingress::Queued frame(ingress::Frame& frame) override {
    auto queued = new ingress::Frame(std::move(frame));
    const auto status = napi_call_threadsafe_function(deliver, queued, napi_tsfn_nonblocking);
    if (status == napi_ok) return ingress::Queued::Accepted;
    frame = std::move(*queued);
    delete queued;
    return status == napi_queue_full ? ingress::Queued::Full : ingress::Queued::Closed;
  }

  void read_loop() {
    terminal_error = transport->run(*this);
    stopped = true;
    napi_release_threadsafe_function(deliver, napi_tsfn_release);
    napi_call_threadsafe_function(done, nullptr, napi_tsfn_nonblocking);
  }
};

using Holder = std::shared_ptr<Ingress>;

void call(napi_env env, napi_value callback, napi_value event) {
  napi_value global, result;
  napi_get_global(env, &global);
  napi_call_function(env, global, callback, 1, &event, &result);
}

napi_value frame_event(napi_env env, const ingress::Frame& frame) {
  napi_value handle = addon::handle_buffer(env, frame.handle);
  if (!handle) return nullptr;
  napi_value event;
  napi_create_object(env, &event);
  property(env, event, "type", string(env, "frame"));
  property(env, event, "requestId", addon::number(env, static_cast<double>(frame.header.request_id)));
  property(env, event, "handle", handle);
  property(env, event, "width", addon::number(env, frame.header.width));
  property(env, event, "height", addon::number(env, frame.header.height));
  property(env, event, "pixelFormat", string(env, frame.header.pixel_format == dstx::DSTX_PIXEL_RGBA ? "rgba" : "bgra"));
  property(env, event, "metadata", string(env, frame.metadata));
  return event;
}

/**
 * Hand one frame to JavaScript, which then owns its handle and returns it through `release`. Node-API invokes this
 * with a null environment for frames still queued when the function is torn down.
 */
void dispatch(napi_env env, napi_value callback, void* context, void* data) {
  std::unique_ptr<ingress::Frame> frame(static_cast<ingress::Frame*>(data));
  auto& self = **static_cast<Holder*>(context);
  if (!env || !callback || self.closing) {
    ingress::release_handle(frame->handle);
    return;
  }
  napi_value event = frame_event(env, *frame);
  if (!event) {
    // JavaScript never saw this frame, so Main keeps no reference and the Host settles it as released.
    addon::clear_exception(env);
    ingress::release_handle(frame->handle);
    if (self.transport) {
      const char text[] = "Cannot allocate a shared-texture handle buffer";
      self.transport->reply(frame->header.request_id, dstx::DSTX_DELIVERED_ERROR, dstx::kDstxNoReferenceKept, text, sizeof(text) - 1);
    }
    return;
  }
  call(env, callback, event);
}

void settle_close(Ingress* self) {
  if (!self->environment_closing) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(self->env, &scope) == napi_ok) {
      for (auto deferred : self->close_deferreds) napi_resolve_deferred(self->env, deferred, addon::undefined(self->env));
      napi_close_handle_scope(self->env, scope);
    }
  }
  self->close_deferreds.clear();
  if (self->keep) { napi_delete_reference(self->env, self->keep); self->keep = nullptr; }
}

/** Runs on the JavaScript thread after the reader exits: join it, drop the endpoint, and let queued frames drain. */
void finish_on_main(Ingress* self, napi_value callback = nullptr) {
  if (self->finished) return;
  self->finished = true;
  if (self->reader.joinable()) self->reader.join();
  self->transport.reset();
  napi_release_threadsafe_function(self->deliver, napi_tsfn_abort);
  self->ended = true;
  if (callback && !self->closing && self->terminal_error) {
    napi_value event;
    napi_create_object(self->env, &event);
    property(self->env, event, "type", string(self->env, "error"));
    property(self->env, event, "text", string(self->env, self->terminal_error));
    call(self->env, callback, event);
  }
  settle_close(self);
  napi_release_threadsafe_function(self->done, napi_tsfn_release);
}

void holder_finalized(napi_env, void* data, void*) { delete static_cast<Holder*>(data); }

void done_finalized(napi_env, void* data, void*) {
  auto holder = static_cast<Holder*>(data);
  if ((*holder)->cleanup) napi_remove_async_cleanup_hook((*holder)->cleanup);
  delete holder;
}

Ingress* ingress_argument(napi_env env, napi_value value) {
  void* result = nullptr;
  if (napi_get_value_external(env, value, &result) != napi_ok || !result) {
    napi_throw_type_error(env, nullptr, "Invalid shared-texture ingress");
    return nullptr;
  }
  return static_cast<Holder*>(result)->get();
}

napi_value open(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  double pid = 0;
  napi_valuetype callback_type;
  if (count != 2 || !addon::integer_argument(env, args[0], 1, UINT32_MAX, pid)
      || napi_typeof(env, args[1], &callback_type) != napi_ok || callback_type != napi_function) {
    return addon::fail(env, "Expected the Desktop Host process identifier and an event callback");
  }
  std::string error;
  auto transport = ingress::open_transport(static_cast<uint32_t>(pid), error);
  if (!transport) return addon::fail(env, error.c_str());
  auto value = std::make_shared<Ingress>();
  value->env = env;
  value->transport = std::move(transport);
  // The delivery function keeps the ingress alive until Node-API has drained or freed every queued frame; its queue
  // limit is the delivery capacity. Its two threads are the reader, which releases it on exit, and `finish_on_main`,
  // which aborts it.
  auto deliver_holder = new Holder(value);
  if (napi_create_threadsafe_function(env, args[1], nullptr, string(env, "DSH shared-texture ingress"), kDeliveryCapacity, 2,
      deliver_holder, holder_finalized, deliver_holder, dispatch, &value->deliver) != napi_ok) {
    delete deliver_holder;
    return addon::fail(env, "Cannot create the shared-texture delivery function");
  }
  auto done_holder = new Holder(value);
  if (napi_create_threadsafe_function(env, args[1], nullptr, string(env, "DSH shared-texture ingress completion"), 0, 1, done_holder,
      done_finalized, value.get(),
      [](napi_env env, napi_value callback, void* context, void*) { finish_on_main(static_cast<Ingress*>(context), env ? callback : nullptr); },
      &value->done) != napi_ok) {
    napi_release_threadsafe_function(value->deliver, napi_tsfn_abort);
    delete done_holder;
    return addon::fail(env, "Cannot create the shared-texture completion function");
  }
  // Registered after both functions, so environment teardown stops the reader before Node-API frees them.
  if (napi_add_async_cleanup_hook(env, [](napi_async_cleanup_hook_handle, void* data) {
    auto self = static_cast<Ingress*>(data);
    self->environment_closing = true;
    self->closing = true;
    self->stop();
    finish_on_main(self);
  }, value.get(), &value->cleanup) != napi_ok) {
    value->environment_closing = true;
    value->stop();
    finish_on_main(value.get());
    return addon::fail(env, "Cannot register shared-texture ingress cleanup");
  }
  napi_value external, result;
  auto holder = std::make_unique<Holder>(value);
  if (napi_create_external(env, holder.get(), [](napi_env, void* data, void*) {
    std::unique_ptr<Holder> holder(static_cast<Holder*>(data));
    (*holder)->stop();
  }, nullptr, &external) != napi_ok) {
    value->environment_closing = true;
    value->stop();
    finish_on_main(value.get());
    return addon::fail(env, "Cannot create the shared-texture ingress owner");
  }
  holder.release();
  napi_create_object(env, &result);
  property(env, result, "native", external);
  property(env, result, "endpoint", string(env, value->transport->endpoint()));
  auto raw = value.get();
  raw->reader = std::thread([raw] { raw->read_loop(); });
  return result;
}

/** Stop the ingress; every call returns a promise that settles once the endpoint is gone. */
napi_value close(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) return addon::fail(env, "Expected a shared-texture ingress");
  auto self = ingress_argument(env, args[0]);
  if (!self) return nullptr;
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return addon::fail(env, "Cannot create the shared-texture ingress close operation");
  if (self->ended) {
    napi_resolve_deferred(env, deferred, addon::undefined(env));
    return promise;
  }
  if (!self->keep && napi_create_reference(env, args[0], 1, &self->keep) != napi_ok) {
    napi_reject_deferred(env, deferred, string(env, "Cannot retain the shared-texture ingress close operation"));
    return promise;
  }
  self->close_deferreds.push_back(deferred);
  self->closing = true;
  self->stop();
  return promise;
}

/** Write one reply to the Host; dropped silently while no Host is reachable or after close. */
napi_value reply(napi_env env, napi_callback_info info) {
  napi_value args[5];
  size_t count = 5;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  double request_id = 0, kind = 0;
  bool no_reference_kept = false;
  std::string error;
  size_t error_length = 0;
  if (count != 5 || !addon::integer_argument(env, args[1], 1, static_cast<double>(dstx::kMaxRequestId), request_id)
      || !addon::integer_argument(env, args[2], dstx::DSTX_DELIVERED_OK, dstx::DSTX_SETTLED_INVALIDATED, kind)
      || napi_get_value_bool(env, args[3], &no_reference_kept) != napi_ok
      || napi_get_value_string_utf8(env, args[4], nullptr, 0, &error_length) != napi_ok) {
    return addon::type_fail(env, "Expected a shared-texture ingress, a request identifier, a reply kind, a reference flag, and an error text");
  }
  if (no_reference_kept && kind != dstx::DSTX_DELIVERED_ERROR) return addon::type_fail(env, "Only a delivery error can keep no reference");
  auto self = ingress_argument(env, args[0]);
  if (!self) return nullptr;
  error.resize(error_length);
  napi_get_value_string_utf8(env, args[4], &error[0], error_length + 1, &error_length);
  if (self->closing || !self->transport) return addon::undefined(env);
  const auto length = dstx::utf8_prefix(error.data(), error_length, dstx::kMaxErrorBytes);
  self->transport->reply(static_cast<uint64_t>(request_id), static_cast<uint32_t>(kind),
    no_reference_kept ? dstx::kDstxNoReferenceKept : 0, error.data(), length);
  return addon::undefined(env);
}

/** Return a JavaScript-owned handle delivered by a `frame` event. */
napi_value release(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint64_t handle = 0;
  if (count != 1 || !addon::handle_argument(env, args[0], handle)) return addon::type_fail(env, "Expected an eight-byte shared-texture handle");
  if (handle) ingress::release_handle(handle);
  return addon::undefined(env);
}

/** The LUID text of the adapter behind a Main-local shared texture handle, or null; see `ingress::adapter_luid`. */
napi_value adapter_luid(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint64_t handle = 0;
  if (count != 1 || !addon::handle_argument(env, args[0], handle) || !handle) {
    return addon::type_fail(env, "Expected a nonzero eight-byte texture handle");
  }
  std::string luid;
  if (!ingress::adapter_luid(handle, luid)) return addon::null(env);
  return string(env, luid);
}

napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reply", nullptr, reply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"adapterLuid", nullptr, adapter_luid, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
