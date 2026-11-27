// Test-only reader of one BGRA pixel from a Host-local IOSurfaceRef handle delivered by the receiver.
#include <IOSurface/IOSurface.h>
#include <node_api.h>
#include <cstdint>
#include <cstring>
static napi_value pixel(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3];
  void* data = nullptr;
  size_t size = 0;
  uint32_t x = 0, y = 0;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 3
      || napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(uintptr_t)
      || napi_get_value_uint32(env, args[1], &x) != napi_ok || napi_get_value_uint32(env, args[2], &y) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected an eight-byte handle and pixel coordinates");
    return nullptr;
  }
  uintptr_t handle;
  std::memcpy(&handle, data, sizeof(handle));
  auto surface = reinterpret_cast<IOSurfaceRef>(handle);
  if (x >= IOSurfaceGetWidth(surface) || y >= IOSurfaceGetHeight(surface)
      || IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    napi_throw_range_error(env, nullptr, "Pixel is outside the surface or the surface cannot be read");
    return nullptr;
  }
  auto row = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(surface)) + static_cast<size_t>(y) * IOSurfaceGetBytesPerRow(surface);
  uint32_t bgra;
  std::memcpy(&bgra, row + static_cast<size_t>(x) * 4, sizeof(bgra));
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  napi_value result;
  napi_create_uint32(env, bgra, &result);
  return result;
}
NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "pixel", NAPI_AUTO_LENGTH, pixel, nullptr, &function);
  napi_set_named_property(env, exports, "pixel", function);
  return exports;
}
