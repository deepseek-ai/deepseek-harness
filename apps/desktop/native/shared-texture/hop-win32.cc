/**
 * Windows transport for `shared-texture-hop.node`: the client end of Main's duplex message pipe. A request carries
 * the texture's `HANDLE` value inside this process; Main duplicates it through its own handle to this process, so the
 * Host never opens Main. Sends are serialized overlapped writes; the reader keeps one overlapped read outstanding.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <vector>
#include "hop-transport.h"

namespace hop {
namespace {

constexpr char kPipePrefix[] = "\\\\.\\pipe\\dsh-shared-texture-";
/** Bound on waiting for Main to release the single pipe instance from a rejected client. */
constexpr DWORD kBusyTimeoutMs = 2000;

class PipeTransport final : public Transport {
 public:
  PipeTransport(HANDLE pipe, HANDLE read, HANDLE write, HANDLE wake) : pipe_(pipe), read_event_(read), write_event_(write), wake_event_(wake) {
    buffer_.resize(dstx::kMaxReplyBytes);
  }

  ~PipeTransport() override {
    if (reading_) {
      CancelIoEx(pipe_, &read_);
      DWORD transferred = 0;
      GetOverlappedResult(pipe_, &read_, &transferred, TRUE);
    }
    CloseHandle(pipe_);
    CloseHandle(read_event_);
    CloseHandle(write_event_);
    CloseHandle(wake_event_);
  }

  Sent send(const dstx::DstxPresentHeader& header, std::string_view metadata, uint64_t, std::string& error) override {
    const auto size = static_cast<DWORD>(sizeof(header) + metadata.size());
    std::lock_guard<std::mutex> lock(write_mutex_);
    std::memcpy(message_, &header, sizeof(header));
    if (!metadata.empty()) std::memcpy(message_ + sizeof(header), metadata.data(), metadata.size());
    OVERLAPPED overlapped{};
    overlapped.hEvent = write_event_;
    DWORD status = WriteFile(pipe_, message_, size, nullptr, &overlapped) ? ERROR_SUCCESS : GetLastError();
    if (status == ERROR_IO_PENDING) {
      if (WaitForSingleObject(write_event_, kSendTimeoutMs) != WAIT_OBJECT_0) CancelIoEx(pipe_, &overlapped);
      status = ERROR_SUCCESS;
    }
    DWORD written = 0;
    // Waiting here also completes a cancelled write, so `overlapped` is no longer in use when this returns.
    if (status == ERROR_SUCCESS && !GetOverlappedResult(pipe_, &overlapped, &written, TRUE)) status = GetLastError();
    if (status == ERROR_SUCCESS && written == size) return Sent::Sent;
    if (status == ERROR_BROKEN_PIPE || status == ERROR_NO_DATA || status == ERROR_PIPE_NOT_CONNECTED) {
      error = "Desktop shared-texture ingress disconnected";
      return Sent::Broken;
    }
    error = "Cannot deliver the shared texture to Desktop";
    return Sent::Failed;
  }

  Received receive(int64_t timeout_ms, Reply& reply) override {
    if (!reading_) {
      read_ = OVERLAPPED{};
      read_.hEvent = read_event_;
      const DWORD error = ReadFile(pipe_, buffer_.data(), static_cast<DWORD>(buffer_.size()), nullptr, &read_) ? ERROR_SUCCESS : GetLastError();
      if (error != ERROR_SUCCESS && error != ERROR_IO_PENDING) return Received::Disconnected;
      reading_ = true;
    }
    HANDLE events[] = {read_event_, wake_event_};
    const DWORD timeout = timeout_ms < 0 ? INFINITE : static_cast<DWORD>(std::min<int64_t>(timeout_ms, INFINITE - 1));
    const auto signaled = WaitForMultipleObjects(2, events, FALSE, timeout);
    if (signaled == WAIT_TIMEOUT) return Received::TimedOut;
    if (signaled == WAIT_OBJECT_0 + 1) return Received::Woken;
    if (signaled != WAIT_OBJECT_0) return Received::Disconnected;
    DWORD size = 0;
    const bool ok = GetOverlappedResult(pipe_, &read_, &size, FALSE) != FALSE;
    reading_ = false;
    // A failed read (Main closed the pipe) or an oversized message (ERROR_MORE_DATA) ends the connection.
    if (!ok || size < sizeof(reply.header)) return Received::Disconnected;
    std::memcpy(&reply.header, buffer_.data(), sizeof(reply.header));
    if (!dstx::valid_reply(reply.header, size - sizeof(reply.header))) return Received::Disconnected;
    reply.error.assign(reinterpret_cast<const char*>(buffer_.data() + sizeof(reply.header)), reply.header.error_length);
    return Received::Reply;
  }

  void wake() override { SetEvent(wake_event_); }

 private:
  HANDLE pipe_, read_event_, write_event_, wake_event_;
  std::mutex write_mutex_;
  /** The request being written; guarded by write_mutex_, and a pipe message is exactly its written prefix. */
  unsigned char message_[dstx::kMaxPresentBytes];
  // Reader thread only.
  OVERLAPPED read_{};
  bool reading_ = false;
  std::vector<unsigned char> buffer_;
};

bool valid_endpoint(const std::string& endpoint) {
  const size_t prefix = sizeof(kPipePrefix) - 1;
  if (endpoint.size() != prefix + 64 || endpoint.compare(0, prefix, kPipePrefix) != 0) return false;
  for (size_t index = prefix; index < endpoint.size(); ++index) {
    const char c = endpoint[index];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

}  // namespace

std::unique_ptr<Transport> connect(const std::string& endpoint, std::string& error) {
  error = "Desktop shared-texture ingress endpoint is unavailable";
  if (!valid_endpoint(endpoint)) return nullptr;
  const std::wstring name(endpoint.begin(), endpoint.end());
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kBusyTimeoutMs);
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (;;) {
    // Identification-level impersonation only: Main learns this process's identity but cannot act as it.
    pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) return nullptr;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (remaining <= 0) return nullptr;
    // A failed wait (the instance stayed busy or disappeared) is decided by the next CreateFileW.
    WaitNamedPipeW(name.c_str(), static_cast<DWORD>(remaining));
  }
  DWORD mode = PIPE_READMODE_MESSAGE;
  HANDLE read = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE write = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr) || !read || !write || !wake) {
    for (HANDLE handle : {pipe, read, write, wake}) if (handle) CloseHandle(handle);
    error = "Cannot connect to the Desktop shared-texture ingress";
    return nullptr;
  }
  error.clear();
  return std::make_unique<PipeTransport>(pipe, read, write, wake);
}

bool sends_handle_values() { return true; }

}  // namespace hop
