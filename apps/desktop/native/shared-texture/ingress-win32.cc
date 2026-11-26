/**
 * Windows transport for `shared-texture-ingress.node`: a single-instance duplex message pipe that admits only the
 * Desktop Host's process. Main duplicates each texture handle out of the Host through a process handle it holds while
 * that Host stays connected; the Host never opens Main. A request names its texture only by a handle value inside the
 * Host, so Main keeps a duplicate only when the Host's end of the pipe was still open after duplicating: the Host
 * closes its end before it settles the requests of a connection it closes, after which their handle values may name
 * other objects. Replies from the reader and JavaScript threads are serialized overlapped writes. DXGI identifies the
 * adapter of a Main-local shared resource.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstring>
#include <mutex>
#include <sstream>
#include <vector>
#include "ingress-transport.h"

namespace ingress {
namespace {

constexpr char kPipePrefix[] = "\\\\.\\pipe\\dsh-shared-texture-";
constexpr DWORD kPipeBufferBytes = 64 * 1024;

/** `FILE_PIPE_LOCAL_INFORMATION` of the Windows Driver Kit, which the desktop SDK headers do not declare. */
struct PipeLocalInformation {
  ULONG type, configuration, maximum_instances, current_instances, inbound_quota, read_data_available, outbound_quota,
    write_quota_available, state, end;
};
/** `FilePipeLocalInformation` and `FILE_PIPE_CONNECTED_STATE`. */
constexpr ULONG kPipeLocalInformationClass = 24;
constexpr ULONG kPipeConnectedState = 3;

/**
 * Whether the client end of the server pipe is still open. Messages a closed client wrote stay readable, so a
 * successful read does not show it; the pipe state does.
 */
bool client_open(HANDLE pipe) {
  using Query = LONG(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
  static const auto query = reinterpret_cast<Query>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile")));
  IO_STATUS_BLOCK status{};
  PipeLocalInformation information{};
  return query != nullptr && query(pipe, &status, &information, sizeof(information), kPipeLocalInformationClass) >= 0
    && information.state == kPipeConnectedState;
}

/** Owns one Win32 handle; null and INVALID_HANDLE_VALUE are both empty. */
class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { reset(); }
  HANDLE get() const { return value_; }
  bool valid() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE value = nullptr) {
    if (valid()) CloseHandle(value_);
    value_ = value;
  }
  /** Give up ownership without closing. */
  HANDLE release() {
    const auto value = value_;
    value_ = nullptr;
    return value;
  }
 private:
  HANDLE value_ = nullptr;
};

HANDLE to_handle(uint64_t value) { return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(value)); }
uint64_t from_handle(HANDLE value) { return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(value)); }

/** Why `serve` returned. */
enum class Served { Stopped, Disconnected, Terminal };

class PipeTransport final : public Transport {
 public:
  PipeTransport(uint32_t peer, std::string endpoint, HANDLE pipe, HANDLE stop, HANDLE drop, HANDLE read, HANDLE write)
    : peer_(peer), endpoint_(std::move(endpoint)), pipe_(pipe), stop_(stop), drop_(drop), read_(read), write_(write) {}

  const std::string& endpoint() const override { return endpoint_; }

  const char* run(Handler& handler) override {
    for (;;) {
      OVERLAPPED overlapped{};
      overlapped.hEvent = read_.get();
      DWORD error = ConnectNamedPipe(pipe_.get(), &overlapped) ? ERROR_SUCCESS : GetLastError();
      if (error == ERROR_IO_PENDING) {
        if (!wait(overlapped)) return nullptr;
        DWORD transferred = 0;
        error = GetOverlappedResult(pipe_.get(), &overlapped, &transferred, FALSE) ? ERROR_SUCCESS : GetLastError();
      }
      // A client that connected and left before this thread saw it.
      if (error == ERROR_NO_DATA) { DisconnectNamedPipe(pipe_.get()); continue; }
      if (error != ERROR_SUCCESS && error != ERROR_PIPE_CONNECTED) return "Shared-texture ingress endpoint failed";
      ULONG client = 0;
      // Another process that learned the endpoint name is disconnected before anything it wrote is read.
      if (!GetNamedPipeClientProcessId(pipe_.get(), &client) || client != peer_) {
        DisconnectNamedPipe(pipe_.get());
        continue;
      }
      Handle process(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, peer_));
      if (!process.valid()) {
        DisconnectNamedPipe(pipe_.get());
        continue;
      }
      ResetEvent(drop_.get());
      {
        std::lock_guard<std::mutex> lock(write_mutex_);
        connected_ = true;
      }
      const char* terminal = nullptr;
      const auto served = serve(handler, process.get(), terminal);
      {
        std::lock_guard<std::mutex> lock(write_mutex_);
        connected_ = false;
      }
      process.reset();
      DisconnectNamedPipe(pipe_.get());
      if (served == Served::Stopped) return nullptr;
      if (served == Served::Terminal) return terminal;
    }
  }

  void stop() override { SetEvent(stop_.get()); }

  void reply(uint64_t request_id, uint32_t kind, uint16_t flags, const char* error, size_t error_length) override {
    dstx::DstxReplyHeader header{dstx::kDstxMagic, dstx::kDstxVersion, kind, flags, static_cast<uint16_t>(error_length), request_id};
    unsigned char message[dstx::kMaxReplyBytes];
    std::memcpy(message, &header, sizeof(header));
    std::memcpy(message + sizeof(header), error, error_length);
    const auto size = static_cast<DWORD>(sizeof(header) + error_length);
    std::lock_guard<std::mutex> lock(write_mutex_);
    if (!connected_) return;
    OVERLAPPED overlapped{};
    overlapped.hEvent = write_.get();
    DWORD written = 0;
    bool ok = WriteFile(pipe_.get(), message, size, nullptr, &overlapped) != FALSE;
    if (!ok && GetLastError() == ERROR_IO_PENDING) {
      if (WaitForSingleObject(write_.get(), kReplyTimeoutMs) != WAIT_OBJECT_0) CancelIoEx(pipe_.get(), &overlapped);
      ok = true;
    }
    // Waiting here also completes a cancelled write, so `overlapped` is no longer in use when this returns.
    if (ok) ok = GetOverlappedResult(pipe_.get(), &overlapped, &written, TRUE) != FALSE && written == size;
    if (!ok) {
      connected_ = false;
      SetEvent(drop_.get());
    }
  }

 private:
  /** Wait for `overlapped` or `stop`; on stop, cancel and complete the operation and return false. */
  bool wait(OVERLAPPED& overlapped) {
    HANDLE events[] = {overlapped.hEvent, stop_.get()};
    if (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0) return true;
    cancel(overlapped);
    return false;
  }

  void cancel(OVERLAPPED& overlapped) {
    CancelIoEx(pipe_.get(), &overlapped);
    DWORD transferred = 0;
    GetOverlappedResult(pipe_.get(), &overlapped, &transferred, TRUE);
  }

  /** Serve the connected Host, whose handles Main duplicates through `host`, until it leaves or `stop`. */
  Served serve(Handler& handler, HANDLE host, const char*& terminal) {
    std::vector<unsigned char> buffer(dstx::kMaxPresentBytes);
    for (;;) {
      OVERLAPPED overlapped{};
      overlapped.hEvent = read_.get();
      DWORD error = ReadFile(pipe_.get(), buffer.data(), static_cast<DWORD>(buffer.size()), nullptr, &overlapped) ? ERROR_SUCCESS : GetLastError();
      if (error == ERROR_IO_PENDING) {
        HANDLE events[] = {read_.get(), stop_.get(), drop_.get()};
        const auto signaled = WaitForMultipleObjects(3, events, FALSE, INFINITE);
        if (signaled != WAIT_OBJECT_0) {
          cancel(overlapped);
          return signaled == WAIT_OBJECT_0 + 1 ? Served::Stopped : Served::Disconnected;
        }
        error = ERROR_SUCCESS;
      }
      DWORD size = 0;
      if (error == ERROR_SUCCESS && !GetOverlappedResult(pipe_.get(), &overlapped, &size, FALSE)) error = GetLastError();
      if (error == ERROR_MORE_DATA) { terminal = "Shared-texture ingress received an invalid message"; return Served::Terminal; }
      if (error != ERROR_SUCCESS) return Served::Disconnected;
      dstx::DstxPresentHeader header;
      if (size < sizeof(header)) { terminal = "Shared-texture ingress received an invalid message"; return Served::Terminal; }
      std::memcpy(&header, buffer.data(), sizeof(header));
      if (!dstx::valid_present(header, size - sizeof(header), true)) {
        terminal = "Shared-texture ingress received an invalid message";
        return Served::Terminal;
      }
      HANDLE local = nullptr;
      if (!DuplicateHandle(host, to_handle(header.win32_nt_handle), GetCurrentProcess(), &local, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        const char text[] = "Cannot duplicate the shared-texture handle from the Desktop Host";
        reply(header.request_id, dstx::DSTX_DELIVERED_ERROR, dstx::kDstxNoReferenceKept, text, sizeof(text) - 1);
        continue;
      }
      // The Host closed this connection and may have settled the request: the duplicate can be another object, and
      // the requests still queued carry the same risk, so the connection ends unread.
      if (!client_open(pipe_.get())) {
        CloseHandle(local);
        return Served::Disconnected;
      }
      Frame frame;
      frame.header = header;
      frame.metadata.assign(reinterpret_cast<const char*>(buffer.data() + sizeof(header)), header.metadata_length);
      frame.handle = from_handle(local);
      const auto queued = handler.frame(frame);
      if (queued == Queued::Accepted) continue;
      CloseHandle(local);
      if (queued == Queued::Closed) { terminal = "Shared-texture ingress delivery is closed"; return Served::Terminal; }
      const char text[] = "Shared-texture ingress queue is full";
      reply(header.request_id, dstx::DSTX_DELIVERED_ERROR, dstx::kDstxNoReferenceKept, text, sizeof(text) - 1);
    }
  }

  const uint32_t peer_;
  const std::string endpoint_;
  Handle pipe_, stop_, drop_, read_, write_;
  std::mutex write_mutex_;
  bool connected_ = false;  // Guarded by write_mutex_.
};

}  // namespace

std::unique_ptr<Transport> open_transport(uint32_t peer_pid, std::string& error) {
  unsigned char random[32];
  if (BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    error = "Cannot generate the shared-texture ingress endpoint";
    return nullptr;
  }
  const char* hex = "0123456789abcdef";
  std::string suffix;
  for (auto byte : random) { suffix += hex[byte >> 4]; suffix += hex[byte & 15]; }
  std::string endpoint = kPipePrefix + suffix;
  const std::wstring name(endpoint.begin(), endpoint.end());
  Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, kPipeBufferBytes, kPipeBufferBytes, 0, nullptr));
  Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr)), drop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  Handle read(CreateEventW(nullptr, TRUE, FALSE, nullptr)), write(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!pipe.valid() || !stop.valid() || !drop.valid() || !read.valid() || !write.valid()) {
    error = "Cannot create the shared-texture ingress endpoint";
    return nullptr;
  }
  return std::make_unique<PipeTransport>(peer_pid, std::move(endpoint), pipe.release(), stop.release(), drop.release(),
    read.release(), write.release());
}

void release_handle(uint64_t handle) { CloseHandle(to_handle(handle)); }

bool adapter_luid(uint64_t handle, std::string& luid) {
  Microsoft::WRL::ComPtr<IDXGIFactory2> factory;
  LUID value{};
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || FAILED(factory->GetSharedResourceAdapterLuid(to_handle(handle), &value))) {
    return false;
  }
  // Host addons format adapter LUIDs the same way and compare the text exactly.
  std::ostringstream id;
  id << std::hex << static_cast<uint32_t>(value.HighPart) << ':' << value.LowPart;
  luid = id.str();
  return true;
}

}  // namespace ingress
