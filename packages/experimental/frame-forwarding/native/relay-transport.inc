// Windows receiver-worker resources; submitted GPU copies outlive cancellation until quiescent.
class SourceAccess {
  ComPtr<IDXGIKeyedMutex> mutex;
  bool locked = false;
 public:
  ~SourceAccess() { if (locked) mutex->ReleaseSync(0); }
  bool acquire(ID3D11Texture2D* texture, std::chrono::steady_clock::time_point deadline,
      std::string& diagnostic) {
    D3D11_TEXTURE2D_DESC description{}; texture->GetDesc(&description);
    if (!(description.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)) return true;
    auto result = texture->QueryInterface(IID_PPV_ARGS(&mutex));
    if (FAILED(result)) return gpu_failure(diagnostic, "Cannot access producer keyed mutex", result);
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (remaining <= 0) return gpu_failure(diagnostic, "Producer keyed mutex acquisition timed out", WAIT_TIMEOUT);
    result = mutex->AcquireSync(0, static_cast<DWORD>(std::min<int64_t>(remaining, MAXDWORD - 1)));
    if (result != S_OK) return gpu_failure(diagnostic, "Producer keyed mutex acquisition failed or timed out", result);
    locked = true; return true;
  }
  bool release(std::string& diagnostic) {
    if (!locked) return true;
    const auto result = mutex->ReleaseSync(0); locked = false;
    return result == S_OK || gpu_failure(diagnostic, "Cannot release producer keyed mutex", result);
  }
};
struct RelayDevice {
  ComPtr<ID3D11Device1> device;
  ComPtr<ID3D11DeviceContext> context;
};
struct RelaySource {
  ComPtr<ID3D11Device1> device;
  ComPtr<ID3D11Texture2D> texture;
  HANDLE handle = nullptr;
  uint32_t width = 0, height = 0;
  ~RelaySource() { if (handle) CloseHandle(handle); }
};
struct RelayReadback {
  ComPtr<ID3D11Device1> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11Texture2D> source, staging;
  std::unique_ptr<ReadbackSync> completion;
  std::shared_ptr<RelayTexture> image;
  uint32_t width = 0, height = 0;
};
enum class RelayStage { waiting_target, pending_target, ready };
struct RelayTexture {
  std::shared_ptr<RelayDevice> display;
  ComPtr<ID3D11Texture2D> source, target;
  ComPtr<IDXGIKeyedMutex> target_mutex;
  bool target_locked = false;
  std::unique_ptr<ReadbackSync> target_completion;
  RelayStage stage = RelayStage::ready;
  bool retry_pending = false;
  HANDLE handle = nullptr;
  uint32_t width = 0, height = 0;
  ~RelayTexture() {
    if (target_locked) {
      target_mutex->ReleaseSync(0);
    }
    if (handle) CloseHandle(handle);
  }
};
bool relay_prepare_sync(ID3D11Device1* device, ID3D11DeviceContext* context,
    std::unique_ptr<ReadbackSync>& completion, std::string& diagnostic) {
  if (completion) return true;
  auto sync = std::make_unique<ReadbackSync>();
  D3D11_QUERY_DESC description{D3D11_QUERY_EVENT, 0};
  auto result = device->CreateQuery(&description, &sync->query);
  if (FAILED(result)) return gpu_failure(diagnostic, "Cannot create relay completion query", result);
  ComPtr<ID3D11Device5> modern;
  if (SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&modern))) && SUCCEEDED(context->QueryInterface(IID_PPV_ARGS(&sync->signaling)))) {
    result = modern->CreateFence(0, D3D11_FENCE_FLAG_NONE, IID_PPV_ARGS(&sync->fence));
    if (FAILED(result) && result != E_NOTIMPL && result != DXGI_ERROR_UNSUPPORTED)
      return gpu_failure(diagnostic, "Cannot create relay completion fence", result);
  }
  if (sync->fence) {
    sync->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sync->event) return gpu_failure(diagnostic, "Cannot create relay completion event", HRESULT_FROM_WIN32(GetLastError()));
  }
  completion = std::move(sync); return true;
}
bool relay_active(const std::atomic<bool>& stopped,
    std::chrono::steady_clock::time_point deadline, std::string& diagnostic) {
  if (stopped) { diagnostic = "Native texture relay interrupted"; return false; }
  if (std::chrono::steady_clock::now() >= deadline) { diagnostic = "Native texture relay timed out"; return false; }
  return true;
}
uintptr_t relay_handle(const std::shared_ptr<RelayTexture>& texture) { return reinterpret_cast<uintptr_t>(texture->handle); }
int relay_advance(const std::shared_ptr<RelayTexture>& slot, const std::atomic<bool>& stopped,
    std::chrono::steady_clock::time_point deadline, std::string& diagnostic) {
  if (!relay_active(stopped, deadline, diagnostic)) return -1;
  if (slot->stage == RelayStage::waiting_target) {
    if (!slot->target_locked) {
      const auto acquired = slot->target_mutex->AcquireSync(0, 0);
      if (acquired == WAIT_TIMEOUT) { slot->retry_pending = true; return 0; }
      if (acquired != S_OK) { gpu_failure(diagnostic, "Cannot acquire relay target keyed mutex", acquired); return -1; }
      slot->target_locked = true;
    }
    if (!relay_active(stopped, deadline, diagnostic)) return -1;
    SourceAccess source_access;
    if (!source_access.acquire(slot->source.Get(), deadline, diagnostic)) return -1;
    slot->stage = RelayStage::pending_target; slot->retry_pending = false;
    slot->display->context->CopyResource(slot->target.Get(), slot->source.Get());
    if (!finish_gpu_submission(slot->display->context.Get(), *slot->target_completion, diagnostic)) return -1;
    if (!source_access.release(diagnostic)) return -1;
  }
  if (slot->stage == RelayStage::pending_target) {
    const auto ready = poll_gpu_submission(slot->display->device.Get(), slot->display->context.Get(), *slot->target_completion, false, diagnostic);
    if (ready != 1) return ready == 0 ? 0 : -1;
    const auto released = slot->target_mutex->ReleaseSync(0);
    if (released != S_OK) { gpu_failure(diagnostic, "Cannot release relay target keyed mutex", released); return -1; }
    slot->target_locked = false;
    slot->stage = RelayStage::ready;
  }
  return 1;
}
uintptr_t relay_completion_event(const std::shared_ptr<RelayTexture>& slot) {
  if (!slot) return 0;
  if (slot->target_completion && slot->target_completion->pending && slot->target_completion->event_armed) return reinterpret_cast<uintptr_t>(slot->target_completion->event);
  return 0;
}
bool relay_gpu_idle(const std::shared_ptr<RelayTexture>& slot, std::string& diagnostic) {
  if (!slot) return true;
  return !slot->target_completion || poll_gpu_submission(slot->display->device.Get(), slot->display->context.Get(), *slot->target_completion, true, diagnostic) > 0;
}

bool relay_target(uint32_t width, uint32_t height,
    const std::string& adapter, std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& stopped,
    std::shared_ptr<RelayDevice>& display, std::shared_ptr<RelayTexture>& slot, std::string& diagnostic) {
  if (!relay_active(stopped, deadline, diagnostic)) return false;
  if (stopped || adapter.empty()) { diagnostic = "Native texture relay requires both active adapters"; return false; }
  if (!display) {
    auto owner = std::make_shared<RelayDevice>();
    ComPtr<IDXGIFactory1> factory; ComPtr<IDXGIAdapter1> selected;
    HRESULT result = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(result)) { gpu_failure(diagnostic, "Cannot enumerate relay display adapters", result); return false; }
    for (UINT index = 0;; ++index) {
      ComPtr<IDXGIAdapter1> candidate;
      result = factory->EnumAdapters1(index, &candidate);
      if (result == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(result)) { gpu_failure(diagnostic, "Cannot enumerate relay display adapters", result); return false; }
      DXGI_ADAPTER_DESC1 description{};
      if (SUCCEEDED(candidate->GetDesc1(&description)) && adapter_id(description.AdapterLuid) == adapter) { selected = candidate; break; }
    }
    if (!selected) { diagnostic = "Relay display adapter is unavailable"; return false; }
    ComPtr<ID3D11Device> device;
    result = D3D11CreateDevice(selected.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &owner->context);
    if (FAILED(result) || FAILED(result = device.As(&owner->device))) { gpu_failure(diagnostic, "Cannot create relay display device", result); return false; }
    display = std::move(owner);
  }
  if (!slot) {
    slot = std::make_shared<RelayTexture>();
    slot->display = display;
    slot->width = width; slot->height = height;
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width; description.Height = height; description.MipLevels = 1; description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM; description.SampleDesc.Count = 1;
    HRESULT result;
    description.Usage = D3D11_USAGE_DEFAULT; description.CPUAccessFlags = 0;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    description.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    result = display->device->CreateTexture2D(&description, nullptr, &slot->target);
    if (FAILED(result)) { gpu_failure(diagnostic, "Cannot allocate relay display texture", result); return false; }
    result = slot->target.As(&slot->target_mutex);
    if (FAILED(result)) { gpu_failure(diagnostic, "Cannot access relay target keyed mutex", result); return false; }
    ComPtr<IDXGIResource1> shared;
    result = slot->target.As(&shared);
    if (SUCCEEDED(result)) result = shared->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &slot->handle);
    if (FAILED(result)) { gpu_failure(diagnostic, "Cannot share relay display texture", result); return false; }
    if (!relay_prepare_sync(display->device.Get(), display->context.Get(), slot->target_completion, diagnostic)) return false;
  }
  if (slot->width != width || slot->height != height) { diagnostic = "Relay allocation changed without retirement"; return false; }
  return true;
}

bool relay_begin(uintptr_t resource, uint32_t width, uint32_t height,
    const std::string& adapter, std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& stopped,
    std::shared_ptr<RelayDevice>& display, std::shared_ptr<RelayTexture>& slot, std::string& diagnostic) {
  if (!relay_target(width, height, adapter, deadline, stopped, display, slot, diagnostic)) return false;
  ComPtr<ID3D11Texture2D> source;
  auto result = slot->display->device->OpenSharedResource1(reinterpret_cast<HANDLE>(resource), IID_PPV_ARGS(&source));
  if (FAILED(result)) { gpu_failure(diagnostic, "Cannot open current relay source", result); return false; }
  slot->source = source;
  if (!relay_active(stopped, deadline, diagnostic)) return false;
  slot->retry_pending = false;
  slot->stage = RelayStage::waiting_target; return true;
}

bool relay_readback_begin(uintptr_t resource, uint32_t width, uint32_t height, uint32_t stride,
    std::shared_ptr<RelayReadback>& slot, std::shared_ptr<RelaySource>& imported,
    std::string& diagnostic, std::string& adapter, bool* keyed_mutex,
    std::chrono::steady_clock::time_point deadline) {
  ComPtr<ID3D11Texture2D> source;
  using CompareHandles = BOOL (WINAPI*)(HANDLE, HANDLE);
  static const auto compare_handles = reinterpret_cast<CompareHandles>(
    GetProcAddress(GetModuleHandleW(L"KernelBase.dll"), "CompareObjectHandles"));
  const bool reused = imported && imported->width == width && imported->height == height &&
    stride == width * 4 && compare_handles && compare_handles(imported->handle, reinterpret_cast<HANDLE>(resource));
  if (reused) {
    source = imported->texture; adapter = device_adapter(imported->device.Get());
    D3D11_TEXTURE2D_DESC description{}; source->GetDesc(&description);
    if (keyed_mutex) *keyed_mutex = (description.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX) != 0;
  }
  if (!reused && !open_frame(resource, width, height, stride, diagnostic, adapter, keyed_mutex, source)) {
    if (source) { std::string ignored; source_ready(source.Get(), deadline, ignored); }
    return false;
  }
  if (!slot || slot->width != width || slot->height != height) {
    auto next = std::make_shared<RelayReadback>();
    next->device = reused ? imported->device : validation_device; next->width = width; next->height = height;
    next->device->GetImmediateContext(&next->context);
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width; description.Height = height; description.MipLevels = 1; description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM; description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_STAGING; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    auto result = next->device->CreateTexture2D(&description, nullptr, &next->staging);
    if (FAILED(result)) return gpu_failure(diagnostic, "Cannot allocate relay source staging", result);
    if (!relay_prepare_sync(next->device.Get(), next->context.Get(), next->completion, diagnostic)) return false;
    slot = std::move(next);
  }
  if (!reused && compare_handles) {
    auto next = std::make_shared<RelaySource>();
    if (!DuplicateHandle(GetCurrentProcess(), reinterpret_cast<HANDLE>(resource), GetCurrentProcess(),
        &next->handle, 0, FALSE, DUPLICATE_SAME_ACCESS))
      return gpu_failure(diagnostic, "Cannot retain relay source handle", HRESULT_FROM_WIN32(GetLastError()));
    next->texture = source; next->device = slot->device;
    next->width = width; next->height = height; imported = std::move(next);
  }
  slot->source = std::move(source);
  SourceAccess source_access;
  if (!source_access.acquire(slot->source.Get(), deadline, diagnostic)) return false;
  slot->context->CopyResource(slot->staging.Get(), slot->source.Get());
  if (!finish_gpu_submission(slot->context.Get(), *slot->completion, diagnostic)) return false;
  return source_access.release(diagnostic);
}
int relay_readback_ready(const std::shared_ptr<RelayReadback>& slot, bool retiring, std::string& diagnostic) {
  if (!slot) return 1;
  const auto result = poll_gpu_submission(slot->device.Get(), slot->context.Get(), *slot->completion, retiring, diagnostic);
  if (result > 0) {
    slot->source.Reset();
    if (slot->image) {
      const auto released = slot->image->target_mutex->ReleaseSync(0);
      if (released != S_OK && !retiring) { gpu_failure(diagnostic, "Cannot release native readback image", released); return -1; }
      slot->image->target_locked = false; slot->image.reset();
    }
  }
  return result == 2 && !retiring ? -1 : result;
}
uintptr_t relay_readback_event(const std::shared_ptr<RelayReadback>& slot) {
  return slot && slot->completion->pending && slot->completion->event_armed ? reinterpret_cast<uintptr_t>(slot->completion->event) : 0;
}
int relay_upload(const std::shared_ptr<RelayReadback>& source, uint32_t width, uint32_t height,
    const std::string& adapter, std::shared_ptr<RelayDevice>& display, std::shared_ptr<RelayTexture>& target,
    std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& stopped, std::string& diagnostic) {
  if (target && (target->width != width || target->height != height)) {
    if (!target->target_locked) {
      const auto acquired = target->target_mutex->AcquireSync(0, 0);
      if (acquired == WAIT_TIMEOUT) return 0;
      if (acquired != S_OK) { gpu_failure(diagnostic, "Cannot retire relay target keyed mutex", acquired); return -1; }
      target->target_locked = true;
    }
    target.reset();
  }
  if (!relay_target(width, height, adapter, deadline, stopped, display, target, diagnostic)) return -1;
  if (!target->target_locked) {
    const auto acquired = target->target_mutex->AcquireSync(0, 0);
    if (acquired == WAIT_TIMEOUT) { target->retry_pending = true; return 0; }
    if (acquired != S_OK) { gpu_failure(diagnostic, "Cannot acquire relay target keyed mutex", acquired); return -1; }
    target->target_locked = true;
  }
  D3D11_MAPPED_SUBRESOURCE mapped{};
  const auto result = source->context->Map(source->staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
  if (result == DXGI_ERROR_WAS_STILL_DRAWING) { target->retry_pending = true; return 0; }
  if (FAILED(result)) { gpu_failure(diagnostic, "Cannot map staged relay", result); return -1; }
  struct Unmap { RelayReadback* source; ~Unmap() { source->context->Unmap(source->staging.Get(), 0); } } unmap{source.get()};
  if (!relay_active(stopped, deadline, diagnostic)) return -1;
  target->stage = RelayStage::pending_target; target->retry_pending = false;
  target->display->context->UpdateSubresource(target->target.Get(), 0, nullptr, mapped.pData, mapped.RowPitch, 0);
  return finish_gpu_submission(target->display->context.Get(), *target->target_completion, diagnostic) ? 1 : -1;
}

void* relay_output_device(const std::shared_ptr<RelayTexture>& texture) { return texture->display->device.Get(); }
void relay_forget_source(const std::shared_ptr<RelayTexture>& texture) { texture->source.Reset(); }
bool relay_copy_output(const std::shared_ptr<RelayTexture>& texture, void* destination, std::string& diagnostic) {
  const auto result = texture->target_mutex->AcquireSync(0, 0);
  if (result != S_OK) return gpu_failure(diagnostic, "Cannot acquire native presentation image", result);
  texture->target_locked = true; texture->stage = RelayStage::pending_target;
  texture->display->context->CopyResource(static_cast<ID3D11Texture2D*>(destination), texture->target.Get());
  return finish_gpu_submission(texture->display->context.Get(), *texture->target_completion, diagnostic);
}
bool relay_readback_image(const std::shared_ptr<RelayTexture>& texture, std::shared_ptr<RelayReadback>& staging, std::string& diagnostic) {
  auto next = std::make_shared<RelayReadback>();
  next->device = texture->display->device; next->context = texture->display->context;
  next->width = texture->width; next->height = texture->height;
  D3D11_TEXTURE2D_DESC description{}; texture->target->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING; description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  description.BindFlags = 0; description.MiscFlags = 0;
  auto result = next->device->CreateTexture2D(&description, nullptr, &next->staging);
  if (FAILED(result)) return gpu_failure(diagnostic, "Cannot allocate native presentation readback", result);
  if (!relay_prepare_sync(next->device.Get(), next->context.Get(), next->completion, diagnostic)) return false;
  staging = next;
  result = texture->target_mutex->AcquireSync(0, 0);
  if (result != S_OK) return gpu_failure(diagnostic, "Cannot acquire native readback image", result);
  texture->target_locked = true; next->image = texture;
  next->context->CopyResource(next->staging.Get(), texture->target.Get());
  return finish_gpu_submission(next->context.Get(), *next->completion, diagnostic);
}
int relay_with_pixels(const std::shared_ptr<RelayReadback>& staging,
    const std::function<bool(const uint8_t*, uint32_t)>& consume, std::string& diagnostic) {
  D3D11_MAPPED_SUBRESOURCE mapped{};
  const auto result = staging->context->Map(staging->staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
  if (result == DXGI_ERROR_WAS_STILL_DRAWING) return 0;
  if (FAILED(result)) { gpu_failure(diagnostic, "Cannot map native presentation readback", result); return -1; }
  struct Unmap { RelayReadback* source; ~Unmap() { source->context->Unmap(source->staging.Get(), 0); } } unmap{staging.get()};
  return consume(static_cast<const uint8_t*>(mapped.pData), mapped.RowPitch) ? 1 : -1;
}
/** Acquire and release key 0 of a keyed-mutex texture within the deadline; a texture without a keyed mutex is ready. */
bool source_ready(ID3D11Texture2D* texture, std::chrono::steady_clock::time_point deadline, std::string& diagnostic) {
  SourceAccess access;
  return access.acquire(texture, deadline, diagnostic) && access.release(diagnostic);
}
