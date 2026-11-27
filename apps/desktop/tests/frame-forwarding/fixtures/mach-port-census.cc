/**
 * Test-only addon: count the dead names of the process that loads it, and their references, so reconnect tests can
 * verify that neither crashed nor graceful producer disconnects accumulate dead names in the Host's port table.
 */
#include <node_api.h>
#include <mach/mach.h>
#include <cstdint>

namespace {
napi_value census(napi_env env, napi_callback_info) {
  mach_port_name_array_t names = nullptr;
  mach_port_type_array_t types = nullptr;
  mach_msg_type_number_t name_count = 0, type_count = 0;
  if (mach_port_names(mach_task_self(), &names, &name_count, &types, &type_count) != KERN_SUCCESS) {
    napi_throw_error(env, nullptr, "cannot list Mach port names");
    return nullptr;
  }
  uint32_t dead = 0;
  uint64_t references = 0;
  for (mach_msg_type_number_t index = 0; index < name_count && index < type_count; ++index) {
    if (!(types[index] & MACH_PORT_TYPE_DEAD_NAME)) continue;
    mach_port_urefs_t urefs = 0;
    if (mach_port_get_refs(mach_task_self(), names[index], MACH_PORT_RIGHT_DEAD_NAME, &urefs) != KERN_SUCCESS) continue;
    ++dead; references += urefs;
  }
  vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(names), name_count * sizeof(mach_port_name_t));
  vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(types), type_count * sizeof(mach_port_type_t));
  napi_value result, dead_value, references_value;
  napi_create_object(env, &result);
  napi_create_uint32(env, dead, &dead_value);
  napi_create_double(env, static_cast<double>(references), &references_value);
  napi_set_named_property(env, result, "deadNames", dead_value);
  napi_set_named_property(env, result, "deadNameRefs", references_value);
  return result;
}
}  // namespace

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "count", NAPI_AUTO_LENGTH, census, nullptr, &function) != napi_ok) return nullptr;
  napi_set_named_property(env, exports, "count", function);
  return exports;
}
