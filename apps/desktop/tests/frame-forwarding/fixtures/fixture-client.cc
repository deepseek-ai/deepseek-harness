#include "transport.h"
#include "fixture-client.h"
#include <algorithm>
#include <cstring>
#include <vector>
#include <limits>
#include <chrono>
#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <unistd.h>
#else
#define NOMINMAX
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#endif
using namespace dsh_frame_forwarding;
struct dsh_frame_forwarding_surface {
  uint32_t width = 0, height = 0, stride = 0;
  uint64_t bytes = 0, frame_id = 0, allocation_id = 0;
  enum { pending, granted, available, acquired, submitted } state = pending;
  dsh_frame_forwarding_client* owner = nullptr;
#if defined(__APPLE__)
  IOSurfaceRef surface = nullptr;
  ~dsh_frame_forwarding_surface() { if (surface) CFRelease(surface); }
#else
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<IDXGIKeyedMutex> keyed_mutex;
  HANDLE handle = nullptr;
  ~dsh_frame_forwarding_surface() { if (handle) CloseHandle(handle); }
#endif
};
struct dsh_frame_forwarding_client {
  std::unique_ptr<Channel> channel;
  std::mutex pool_mutex;
  std::vector<std::unique_ptr<dsh_frame_forwarding_surface>> surfaces;
  uint32_t max_frames = 0;
  uint64_t max_bytes = 0, next_allocation = 1;
  std::string error;
  std::atomic<bool> stopped{false};
#if defined(_WIN32)
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
#endif
};
namespace {
/** Send a complete surface, while the caller holds pool_mutex. */
bool send_frame(dsh_frame_forwarding_client* client, dsh_frame_forwarding_surface* surface, uint64_t frame_id, const char* metadata_json) {
  Packet packet; packet.kind = frame;
  if (!metadata_json || std::strlen(metadata_json) >= sizeof(packet.text)) return false;
  std::strcpy(packet.text, metadata_json);
  packet.width = surface->width; packet.height = surface->height; packet.stride = surface->stride;
  packet.frame_id = frame_id; packet.allocation_id = surface->allocation_id;
#if defined(__APPLE__)
  auto resource = reinterpret_cast<uintptr_t>(surface->surface);
#else
  auto resource = reinterpret_cast<uintptr_t>(surface->handle);
#endif
  if (!client->channel->send(packet, resource)) return false;
  surface->frame_id = frame_id; surface->state = dsh_frame_forwarding_surface::submitted; return true;
}
void copy_error(char* output, size_t size, const char* message) {
  if (output && size) { std::strncpy(output, message, size - 1); output[size - 1] = 0; }
}
/**
 * Return every surface that is neither acquired nor submitted to the receiver; the caller holds pool_mutex.
 * @returns Whether every deallocation was sent.
 */
bool release_idle(dsh_frame_forwarding_client* client) {
  bool sent = true;
  client->surfaces.erase(std::remove_if(client->surfaces.begin(), client->surfaces.end(), [&](auto& surface) {
    if (surface->state == dsh_frame_forwarding_surface::acquired || surface->state == dsh_frame_forwarding_surface::submitted) return false;
    Packet packet; packet.kind = deallocate; packet.allocation_id = surface->allocation_id;
    sent = client->channel->send(packet) && sent; return true;
  }), client->surfaces.end());
  return sent;
}
bool set_text(Packet& packet, const char* text) {
  if (!text || std::strlen(text) >= sizeof(packet.text)) return false;
  std::strcpy(packet.text, text); return true;
}
/** Diagnostic for a receiver's refusal; "channel-busy" names a channel whose producer is still connected or draining. */
std::string refusal(const Packet& packet) {
  const std::string reason(packet.text, strnlen(packet.text, sizeof(packet.text)));
  if (reason == reject_busy) return "channel-busy: the frame-forwarding channel already has a producer or a waiting successor";
  if (reason == reject_capability) return "Frame-forwarding receiver requires a transferable TX producer";
  if (reason == reject_local_handles) return "Frame-forwarding receiver requires a producer that names only its own handles";
  if (reason == reject_credential) return "Frame-forwarding TX credential was rejected";
  if (reason == reject_closed) return "Frame-forwarding channel is closed";
  if (reason.rfind(reject_protocol, 0) == 0) return "Frame-forwarding " + reason;
  return "Frame-forwarding receiver rejected handshake";
}
#if defined(__APPLE__)
void set_number(CFMutableDictionaryRef dictionary, CFStringRef key, int64_t value) {
  auto number = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt64Type, &value);
  CFDictionarySetValue(dictionary, key, number); CFRelease(number);
}
#endif
}
static dsh_frame_forwarding_client* connect_impl(const char* endpoint_text, void* device,
    const dsh_frame_forwarding_connect_options* options, char* error, size_t error_size) {
  try {
    if (!endpoint_text) throw std::runtime_error("Missing frame-forwarding TX credential");
    auto endpoint = parse_endpoint(endpoint_text);
    auto client = std::make_unique<dsh_frame_forwarding_client>();
    const auto started = std::chrono::steady_clock::now();
    const auto cancelled = [&] {
      return options && ((options->cancelled && options->cancelled(options->cancellation_context)) ||
        std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(options->timeout_ms));
    };
    client->channel = connect_channel(endpoint, options ? std::function<bool()>(cancelled) : std::function<bool()>{});
    Packet packet; packet.kind = hello; std::strcpy(packet.token, endpoint.token.c_str());
#if defined(_WIN32)
    if (device) {
      client->device = static_cast<ID3D11Device*>(device);
      client->device->GetImmediateContext(&client->context);
    } else if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION, &client->device, nullptr, &client->context)))
      throw std::runtime_error("D3D11 hardware device unavailable");
    set_text(packet, device_adapter(client->device.Get()).c_str());
    packet.max_frames = hello_keyed_mutex | hello_transferable | hello_producer_local_handles;
#else
    if (device) throw std::runtime_error("IOSurface producer does not accept a graphics device");
    packet.max_frames = hello_transferable | hello_producer_local_handles;
#endif
    if (!client->channel->send(packet)) throw std::runtime_error("Cannot send frame-forwarding handshake");
    Received received;
    int result;
    do {
      if (cancelled()) throw std::runtime_error("Frame-forwarding connection cancelled or timed out");
      result = client->channel->receive(received, 100);
    } while (result == 0);
    const auto& reply = received.packet;
    if (result < 0 || reply.marker != magic || reply.version != DSH_FRAME_FORWARDING_PROTOCOL_VERSION)
      throw std::runtime_error("Frame-forwarding receiver rejected handshake");
    if (reply.kind == goodbye) throw std::runtime_error(refusal(reply));
    const auto connection = parse_connection(reply.token);
    if (reply.kind != ready || !reply.max_frames || !reply.max_bytes) throw std::runtime_error("Frame-forwarding receiver rejected handshake");
    // A receiver that predates transferable channels answers without a connection identifier.
    if (!connection) throw std::runtime_error("Frame-forwarding receiver does not support transferable TX credentials");
    // A receiver that does not echo the capability would read this producer's handle values as handles of its own.
    if (!(reply.stride & hello_producer_local_handles)) throw std::runtime_error("Frame-forwarding receiver does not accept producer-local handles");
    client->channel->bind_connection(connection);
    client->max_frames = reply.max_frames; client->max_bytes = reply.max_bytes;
    return client.release();
  } catch (const std::exception& exception) { copy_error(error, error_size, exception.what()); return nullptr; }
}
dsh_frame_forwarding_client* dsh_frame_forwarding_connect(const char* endpoint, char* error, size_t error_size) {
  return connect_impl(endpoint, nullptr, nullptr, error, error_size);
}
dsh_frame_forwarding_client* dsh_frame_forwarding_connect_with_options(const char* endpoint,
    const dsh_frame_forwarding_connect_options* options, char* error, size_t error_size) {
  if (!options || !options->timeout_ms) { copy_error(error, error_size, "Connection requires a positive timeout"); return nullptr; }
  return connect_impl(endpoint, options->device, options, error, error_size);
}
dsh_frame_forwarding_surface* dsh_frame_forwarding_acquire(dsh_frame_forwarding_client* client, uint32_t width, uint32_t height) {
  if (!client || client->stopped) return nullptr;
  std::lock_guard<std::mutex> lock(client->pool_mutex);
  if (!width || !height || width > 16384 || height > 16384) { client->error = "Frame-forwarding dimensions outside supported range"; return nullptr; }
  dsh_frame_forwarding_surface *granted_surface = nullptr;
  bool allocation_pending = false;
  for (auto& surface : client->surfaces) {
    if (surface->width != width || surface->height != height) continue;
    if (surface->state == dsh_frame_forwarding_surface::available) {
      surface->state = dsh_frame_forwarding_surface::acquired; return surface.get();
    }
    if (surface->state == dsh_frame_forwarding_surface::pending) allocation_pending = true;
    if (surface->state == dsh_frame_forwarding_surface::granted && !granted_surface) granted_surface = surface.get();
  }
  if (!granted_surface && allocation_pending) return nullptr;
  if (!granted_surface) {
    release_idle(client);
    uint64_t allocated_bytes = 0;
    for (auto& surface : client->surfaces) allocated_bytes += surface->bytes;
#if defined(__APPLE__)
    auto row_bytes = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, static_cast<size_t>(width) * 4);
    uint64_t required_bytes = IOSurfaceAlignProperty(kIOSurfaceAllocSize, row_bytes * height);
    const uint64_t page_bytes = static_cast<uint64_t>(getpagesize());
    required_bytes = (required_bytes + page_bytes - 1) / page_bytes * page_bytes;
#else
    uint64_t required_bytes = static_cast<uint64_t>(width) * height * 4;
#endif
    if (required_bytes > client->max_bytes) { client->error = "Frame-forwarding texture exceeds view byte budget"; return nullptr; }
    if (client->surfaces.size() >= client->max_frames || allocated_bytes + required_bytes > client->max_bytes) return nullptr;
    auto pending_surface = std::make_unique<dsh_frame_forwarding_surface>();
    pending_surface->width = width; pending_surface->height = height; pending_surface->owner = client;
    pending_surface->bytes = required_bytes; pending_surface->allocation_id = client->next_allocation++;
    Packet request; request.kind = allocate; request.allocation_id = pending_surface->allocation_id; request.max_bytes = required_bytes;
    if (!client->channel->send(request)) { client->error = "Frame-forwarding allocation channel closed"; return nullptr; }
    client->surfaces.push_back(std::move(pending_surface)); return nullptr;
  }
  auto surface = granted_surface;
#if defined(__APPLE__)
  auto properties = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  set_number(properties, kIOSurfaceWidth, width); set_number(properties, kIOSurfaceHeight, height);
  set_number(properties, kIOSurfaceAllocSize, surface->bytes);
  set_number(properties, kIOSurfaceBytesPerElement, 4); set_number(properties, kIOSurfacePixelFormat, 0x42475241);
  surface->surface = IOSurfaceCreate(properties); CFRelease(properties);
  if (!surface->surface) { client->error = "IOSurface allocation failed"; return nullptr; }
  surface->stride = static_cast<uint32_t>(IOSurfaceGetBytesPerRow(surface->surface));
  surface->bytes = IOSurfaceGetAllocSize(surface->surface);
#else
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width; desc.Height = height; desc.MipLevels = 1; desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  if (FAILED(client->device->CreateTexture2D(&desc, nullptr, &surface->texture))) { client->error = "D3D11 shared texture allocation failed"; return nullptr; }
  if (FAILED(surface->texture.As(&surface->keyed_mutex))) { client->error = "DXGI producer keyed mutex unavailable"; return nullptr; }
  ComPtr<IDXGIResource1> shared;
  if (FAILED(surface->texture.As(&shared)) || FAILED(shared->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &surface->handle))) { client->error = "DXGI shared handle creation failed"; return nullptr; }
  surface->stride = width * 4; surface->bytes = static_cast<uint64_t>(width) * height * 4;
#endif
  surface->state = dsh_frame_forwarding_surface::acquired;
  return surface;
}
static int write_bgra(dsh_frame_forwarding_surface* surface, const void* pixels, size_t stride, uint32_t timeout_ms) {
  if (!surface || !pixels || stride < static_cast<size_t>(surface->width) * 4 || stride > UINT32_MAX) return 0;
  auto client = surface->owner; std::lock_guard<std::mutex> lock(client->pool_mutex);
  if (surface->state != dsh_frame_forwarding_surface::acquired || client->stopped) return 0;
#if defined(__APPLE__)
  (void)timeout_ms;
  if (IOSurfaceLock(surface->surface, 0, nullptr) != kIOReturnSuccess) return 0;
  auto target = static_cast<unsigned char*>(IOSurfaceGetBaseAddress(surface->surface));
  for (uint32_t row = 0; row < surface->height; ++row)
    std::memcpy(target + static_cast<size_t>(row) * surface->stride, static_cast<const unsigned char*>(pixels) + static_cast<size_t>(row) * stride, surface->width * 4);
  return IOSurfaceUnlock(surface->surface, 0, nullptr) == kIOReturnSuccess;
#else
  const auto acquired = surface->keyed_mutex->AcquireSync(0, timeout_ms);
  if (acquired != S_OK) { client->error = "Producer write keyed mutex acquisition failed or timed out"; return 0; }
  client->context->UpdateSubresource(surface->texture.Get(), 0, nullptr, pixels, static_cast<UINT>(stride), 0);
  const auto released = surface->keyed_mutex->ReleaseSync(0);
  client->context->Flush();
  if (released != S_OK) { client->error = "Producer write keyed mutex release failed"; return 0; }
  return 1;
#endif
}
int dsh_frame_forwarding_write_bgra(dsh_frame_forwarding_surface* surface, const void* pixels, size_t stride) {
  return write_bgra(surface, pixels, stride, 1000);
}
int dsh_frame_forwarding_submit(dsh_frame_forwarding_client* client, dsh_frame_forwarding_surface* surface, uint64_t frame_id, const char* metadata_json) {
  if (!client || !surface || surface->owner != client || !frame_id || frame_id > 9007199254740991ULL || client->stopped) return 0;
  if (!metadata_json || std::strlen(metadata_json) >= DSH_FRAME_FORWARDING_TEXT_CAPACITY) return 0;
  std::lock_guard<std::mutex> lock(client->pool_mutex);
  if (surface->state != dsh_frame_forwarding_surface::acquired) return 0;
  for (auto& other : client->surfaces) {
    if (other->state == dsh_frame_forwarding_surface::submitted
        && other->frame_id == frame_id) return 0;
  }
  return send_frame(client, surface, frame_id, metadata_json) ? 1 : 0;
}
int dsh_frame_forwarding_trim(dsh_frame_forwarding_client* client) {
  if (!client || client->stopped) return 0;
  std::lock_guard<std::mutex> lock(client->pool_mutex);
  const bool sent = release_idle(client);
#if defined(_WIN32)
  // D3D11 destroys a released texture only when its context next flushes, which an idle producer would not do.
  client->context->Flush();
#endif
  if (sent) return 1;
  client->error = "Frame-forwarding allocation channel closed"; return 0;
}
int dsh_frame_forwarding_poll(dsh_frame_forwarding_client* client, uint32_t timeout, dsh_frame_forwarding_event* event) {
  if (!client || !event) return -1;
  event->kind = 0; event->text[0] = 0;
  {
    std::lock_guard<std::mutex> lock(client->pool_mutex);
    if (!client->error.empty()) { event->kind = -1; copy_error(event->text, sizeof(event->text), client->error.c_str()); return -1; }
  }
  Received received;
  auto result = client->channel->receive(received, std::min(timeout, 100U));
  if (received.resource) release_resource(received.resource);
  if (result < 0 || client->stopped) { event->kind = -1; return -1; }
  if (!result) return 0;
  if (received.packet.marker != magic || received.packet.version != DSH_FRAME_FORWARDING_PROTOCOL_VERSION) { event->kind = -1; return -1; }
  if (received.packet.kind == release) {
    std::lock_guard<std::mutex> lock(client->pool_mutex);
    for (auto& surface : client->surfaces) {
      if (surface->state == dsh_frame_forwarding_surface::submitted && surface->frame_id == received.packet.frame_id) {
        surface->state = dsh_frame_forwarding_surface::available; break;
      }
    }
  } else if (received.packet.kind == allocated) {
    std::lock_guard<std::mutex> lock(client->pool_mutex);
    for (auto& surface : client->surfaces) {
      if (surface->allocation_id == received.packet.allocation_id && surface->state == dsh_frame_forwarding_surface::pending) {
        surface->state = dsh_frame_forwarding_surface::granted; break;
      }
    }
  } else if (received.packet.kind == message && std::memchr(received.packet.text, 0, sizeof(received.packet.text))) {
    event->kind = 1; std::strcpy(event->text, received.packet.text);
  } else if (received.packet.kind == goodbye) { client->stopped = true; event->kind = -1; return -1; }
  else { event->kind = -1; return -1; }
  return event->kind;
}
int dsh_frame_forwarding_send(dsh_frame_forwarding_client* client, const char* json) {
  if (!client || client->stopped) return 0;
  Packet packet; packet.kind = message;
  return set_text(packet, json) && client->channel->send(packet);
}
void dsh_frame_forwarding_interrupt(dsh_frame_forwarding_client* client) { if (client) { client->stopped = true; client->channel->interrupt(); } }
void dsh_frame_forwarding_close(dsh_frame_forwarding_client* client) {
  if (!client) return;
  Packet packet; packet.kind = goodbye; client->channel->send(packet);
  dsh_frame_forwarding_interrupt(client); delete client;
}
