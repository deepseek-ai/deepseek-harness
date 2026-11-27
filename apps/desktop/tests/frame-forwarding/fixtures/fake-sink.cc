/**
 * Test-only Node-API addon standing in for Desktop's `shared-texture-hop.node` sink: it implements the
 * `dsh_shared_texture_sink_v2` ABI of Desktop's `shared-texture-sink.h`, records each presentation under an identifier
 * of its own (its position among accepted presentations, from "1"), and lets the test answer each one with a delivery
 * and a settlement from a native thread, refuse the next presentation with a chosen result, answer presentations inside
 * `present`, and read the sink's reference counts. On Windows it also names the default hardware adapter the way the
 * receiver does.
 */
#include <node_api.h>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include "shared-texture-sink.h"
#if defined(_WIN32)
#define NOMINMAX
#include <d3d11.h>
#include <dxgi.h>
#endif

namespace {

struct Presented {
  std::string id, metadata;
  uintptr_t handle = 0;
  uint32_t width = 0, height = 0, timeout_ms = 0;
  uint8_t pixel_format = 0;
  dsh_shared_texture_callbacks_v2 callbacks{};
};

struct FakeSink {
  dsh_shared_texture_sink_v2 sink{};
  std::atomic<int> refs{1}, retains{0}, releases{0};
  std::mutex mutex;
  std::vector<Presented> presented;
  /** Requests that have not settled, by identifier. */
  std::map<std::string, dsh_shared_texture_callbacks_v2> pending;
  std::string refuse;
  /** Result of the refused presentation: 1 rejects only that frame, 2 reports a lost connection. */
  int refuse_code = 1;
  bool inline_answer = false;
};

napi_value fail(napi_env env, const char* text) { napi_throw_error(env, nullptr, text); return nullptr; }
napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
napi_value number(napi_env env, double value) { napi_value result; napi_create_double(env, value, &result); return result; }
napi_value text(napi_env env, const std::string& value) { napi_value result; napi_create_string_utf8(env, value.data(), value.size(), &result); return result; }
void property(napi_env env, napi_value object, const char* name, napi_value value) { napi_set_named_property(env, object, name, value); }
std::string string_of(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string result(length, '\0');
  napi_get_value_string_utf8(env, value, &result[0], length + 1, &length);
  return result;
}
FakeSink* fake_of(napi_env env, napi_value value) {
  void* data = nullptr;
  napi_get_value_external(env, value, &data);
  return static_cast<FakeSink*>(data);
}

void retain(void* ctx) {
  auto fake = static_cast<FakeSink*>(ctx);
  fake->retains++; fake->refs++;
}
void release(void* ctx) {
  auto fake = static_cast<FakeSink*>(ctx);
  fake->releases++; fake->refs--;
}
int present(void* ctx, const dsh_shared_texture_frame_v2* frame, const dsh_shared_texture_callbacks_v2* callbacks, char* err_buf, size_t err_cap) {
  auto fake = static_cast<FakeSink*>(ctx);
  Presented entry;
  if (frame->metadata_len) entry.metadata.assign(frame->metadata_json, frame->metadata_len);
  entry.handle = frame->handle; entry.width = frame->width; entry.height = frame->height;
  entry.timeout_ms = frame->timeout_ms; entry.pixel_format = frame->pixel_format; entry.callbacks = *callbacks;
  bool inline_answer;
  {
    std::lock_guard<std::mutex> lock(fake->mutex);
    if (!fake->refuse.empty()) {
      std::snprintf(err_buf, err_cap, "%s", fake->refuse.c_str());
      fake->refuse.clear();
      return fake->refuse_code;
    }
    entry.id = std::to_string(fake->presented.size() + 1);
    fake->presented.push_back(entry);
    inline_answer = fake->inline_answer;
    if (!inline_answer) fake->pending.emplace(entry.id, *callbacks);
  }
  // Desktop's hop may answer on the presenting thread before `present` returns.
  if (inline_answer) {
    callbacks->on_delivered(callbacks->user_data, nullptr);
    callbacks->on_settled(callbacks->user_data, 0);
  }
  return 0;
}

/** `create({ magic?, version? })`: `{ sink, native }`; `sink` owns one reference, as Desktop's external does. */
napi_value create(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto fake = new FakeSink;
  fake->sink = {DSH_SHARED_TEXTURE_SINK_MAGIC, DSH_SHARED_TEXTURE_SINK_VERSION, fake, retain, release, present};
  if (count == 1) {
    napi_valuetype type; napi_typeof(env, arg, &type);
    if (type == napi_object) {
      bool has = false; napi_value value; uint32_t field = 0;
      if (napi_has_named_property(env, arg, "magic", &has) == napi_ok && has) {
        napi_get_named_property(env, arg, "magic", &value); napi_get_value_uint32(env, value, &field); fake->sink.magic = field;
      }
      if (napi_has_named_property(env, arg, "version", &has) == napi_ok && has) {
        napi_get_named_property(env, arg, "version", &value); napi_get_value_uint32(env, value, &field); fake->sink.version = field;
      }
    }
  }
  napi_value result, sink, native;
  // The test process ends before the fake would be freed; its callbacks stay valid for late settlements.
  napi_create_external(env, &fake->sink, [](napi_env, void* data, void*) {
    auto sink = static_cast<dsh_shared_texture_sink_v2*>(data);
    sink->release(sink->ctx);
  }, nullptr, &sink);
  napi_create_external(env, fake, nullptr, nullptr, &native);
  napi_create_object(env, &result);
  property(env, result, "sink", sink);
  property(env, result, "native", native);
  return result;
}

/** `presented(native)`: every accepted presentation in order, each with the identifier the fake assigned it. */
napi_value presented(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto fake = fake_of(env, arg);
  std::lock_guard<std::mutex> lock(fake->mutex);
  napi_value result;
  napi_create_array_with_length(env, fake->presented.size(), &result);
  for (size_t index = 0; index < fake->presented.size(); ++index) {
    const auto& entry = fake->presented[index];
    napi_value object, handle;
    napi_create_object(env, &object);
    property(env, object, "id", text(env, entry.id));
    property(env, object, "metadata", text(env, entry.metadata));
    uint64_t raw = entry.handle;
    napi_create_buffer_copy(env, sizeof(raw), &raw, nullptr, &handle);
    property(env, object, "handle", handle);
    property(env, object, "width", number(env, entry.width));
    property(env, object, "height", number(env, entry.height));
    property(env, object, "timeoutMs", number(env, entry.timeout_ms));
    property(env, object, "pixelFormat", number(env, entry.pixel_format));
    napi_set_element(env, result, static_cast<uint32_t>(index), object);
  }
  return result;
}

/** `answer(native, id, kind, value)`: `delivered` with an error string or null, or `settled` with `invalidated`. */
napi_value answer(napi_env env, napi_callback_info info) {
  napi_value args[4]; size_t count = 4;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto fake = fake_of(env, args[0]);
  const auto id = string_of(env, args[1]), kind = string_of(env, args[2]);
  dsh_shared_texture_callbacks_v2 callbacks;
  {
    std::lock_guard<std::mutex> lock(fake->mutex);
    const auto found = fake->pending.find(id);
    if (found == fake->pending.end()) return fail(env, "No unsettled presentation has this identifier");
    callbacks = found->second;
    if (kind == "settled") fake->pending.erase(found);
  }
  napi_valuetype type; napi_typeof(env, args[3], &type);
  std::string error;
  bool flag = false;
  if (kind == "delivered" && type == napi_string) error = string_of(env, args[3]);
  if (kind == "settled") napi_get_value_bool(env, args[3], &flag);
  const bool failed = kind == "delivered" && type == napi_string;
  // The hop's reader thread runs every callback.
  std::thread([&] {
    if (kind == "delivered") callbacks.on_delivered(callbacks.user_data, failed ? error.c_str() : nullptr);
    else callbacks.on_settled(callbacks.user_data, flag ? 1 : 0);
  }).join();
  return undefined(env);
}

/** `refuseNext(native, reason, code = 1)`: the next presentation returns `code` with `reason`. */
napi_value refuse_next(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto fake = fake_of(env, args[0]);
  int32_t code = 1;
  if (count == 3) napi_get_value_int32(env, args[2], &code);
  std::lock_guard<std::mutex> lock(fake->mutex);
  fake->refuse = string_of(env, args[1]);
  fake->refuse_code = code;
  return undefined(env);
}

/** `answerInline(native, enabled)`: answer later presentations with a delivery and a release inside `present`. */
napi_value answer_inline(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto fake = fake_of(env, args[0]);
  bool enabled = false;
  napi_get_value_bool(env, args[1], &enabled);
  std::lock_guard<std::mutex> lock(fake->mutex);
  fake->inline_answer = enabled;
  return undefined(env);
}

/** `references(native)`: `{ refs, retains, releases }`. */
napi_value references(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto fake = fake_of(env, arg);
  napi_value result;
  napi_create_object(env, &result);
  property(env, result, "refs", number(env, fake->refs));
  property(env, result, "retains", number(env, fake->retains));
  property(env, result, "releases", number(env, fake->releases));
  return result;
}

/** `defaultAdapter()`: the adapter of a default hardware D3D11 device as the receiver names it; null outside Windows or without one. */
napi_value default_adapter(napi_env env, napi_callback_info) {
  napi_value result;
  napi_get_null(env, &result);
#if defined(_WIN32)
  ID3D11Device* device = nullptr;
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
      D3D11_SDK_VERSION, &device, nullptr, nullptr))) return result;
  IDXGIDevice* dxgi = nullptr; IDXGIAdapter* adapter = nullptr; DXGI_ADAPTER_DESC desc{};
  if (SUCCEEDED(device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi))) && SUCCEEDED(dxgi->GetAdapter(&adapter))
      && SUCCEEDED(adapter->GetDesc(&desc))) {
    std::ostringstream id;
    id << std::hex << static_cast<uint32_t>(desc.AdapterLuid.HighPart) << ':' << desc.AdapterLuid.LowPart;
    result = text(env, id.str());
  }
  if (adapter) adapter->Release();
  if (dxgi) dxgi->Release();
  device->Release();
#endif
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"presented", nullptr, presented, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"answer", nullptr, answer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"refuseNext", nullptr, refuse_next, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"answerInline", nullptr, answer_inline, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"references", nullptr, references, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"defaultAdapter", nullptr, default_adapter, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
