/** Node-API helpers shared by the shared-texture hop and ingress addons; Node-API 8 only. */
#pragma once

#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>

namespace addon {

inline napi_value string(napi_env env, const char* data, size_t length) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, data, length, &result);
  return result;
}
inline napi_value string(napi_env env, const std::string& value) { return string(env, value.data(), value.size()); }
inline napi_value number(napi_env env, double value) {
  napi_value result = nullptr;
  napi_create_double(env, value, &result);
  return result;
}
inline napi_value boolean(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}
inline napi_value undefined(napi_env env) {
  napi_value result = nullptr;
  napi_get_undefined(env, &result);
  return result;
}
inline napi_value null(napi_env env) {
  napi_value result = nullptr;
  napi_get_null(env, &result);
  return result;
}
inline void property(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}
/** Throw an `Error` and return the null Node-API result. */
inline napi_value fail(napi_env env, const char* text) {
  napi_throw_error(env, nullptr, text);
  return nullptr;
}
inline napi_value type_fail(napi_env env, const char* text) {
  napi_throw_type_error(env, nullptr, text);
  return nullptr;
}

/** Read an eight-byte handle buffer; false for any other value. */
inline bool handle_argument(napi_env env, napi_value value, uint64_t& handle) {
  void* data = nullptr;
  size_t size = 0;
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) return false;
  if (napi_get_buffer_info(env, value, &data, &size) != napi_ok || size != sizeof(uint64_t)) return false;
  std::memcpy(&handle, data, sizeof(handle));
  return true;
}

/** Create an eight-byte buffer holding `handle`. */
inline napi_value handle_buffer(napi_env env, uint64_t handle) {
  napi_value result = nullptr;
  if (napi_create_buffer_copy(env, sizeof(handle), &handle, nullptr, &result) != napi_ok) return nullptr;
  return result;
}

/** Read a string into `out` when its UTF-8 encoding is within `max_bytes`; false for non-strings and longer text. */
inline bool string_argument(napi_env env, napi_value value, size_t max_bytes, std::string& out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > max_bytes) return false;
  out.resize(length);
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, &out[0], length + 1, &written) != napi_ok) return false;
  out.resize(written);
  return true;
}

/** Read an integral number within `[min, max]`. */
inline bool integer_argument(napi_env env, napi_value value, double min, double max, double& out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  if (napi_get_value_double(env, value, &out) != napi_ok) return false;
  return std::isfinite(out) && std::floor(out) == out && out >= min && out <= max;
}

/** Clear a pending JavaScript exception that a failed allocation left behind. */
inline void clear_exception(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) {
    napi_value exception;
    napi_get_and_clear_last_exception(env, &exception);
  }
}

}  // namespace addon
