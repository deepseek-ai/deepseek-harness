/**
 * Test-only Node-API addon for the shared-texture native e2e. It creates and inspects real textures (an IOSurface on
 * macOS, an anonymous file-mapping section on Windows) whose identity survives a process hop, creates a shared
 * Direct3D 11 texture on Windows whose adapter Main reads, drives the hop's `dsh_shared_texture_sink_v2` from native
 * threads the way an in-process consumer does, and sends raw DSTX present messages that the hop itself refuses to
 * produce. On Windows it also suspends and resumes another process and replaces a texture with one that takes over
 * its handle value.
 */
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include "shared-texture-sink.h"
#include "dstx-protocol.h"
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#else
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#endif

namespace {

napi_value fail(napi_env env, const char* text) { napi_throw_error(env, nullptr, text); return nullptr; }
napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
napi_value number(napi_env env, double value) { napi_value result; napi_create_double(env, value, &result); return result; }
napi_value text(napi_env env, const std::string& value) { napi_value result; napi_create_string_utf8(env, value.data(), value.size(), &result); return result; }
void property(napi_env env, napi_value object, const char* name, napi_value value) { napi_set_named_property(env, object, name, value); }
uint64_t handle_of(napi_env env, napi_value value) {
  void* data = nullptr; size_t size = 0; uint64_t handle = 0;
  if (napi_get_buffer_info(env, value, &data, &size) == napi_ok && size == 8) std::memcpy(&handle, data, 8);
  return handle;
}
napi_value buffer_of(napi_env env, uint64_t handle) { napi_value result; napi_create_buffer_copy(env, 8, &handle, nullptr, &result); return result; }
uint32_t uint_property(napi_env env, napi_value object, const char* name) {
  napi_value value; double result = 0;
  napi_get_named_property(env, object, name, &value);
  napi_get_value_double(env, value, &result);
  return static_cast<uint32_t>(result);
}
std::string string_property(napi_env env, napi_value object, const char* name) {
  napi_value value; size_t length = 0;
  napi_get_named_property(env, object, name, &value);
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string result(length, '\0');
  napi_get_value_string_utf8(env, value, &result[0], length + 1, &length);
  return result;
}

#ifdef _WIN32
uint32_t read_tag(uint64_t handle) {
  void* view = MapViewOfFile(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle)), FILE_MAP_READ, 0, 0, 4);
  if (!view) return 0;
  uint32_t tag = 0;
  std::memcpy(&tag, view, 4);
  UnmapViewOfFile(view);
  return tag;
}

/** A new file-mapping section whose first four bytes hold a tag unique to this process; nullptr on failure. */
HANDLE new_section() {
  static std::atomic<uint32_t> next{0};
  const uint32_t tag = (GetCurrentProcessId() << 12) ^ (++next) ^ 0x5a000000u;
  HANDLE section = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, 4096, nullptr);
  if (!section) return nullptr;
  void* view = MapViewOfFile(section, FILE_MAP_WRITE, 0, 0, 4);
  if (!view) { CloseHandle(section); return nullptr; }
  std::memcpy(view, &tag, 4);
  UnmapViewOfFile(view);
  return section;
}
#else
uint32_t read_tag(uint64_t handle) { return IOSurfaceGetID(reinterpret_cast<IOSurfaceRef>(static_cast<uintptr_t>(handle))); }
#endif

/** `{ handle, tag }` of a texture, where `tag` is what `textureTag` reads back from any handle to it. */
napi_value texture_object(napi_env env, uint64_t handle) {
  napi_value result;
  napi_create_object(env, &result);
  property(env, result, "handle", buffer_of(env, handle));
  property(env, result, "tag", number(env, read_tag(handle)));
  return result;
}

/** `createTexture()`: a new texture and the tag `textureTag` reads back from any handle to it. */
napi_value create_texture(napi_env env, napi_callback_info) {
  uint64_t handle = 0;
#ifdef _WIN32
  HANDLE section = new_section();
  if (!section) return fail(env, "Cannot create a file-mapping texture");
  handle = reinterpret_cast<uintptr_t>(section);
#else
  int width = 16, height = 16, bytes = 4;
  uint32_t format = 'BGRA';
  CFNumberRef values[] = {CFNumberCreate(nullptr, kCFNumberIntType, &width), CFNumberCreate(nullptr, kCFNumberIntType, &height),
    CFNumberCreate(nullptr, kCFNumberIntType, &bytes), CFNumberCreate(nullptr, kCFNumberSInt32Type, &format)};
  const void* keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat};
  CFDictionaryRef properties = CFDictionaryCreate(nullptr, keys, reinterpret_cast<const void**>(values), 4,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  IOSurfaceRef surface = IOSurfaceCreate(properties);
  CFRelease(properties);
  for (auto value : values) CFRelease(value);
  if (!surface) return fail(env, "IOSurfaceCreate failed");
  handle = reinterpret_cast<uintptr_t>(surface);
#endif
  return texture_object(env, handle);
}

/** `textureTag(handle)`: the tag of the texture a handle refers to; 0 when the handle does not map a texture. */
napi_value texture_tag(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  return number(env, read_tag(handle_of(env, arg)));
}

#ifdef _WIN32
/**
 * `replaceTexture(handle)`: close a texture and create another in the same call, so the new section takes the freed
 * handle value unless another thread allocated a handle in between; `{ handle, tag }` of the new texture.
 */
napi_value replace_texture(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_of(env, arg))));
  HANDLE section = new_section();
  if (!section) return fail(env, "Cannot create a file-mapping texture");
  return texture_object(env, reinterpret_cast<uintptr_t>(section));
}

/** `suspendProcess(pid)` / `resumeProcess(pid)`: stop or continue every thread of another process of this user. */
napi_value control_process(napi_env env, napi_callback_info info, const char* entry) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  uint32_t pid = 0;
  napi_get_value_uint32(env, arg, &pid);
  using Control = LONG(NTAPI*)(HANDLE);
  const auto control = reinterpret_cast<Control>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), entry)));
  HANDLE process = OpenProcess(PROCESS_SUSPEND_RESUME, FALSE, pid);
  if (!control || !process) {
    if (process) CloseHandle(process);
    return fail(env, "Cannot open the process to suspend or resume it");
  }
  const LONG status = control(process);
  CloseHandle(process);
  if (status < 0) return fail(env, "Cannot suspend or resume the process");
  return undefined(env);
}
napi_value suspend_process(napi_env env, napi_callback_info info) { return control_process(env, info, "NtSuspendProcess"); }
napi_value resume_process(napi_env env, napi_callback_info info) { return control_process(env, info, "NtResumeProcess"); }
#endif

#ifdef _WIN32
/**
 * `createD3DTexture()`: `{ handle, adapter }`, the NT handle of a new shared Direct3D 11 texture on the default adapter
 * (WARP when no hardware adapter exists) and that adapter's LUID formatted the way Host addons format it. The handle
 * alone keeps the texture alive; release it with `releaseTexture`.
 */
napi_value create_d3d_texture(napi_env env, napi_callback_info) {
  ID3D11Device* device = nullptr;
  HRESULT created = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr);
  if (FAILED(created)) created = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr);
  if (FAILED(created)) return fail(env, "D3D11CreateDevice failed");
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = 16;
  desc.Height = 16;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  ID3D11Texture2D* texture = nullptr;
  IDXGIResource1* resource = nullptr;
  IDXGIDevice* dxgi = nullptr;
  IDXGIAdapter* adapter = nullptr;
  DXGI_ADAPTER_DESC adapter_desc{};
  HANDLE shared = nullptr;
  const bool ok = SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &texture))
    && SUCCEEDED(texture->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void**>(&resource)))
    && SUCCEEDED(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &shared))
    && SUCCEEDED(device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi)))
    && SUCCEEDED(dxgi->GetAdapter(&adapter)) && SUCCEEDED(adapter->GetDesc(&adapter_desc));
  IUnknown* objects[] = {adapter, dxgi, resource, texture, device};
  for (auto object : objects) if (object) object->Release();
  if (!ok) {
    if (shared) CloseHandle(shared);
    return fail(env, "Cannot create a shared Direct3D 11 texture");
  }
  std::ostringstream id;
  id << std::hex << static_cast<uint32_t>(adapter_desc.AdapterLuid.HighPart) << ':' << adapter_desc.AdapterLuid.LowPart;
  napi_value result;
  napi_create_object(env, &result);
  property(env, result, "handle", buffer_of(env, reinterpret_cast<uintptr_t>(shared)));
  property(env, result, "adapter", text(env, id.str()));
  return result;
}
#endif

/** `releaseTexture(handle)`. */
napi_value release_texture(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
#ifdef _WIN32
  CloseHandle(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_of(env, arg))));
#else
  CFRelease(reinterpret_cast<IOSurfaceRef>(static_cast<uintptr_t>(handle_of(env, arg))));
#endif
  return undefined(env);
}

/** Sink probe: holds a sink reference and reports sink results to JavaScript. */
struct Report { std::string type; double tag; int code; std::string error; bool has_error; bool invalidated; };
struct Probe {
  dsh_shared_texture_sink_v2* sink = nullptr;
  napi_threadsafe_function events = nullptr;
  std::atomic<bool> attached{true};
  void post(Report* report) { if (napi_call_threadsafe_function(events, report, napi_tsfn_nonblocking) != napi_ok) delete report; }
};
struct Request { std::shared_ptr<Probe> probe; double tag; uint32_t block_ms; };

void dispatch(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<Report> report(static_cast<Report*>(data));
  if (!env) return;
  napi_value object, global, result;
  napi_create_object(env, &object);
  property(env, object, "type", text(env, report->type));
  property(env, object, "tag", number(env, report->tag));
  if (report->type == "returned") property(env, object, "code", number(env, report->code));
  if (report->type == "settled") { napi_value value; napi_get_boolean(env, report->invalidated, &value); property(env, object, "invalidated", value); }
  if (report->type != "settled") {
    napi_value value;
    if (report->has_error) value = text(env, report->error); else napi_get_null(env, &value);
    property(env, object, "error", value);
  }
  napi_get_global(env, &global);
  napi_call_function(env, global, callback, 1, &object, &result);
}

void on_delivered(void* user_data, const char* error) {
  auto request = static_cast<Request*>(user_data);
  request->probe->post(new Report{"delivered", request->tag, 0, error ? error : "", error != nullptr, false});
  // Holds the hop's reader thread, so the test can make a send observe a dead Main before the reader does.
  if (request->block_ms) std::this_thread::sleep_for(std::chrono::milliseconds(request->block_ms));
}
void on_settled(void* user_data, int invalidated) {
  std::unique_ptr<Request> request(static_cast<Request*>(user_data));
  request->probe->post(new Report{"settled", request->tag, 0, "", false, invalidated != 0});
}

std::shared_ptr<Probe>* probe_of(napi_env env, napi_value value) {
  void* data = nullptr;
  napi_get_value_external(env, value, &data);
  return static_cast<std::shared_ptr<Probe>*>(data);
}

/**
 * `attach(sink, onEvent, version?)`: check the sink ABI header against `version` (by default the version this probe
 * was built for) and retain the sink.
 */
napi_value attach(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void* data = nullptr;
  if (count < 2 || napi_get_value_external(env, args[0], &data) != napi_ok || !data) return fail(env, "Expected a sink external");
  auto sink = static_cast<dsh_shared_texture_sink_v2*>(data);
  uint32_t version = DSH_SHARED_TEXTURE_SINK_VERSION;
  napi_valuetype type = napi_undefined;
  if (count == 3) napi_typeof(env, args[2], &type);
  if (type == napi_number) napi_get_value_uint32(env, args[2], &version);
  if (sink->magic != DSH_SHARED_TEXTURE_SINK_MAGIC || sink->version != version) return fail(env, "Unexpected sink ABI");
  auto probe = std::make_shared<Probe>();
  probe->sink = sink;
  napi_value name;
  napi_create_string_utf8(env, "texture probe", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, args[1], nullptr, name, 0, 1, nullptr, nullptr, nullptr, dispatch, &probe->events);
  napi_unref_threadsafe_function(env, probe->events);
  sink->retain(sink->ctx);
  napi_value external;
  napi_create_external(env, new std::shared_ptr<Probe>(probe), [](napi_env, void* data, void*) {
    delete static_cast<std::shared_ptr<Probe>*>(data);
  }, nullptr, &external);
  return external;
}

/** `detach(probe)`: release the sink reference `attach` took. */
napi_value detach(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto& probe = *probe_of(env, arg);
  if (probe->attached.exchange(false)) probe->sink->release(probe->sink->ctx);
  return undefined(env);
}

/**
 * `present(probe, frames)`: present each `{ tag, handle, width, height, pixelFormat, metadata, timeoutMs,
 * blockDeliveredMs }` in order from one new native thread, reporting each return code before any later frame is
 * presented. A nonzero `blockDeliveredMs` makes that request's `on_delivered` sleep after reporting; `pauseMicros`
 * spaces the next frame.
 */
napi_value present(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto probe = *probe_of(env, args[0]);
  struct Input { double tag; uint64_t handle; std::string metadata; uint32_t width, height, timeout; uint8_t format; uint32_t block_ms; uint32_t pause_us; };
  std::vector<Input> inputs;
  uint32_t length = 0;
  napi_get_array_length(env, args[1], &length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value frame, handle;
    napi_get_element(env, args[1], index, &frame);
    napi_get_named_property(env, frame, "handle", &handle);
    inputs.push_back({static_cast<double>(uint_property(env, frame, "tag")), handle_of(env, handle), string_property(env, frame, "metadata"),
      uint_property(env, frame, "width"), uint_property(env, frame, "height"), uint_property(env, frame, "timeoutMs"),
      static_cast<uint8_t>(uint_property(env, frame, "pixelFormat")), uint_property(env, frame, "blockDeliveredMs"),
      uint_property(env, frame, "pauseMicros")});
  }
  std::thread([probe, inputs] {
    for (const auto& input : inputs) {
      dsh_shared_texture_frame_v2 frame{input.handle, input.width, input.height, input.timeout, input.format,
        input.metadata.empty() ? nullptr : input.metadata.data(), input.metadata.size()};
      auto request = new Request{probe, input.tag, input.block_ms};
      dsh_shared_texture_callbacks_v2 callbacks{request, on_delivered, on_settled};
      char error[256] = {0};
      const int code = probe->sink->present(probe->sink->ctx, &frame, &callbacks, error, sizeof(error));
      if (code != 0) delete request;
      probe->post(new Report{"returned", input.tag, code, error, code != 0, false});
      // A spin wait keeps the pacing below the Windows timer resolution.
      const auto until = std::chrono::steady_clock::now() + std::chrono::microseconds(input.pause_us);
      while (std::chrono::steady_clock::now() < until) {}
    }
  }).detach();
  return undefined(env);
}

static_assert(sizeof(dstx::DstxPresentHeader) == 40 && offsetof(dstx::DstxPresentHeader, pixel_format) == 32
  && offsetof(dstx::DstxPresentHeader, metadata_length) == 36 && offsetof(dstx::DstxPresentHeader, reserved2) == 38,
  "rawPresent writes the DSTX v3 present header layout");

/**
 * `rawPresent(endpoint, header, payload)`: send one DSTX v3 present message built from `header` fields (`magic`,
 * `version`, `requestId`, `width`, `height`, `pixelFormat`, `reserved`, `metadataLength`, `reserved2`) followed by
 * `payload`, carrying a fresh texture, without any validation; `reserved` fills the first reserved byte.
 */
napi_value raw_present(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  const auto endpoint = std::string(string_property(env, args[1], "endpoint"));
  unsigned char header[40] = {0};
  const uint32_t magic = uint_property(env, args[1], "magic"), version = uint_property(env, args[1], "version");
  const uint64_t request_id = uint_property(env, args[1], "requestId");
  const uint32_t width = uint_property(env, args[1], "width"), height = uint_property(env, args[1], "height");
  const uint8_t format = static_cast<uint8_t>(uint_property(env, args[1], "pixelFormat"));
  const uint8_t reserved = static_cast<uint8_t>(uint_property(env, args[1], "reserved"));
  const uint16_t metadata_length = static_cast<uint16_t>(uint_property(env, args[1], "metadataLength"));
  const uint16_t reserved2 = static_cast<uint16_t>(uint_property(env, args[1], "reserved2"));
  void* payload = nullptr; size_t payload_size = 0;
  napi_get_buffer_info(env, args[2], &payload, &payload_size);
  uint64_t texture = handle_of(env, args[0]);
#ifdef _WIN32
  const uint64_t nt_handle = texture;
#else
  const uint64_t nt_handle = 0;
#endif
  std::memcpy(header + 0, &magic, 4);
  std::memcpy(header + 4, &version, 4);
  std::memcpy(header + 8, &request_id, 8);
  std::memcpy(header + 16, &nt_handle, 8);
  std::memcpy(header + 24, &width, 4);
  std::memcpy(header + 28, &height, 4);
  header[32] = format;
  header[33] = reserved;
  std::memcpy(header + 36, &metadata_length, 2);
  std::memcpy(header + 38, &reserved2, 2);
  std::vector<unsigned char> message(header, header + sizeof(header));
  message.insert(message.end(), static_cast<unsigned char*>(payload), static_cast<unsigned char*>(payload) + payload_size);
#ifdef _WIN32
  const std::wstring name(endpoint.begin(), endpoint.end());
  HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return fail(env, "Cannot open the ingress pipe");
  DWORD mode = PIPE_READMODE_MESSAGE, written = 0;
  SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr);
  const BOOL ok = WriteFile(pipe, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
  // Main reads what was written before it sees the pipe close.
  CloseHandle(pipe);
  if (!ok) return fail(env, "Cannot write to the ingress pipe");
#else
  mach_port_t ingress = MACH_PORT_NULL, reply = MACH_PORT_NULL;
  if (bootstrap_look_up(bootstrap_port, const_cast<char*>(endpoint.c_str()), &ingress) != KERN_SUCCESS) return fail(env, "Cannot look up the ingress");
  mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply);
  struct Message { mach_msg_header_t header; mach_msg_body_t body; mach_msg_port_descriptor_t surface; unsigned char payload[8192]; } raw{};
  const size_t size = (offsetof(Message, payload) + message.size() + 3) & ~size_t{3};
  raw.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND) | MACH_MSGH_BITS_COMPLEX;
  raw.header.msgh_size = static_cast<mach_msg_size_t>(size);
  raw.header.msgh_remote_port = ingress;
  raw.header.msgh_local_port = reply;
  raw.body.msgh_descriptor_count = 1;
  raw.surface.name = IOSurfaceCreateMachPort(reinterpret_cast<IOSurfaceRef>(static_cast<uintptr_t>(texture)));
  raw.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
  raw.surface.type = MACH_MSG_PORT_DESCRIPTOR;
  std::memcpy(raw.payload, message.data(), std::min(message.size(), sizeof(raw.payload)));
  const auto result = mach_msg(&raw.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, raw.header.msgh_size, 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
  mach_port_destroy(mach_task_self(), reply);
  mach_port_deallocate(mach_task_self(), ingress);
  if (result != KERN_SUCCESS) return fail(env, "Cannot send to the ingress");
#endif
  return undefined(env);
}

napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"createTexture", nullptr, create_texture, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef _WIN32
    {"createD3DTexture", nullptr, create_d3d_texture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"replaceTexture", nullptr, replace_texture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"suspendProcess", nullptr, suspend_process, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resumeProcess", nullptr, resume_process, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
    {"textureTag", nullptr, texture_tag, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseTexture", nullptr, release_texture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"attach", nullptr, attach, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"detach", nullptr, detach, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"present", nullptr, present, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"rawPresent", nullptr, raw_present, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
