/**
 * Frame-forwarding receiver for a Node host process. One receiver is one logical channel: a stable listener and the
 * TX credential producers present. It serves one authenticated producer connection at a time; each connection owns
 * its frames, allocations, credits, send queue and GPU relay state. After a connection ends, its frames drain before
 * the next producer holding the credential receives ready, and credit never crosses connections. Host-local texture
 * handles reach JavaScript, which hands them on and releases each delivery. Node-API only.
 */
#include "transport.h"
#include "desktop-bridge.h"
#include <node_api.h>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <map>
#include <deque>
#include <algorithm>
#include <thread>
#include <cmath>
#if defined(__APPLE__)
#include <stdlib.h>
#else
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#endif
using namespace dsh_frame_forwarding;
namespace {
enum class PresentationPath { iosurface, shared_texture, gpu_copy, cpu_relay };
PresentationPath resolve_presentation_path(const std::string& producer, const std::string& display, bool keyed_mutex = false) {
#if defined(_WIN32)
  if (producer == display && keyed_mutex) return PresentationPath::shared_texture;
  return producer == display ? PresentationPath::gpu_copy : PresentationPath::cpu_relay;
#else
  (void)producer; (void)display; (void)keyed_mutex;
  return PresentationPath::iosurface;
#endif
}
uint32_t allocation_bytes_factor(PresentationPath path) {
  switch (path) {
    case PresentationPath::iosurface: return 1;
    case PresentationPath::shared_texture: return 1;
    case PresentationPath::gpu_copy: return 2;
    case PresentationPath::cpu_relay: return 1;
  }
  throw std::logic_error("Unknown native presentation path");
}
uint64_t source_byte_budget(PresentationPath path, uint32_t frames, uint64_t bytes) {
  return path == PresentationPath::cpu_relay ? bytes / (2 * frames + 2) * frames : bytes / allocation_bytes_factor(path);
}
struct FrameLedger;
struct Connection;
struct Event {
  std::string type, text, adapter, presentation_adapter;
  Packet packet; uintptr_t resource = 0; uint32_t pid = 0; uint64_t delivery = 0, connection = 0;
  std::shared_ptr<FrameLedger> ledger;
  /** The connection a frame came from; a frame that cannot be delivered ends it. */
  std::weak_ptr<Connection> source;
  bool delivered = false, source_keyed_mutex = false;
  std::chrono::steady_clock::time_point deadline;
  // The dispatched item can outlive its connection and the receiver, including during environment teardown.
  std::shared_ptr<std::atomic<unsigned>> pending;
  bool reserve(const std::shared_ptr<std::atomic<unsigned>>& count, unsigned limit) {
    // dispatch_mutex serializes reservations; only destruction can change the count concurrently, downwards.
    if (count->load() >= limit) return false;
    ++*count; pending = count; return true;
  }
  ~Event();
};
struct GrantWake {
  std::mutex mutex;
  std::condition_variable ready;
  std::deque<Packet> packets;
  bool grants_pending = false, closed = false;
  void notify() {
    std::lock_guard<std::mutex> lock(mutex);
    if (closed) return;
    grants_pending = true; ready.notify_one();
  }
};
struct Reservation {
  uint64_t id, bytes;
  std::atomic<bool> granted{false};
  bool sent = false, cancelled = false;
  std::weak_ptr<GrantWake> wake;
};
struct ReservationGroup {
  std::vector<std::weak_ptr<Reservation>> members;
};
struct Budget {
  uint64_t limit, used = 0;
  std::mutex mutex;
  std::deque<ReservationGroup> waiting;
  explicit Budget(uint64_t bytes) : limit(bytes) {}
  void advance() {
    while (!waiting.empty()) {
      auto& group = waiting.front();
      uint64_t bytes = 0;
      for (auto& member : group.members) if (auto next = member.lock()) if (!next->cancelled) bytes += next->bytes;
      if (!bytes) { waiting.pop_front(); continue; }
      if (bytes > limit - used) break;
      for (auto& member : group.members) if (auto next = member.lock()) {
        if (next->cancelled) continue;
        used += next->bytes; next->granted = true;
        if (auto wake = next->wake.lock()) wake->notify();
      }
      waiting.pop_front();
    }
  }
  std::shared_ptr<Reservation> request(uint64_t id, uint64_t bytes, const std::shared_ptr<GrantWake>& wake) {
    auto result = std::make_shared<Reservation>(); result->id = id; result->bytes = bytes; result->wake = wake;
    request_group({result}); return result;
  }
  void request_group(const std::vector<std::shared_ptr<Reservation>>& members) {
    ReservationGroup group;
    for (const auto& member : members) group.members.push_back(member);
    std::lock_guard<std::mutex> lock(mutex); waiting.push_back(std::move(group)); advance();
  }
  void release(const std::shared_ptr<Reservation>& reservation) {
    std::lock_guard<std::mutex> lock(mutex);
    if (reservation->cancelled) return;
    reservation->cancelled = true;
    if (reservation->granted) used -= reservation->bytes;
    advance();
  }
};
#if defined(_WIN32)
template<class Texture> struct RelayStorage {
  std::shared_ptr<Texture> texture;
  std::shared_ptr<Budget> budget;
  std::vector<std::shared_ptr<Reservation>> reservations;
  ~RelayStorage() { texture.reset(); for (auto& reservation : reservations) budget->release(reservation); }
};
using RelayTarget = RelayStorage<RelayTexture>;
using RelayStaging = RelayStorage<RelayReadback>;
#endif
/** Wakes a disconnected connection waiting for its drain whenever one of its frames is released. */
struct DrainSignal {
  std::mutex mutex;
  std::condition_variable changed;
  void notify() { std::lock_guard<std::mutex> lock(mutex); changed.notify_all(); }
};
struct HeldFrame {
  uintptr_t resource; uint64_t bytes, allocation, source_id;
#if defined(_WIN32)
  std::shared_ptr<RelayTexture> relay;
  std::shared_ptr<RelayTarget> target;
#endif
  bool delivered = false;
};
struct FrameLedger {
  std::mutex mutex;
  std::map<uint64_t, HeldFrame> frames;
  std::map<uint64_t, std::shared_ptr<Reservation>> allocations;
  std::shared_ptr<Budget> budget;
  std::shared_ptr<DrainSignal> drain;
  uint64_t bytes = 0;
  std::atomic<bool> connected{false};
  std::atomic<bool> accepting_frames{true};
  /** No frame of this connection remains: every delivery was released and every undispatched frame discarded. */
  bool empty() { std::lock_guard<std::mutex> lock(mutex); return frames.empty(); }
  ~FrameLedger() {
    for (auto& frame : frames) if (frame.second.resource) release_resource(frame.second.resource);
    frames.clear();
    for (auto& allocation : allocations) budget->release(allocation.second);
  }
  void retire_idle() {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto allocation = allocations.begin(); allocation != allocations.end();) {
      bool used = false;
      for (auto& frame : frames) if (frame.second.resource && frame.second.allocation == allocation->first) { used = true; break; }
      if (used) { ++allocation; continue; }
      budget->release(allocation->second); allocation = allocations.erase(allocation);
    }
  }
  bool release(uint64_t id, bool delivered_only = false, uint64_t* source_id = nullptr) {
    uintptr_t resource = 0;
    bool released = false;
    {
      std::lock_guard<std::mutex> lock(mutex);
      auto found = frames.find(id);
      if (found != frames.end() && (!delivered_only || found->second.delivered)) {
        resource = found->second.resource;
        if (resource) {
          bytes -= found->second.bytes;
          if (source_id) *source_id = found->second.source_id;
        }
        frames.erase(found); released = true;
      }
    }
    if (!released) return false;
    if (resource) release_resource(resource);
    if (!connected) retire_idle();
    if (drain) drain->notify();
    return true;
  }
  uint64_t release_source(uint64_t delivery) {
    uintptr_t resource; uint64_t source;
    {
      std::lock_guard<std::mutex> lock(mutex);
      auto& frame = frames.at(delivery); resource = frame.resource; source = frame.source_id;
      frame.resource = 0; bytes -= frame.bytes;
    }
    release_resource(resource); return source;
  }
};
Event::~Event() {
  // A frame discarded before its callback has no JavaScript owner to return its credit.
  if (ledger && !delivered) ledger->release(delivery);
  if (pending) --*pending;
}
struct GpuJob {
  std::unique_ptr<Event> event;
  uint64_t allocation = 0;
  std::shared_ptr<Reservation> retirement;
#if defined(_WIN32)
  std::shared_ptr<RelayTexture> texture;
  std::shared_ptr<RelayStaging> staging;
  std::shared_ptr<RelayTarget> target;
#endif
  bool ready = false;
};
struct Receiver;
/**
 * One producer connection of a channel and every resource it owns. Its thread reads the producer, then drains: the
 * connection stays current until each of its frames is released, so its credit and GPU state never reach a successor.
 */
struct Connection : std::enable_shared_from_this<Connection> {
  Receiver& owner;
  const uint64_t id;
  const uint32_t pid;
  std::unique_ptr<Channel> channel;
  uint32_t max_frames;
  uint64_t max_bytes;
  PresentationPath presentation_path = PresentationPath::iosurface;
  uint32_t readback_timeout = 0, allocation_factor = allocation_bytes_factor(presentation_path);
  std::string display_adapter, producer_adapter;
#if defined(_WIN32)
  std::shared_ptr<RelayDevice> relay_device;
  std::map<uint64_t, std::shared_ptr<RelayTexture>> relay_textures;
  std::vector<std::shared_ptr<RelayTarget>> relay_targets;
  std::vector<std::shared_ptr<RelayStaging>> relay_staging;
  uint64_t pool_bytes = 0;
  HANDLE jobs_event = nullptr, retry_timer = nullptr;
  bool wait_failed = false;
#endif
  std::atomic<bool> stopped{false};
  std::shared_ptr<std::atomic<unsigned>> pending_events = std::make_shared<std::atomic<unsigned>>(0);
  std::shared_ptr<FrameLedger> ledger = std::make_shared<FrameLedger>();
  std::thread thread, writer, copier;
  std::mutex jobs_mutex;
  std::condition_variable jobs_ready;
  std::deque<GpuJob> jobs;
  bool input_done = false;
  std::shared_ptr<GrantWake> output = std::make_shared<GrantWake>();
  /** Why the connection ended; empty after the producer's goodbye. */
  std::mutex failure_mutex;
  std::string failure;
  Connection(Receiver& receiver, uint64_t connection, uint32_t producer, std::unique_ptr<Channel> link);
  ~Connection() {
#if defined(_WIN32)
    if (jobs_event) CloseHandle(jobs_event);
    if (retry_timer) CloseHandle(retry_timer);
#endif
  }
  void notify_jobs() {
    jobs_ready.notify_all();
#if defined(_WIN32)
    if (jobs_event) SetEvent(jobs_event);
#endif
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(output->mutex);
      if (stopped) return;
      ledger->accepting_frames = false;
      stopped = true;
      output->closed = true;
      // Any thread may stop a connection; run() releases the channel under the same lock.
      if (channel) channel->interrupt();
    }
    output->ready.notify_all(); notify_jobs();
  }
  bool enqueue(const Packet& packet) {
    std::lock_guard<std::mutex> lock(output->mutex);
    if (stopped || !ledger->connected || output->packets.size() >= 256) return false;
    output->packets.push_back(packet); output->ready.notify_one(); return true;
  }
  void write_loop() {
    while (!stopped) {
      Packet packet; bool have_packet = false, have_grants = false;
      {
        std::unique_lock<std::mutex> lock(output->mutex);
        output->ready.wait(lock, [&] { return stopped || output->grants_pending || !output->packets.empty(); });
        if (stopped) break;
        have_grants = output->grants_pending; output->grants_pending = false;
        if (!output->packets.empty()) { packet = output->packets.front(); output->packets.pop_front(); have_packet = true; }
      }
      if (have_grants) grants();
      if (have_packet && !stopped && !channel->send(packet)) { stop(); break; }
    }
  }
  bool emit(Event* event);
  /** End this connection with a reason; the first reason is kept. */
  void fail_connection(const std::string& text) {
    { std::lock_guard<std::mutex> lock(failure_mutex); if (failure.empty()) failure = text; }
    stop();
  }
  /** GPU completion is unknown: resources and budget stay retained and the drain waits, so report it without timing out. */
  void report_blocked(const std::string& text);
  void grants() {
    std::lock_guard<std::mutex> lock(ledger->mutex);
    for (auto& allocation : ledger->allocations) {
      if (!allocation.second->granted || allocation.second->sent) continue;
      Packet packet; packet.kind = allocated; packet.allocation_id = allocation.first;
      if (!channel->send(packet)) { stop(); return; }
      allocation.second->sent = true;
    }
  }
#if defined(_WIN32)
  std::shared_ptr<Reservation> reserve_relay(uint64_t id, uint64_t bytes) {
    auto source = std::make_shared<Reservation>(); source->id = id; source->bytes = bytes; source->wake = output;
    std::vector<std::shared_ptr<Reservation>> group{source};
    if (relay_targets.empty()) {
      for (uint32_t index = 0; index < max_frames; ++index) {
        auto slot = std::make_shared<RelayTarget>(); slot->budget = ledger->budget; relay_targets.push_back(std::move(slot));
      }
      for (uint32_t index = 0; index < 2; ++index) {
        auto slot = std::make_shared<RelayStaging>(); slot->budget = ledger->budget; relay_staging.push_back(std::move(slot));
      }
    }
    if (bytes > pool_bytes) {
      const auto reserve = [&](auto& slots) {
        for (auto& slot : slots) {
          auto reservation = std::make_shared<Reservation>(); reservation->id = 0; reservation->bytes = bytes - pool_bytes;
          slot->reservations.push_back(reservation); group.push_back(std::move(reservation));
        }
      };
      reserve(relay_targets); reserve(relay_staging); pool_bytes = bytes;
    }
    ledger->budget->request_group(group); return source;
  }
#endif
  bool post(GpuJob&& job) {
    {
      std::lock_guard<std::mutex> lock(jobs_mutex);
      if (stopped || jobs.size() >= 256) return false;
      try { jobs.push_back(std::move(job)); }
      catch (const std::bad_alloc&) { return false; }
    }
    notify_jobs(); return true;
  }
  void prepare_frame(GpuJob& job) {
    auto& event = *job.event;
    std::string diagnostic, adapter;
    if (stopped) return;
    if (std::chrono::steady_clock::now() >= event.deadline) throw std::runtime_error("Frame-forwarding frame expired in GPU queue");
    const auto& packet = event.packet;
    if (!resource_dimensions(event.resource, packet.width, packet.height, packet.stride, event.deadline, diagnostic, adapter, &event.source_keyed_mutex)) throw std::runtime_error(diagnostic);
    if (!producer_adapter.empty() && producer_adapter != adapter) throw std::runtime_error("Frame-forwarding texture adapter differs from producer handshake");
    event.adapter = adapter;
#if defined(_WIN32)
    switch (presentation_path) {
    case PresentationPath::shared_texture:
      if (!event.source_keyed_mutex) throw std::runtime_error("Producer declared keyed mutex support but supplied a legacy texture");
      job.ready = true;
      break;
    case PresentationPath::gpu_copy: {
      if (event.source_keyed_mutex) {
        job.ready = true;
        break;
      }
      // The pool owns the slot before submission, including failed fence notifications.
      auto& slot = relay_textures[packet.allocation_id];
      const auto submitted = relay_begin(event.resource, packet.width, packet.height, display_adapter, event.deadline, stopped, relay_device, slot, diagnostic);
      job.texture = slot;
      if (!submitted) throw std::runtime_error(diagnostic);
      {
        std::lock_guard<std::mutex> lock(ledger->mutex);
        ledger->frames.at(event.delivery).relay = slot;
      }
      event.resource = relay_handle(slot);
      break;
    }
    case PresentationPath::cpu_relay: throw std::logic_error("Relay frames require independent source preparation");
    case PresentationPath::iosurface: break;
    }
    event.presentation_adapter = display_adapter;
#endif
  }
  void deliver_frame(std::unique_ptr<Event> event) {
    if (stopped) return;
    if (std::chrono::steady_clock::now() >= event->deadline) throw std::runtime_error("Frame-forwarding frame expired before delivery");
    emit(event.release());
  }
  void process_frame(std::unique_ptr<Event> event) {
    GpuJob job; job.event = std::move(event);
    try { prepare_frame(job); deliver_frame(std::move(job.event)); }
    catch (const std::exception& exception) { fail_connection(exception.what()); }
  }
#if defined(_WIN32)
  bool gpu_idle(std::string& diagnostic) {
    bool idle = true;
    for (auto& slot : relay_textures) if (!relay_gpu_idle(slot.second, diagnostic)) idle = false;
    return idle;
  }
  void wait_gpu(const std::deque<GpuJob>& active, bool retiring) {
    if (wait_failed) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); return; }
    std::vector<HANDLE> waits;
    if (!retiring) waits.push_back(jobs_event);
    int64_t wait_ns = retiring ? 5000000 : INT64_MAX;
    const auto add_event = [&](uintptr_t raw) {
      if (raw && waits.size() < MAXIMUM_WAIT_OBJECTS - 1) waits.push_back(reinterpret_cast<HANDLE>(raw));
      else wait_ns = std::min<int64_t>(wait_ns, 1000000);
    };
    if (retiring) {
      for (auto& slot : relay_textures) add_event(relay_completion_event(slot.second));
    } else for (const auto& job : active) {
      if (job.ready) continue;
      wait_ns = std::min<int64_t>(wait_ns, std::chrono::duration_cast<std::chrono::nanoseconds>(job.event->deadline - std::chrono::steady_clock::now()).count());
      add_event(relay_completion_event(job.texture));
    }
    if (wait_ns != INT64_MAX) {
      LARGE_INTEGER due; due.QuadPart = -std::max<int64_t>(1, wait_ns / 100);
      if (!SetWaitableTimer(retry_timer, &due, 0, nullptr, nullptr, FALSE)) {
        wait_failed = true; fail_connection("Frame-forwarding GPU retry timer failed; retaining unfinished GPU resources"); return;
      }
      waits.push_back(retry_timer);
    }
    if (WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE) == WAIT_FAILED) {
      wait_failed = true; fail_connection("Frame-forwarding GPU worker wait failed; retaining unfinished GPU resources");
    }
  }
  bool advance(GpuJob& job) {
    if (job.ready) return true;
    std::string diagnostic;
    const auto ready = relay_advance(job.texture, stopped, job.event->deadline, diagnostic);
    if (ready < 0) throw std::runtime_error(diagnostic);
    job.ready = ready == 1; return job.ready;
  }
  void deliver_ready(std::deque<GpuJob>& active) {
    while (!stopped && !active.empty() && advance(active.front())) {
      deliver_frame(std::move(active.front().event)); active.pop_front();
    }
  }
  template<class Slot> std::shared_ptr<Slot> available_slot(const std::vector<std::shared_ptr<Slot>>& slots) {
    for (auto& slot : slots) if (slot.use_count() == 1) return slot;
    return {};
  }
  bool relay_idle(std::string& diagnostic) {
    bool idle = true;
    for (auto& slot : relay_staging) if (relay_readback_ready(slot->texture, true, diagnostic) <= 0) idle = false;
    for (auto& slot : relay_targets) if (!relay_gpu_idle(slot->texture, diagnostic)) idle = false;
    return idle;
  }
  void wait_relay(const GpuJob* reading, const GpuJob* uploading, const std::deque<GpuJob>& pending, bool retiring) {
    if (wait_failed) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); return; }
    std::vector<HANDLE> waits;
    int64_t wait_ns = retiring ? 5000000 : INT64_MAX;
    const auto add = [&](uintptr_t event) {
      if (event && waits.size() < MAXIMUM_WAIT_OBJECTS - 1) waits.push_back(reinterpret_cast<HANDLE>(event));
      else wait_ns = std::min<int64_t>(wait_ns, 1000000);
    };
    const auto deadline = [&](const GpuJob& job) {
      wait_ns = std::min<int64_t>(wait_ns, std::chrono::duration_cast<std::chrono::nanoseconds>(job.event->deadline - std::chrono::steady_clock::now()).count());
    };
    if (retiring) {
      for (auto& slot : relay_staging) add(relay_readback_event(slot->texture));
      for (auto& slot : relay_targets) add(relay_completion_event(slot->texture));
    } else {
      {
        std::lock_guard<std::mutex> lock(jobs_mutex);
        ResetEvent(jobs_event);
        if (stopped || (!jobs.empty() && (jobs.front().retirement || (!reading && available_slot(relay_staging))))) return;
      }
      waits.push_back(jobs_event);
      if (reading) { add(relay_readback_event(reading->staging->texture)); deadline(*reading); }
      if (uploading) { add(relay_completion_event(uploading->texture)); deadline(*uploading); }
      if (!pending.empty()) {
        deadline(pending.front());
        if (!uploading && available_slot(relay_targets)) wait_ns = std::min<int64_t>(wait_ns, 1000000);
      }
    }
    if (wait_ns != INT64_MAX) {
      LARGE_INTEGER due; due.QuadPart = -std::max<int64_t>(1, wait_ns / 100);
      if (!SetWaitableTimer(retry_timer, &due, 0, nullptr, nullptr, FALSE)) {
        wait_failed = true; fail_connection("Frame-forwarding GPU retry timer failed; retaining unfinished GPU resources"); return;
      }
      waits.push_back(retry_timer);
    }
    if (WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE) == WAIT_FAILED) {
      wait_failed = true; fail_connection("Frame-forwarding GPU worker wait failed; retaining unfinished GPU resources");
    }
  }
  void relay_loop() {
    std::map<uint64_t, std::shared_ptr<RelaySource>> sources;
    std::unique_ptr<GpuJob> reading, uploading;
    std::deque<GpuJob> pending;
    bool retiring = false, stalled_reported = false;
    std::chrono::steady_clock::time_point cleanup_deadline;
    for (;;) {
      if (stopped) {
        if (!retiring) { retiring = true; cleanup_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(readback_timeout); }
        std::string diagnostic;
        if (!relay_idle(diagnostic)) {
          if (!stalled_reported && std::chrono::steady_clock::now() >= cleanup_deadline) {
            stalled_reported = true; report_blocked("Frame-forwarding GPU cleanup is stalled; resources and budget remain retained");
          }
          wait_relay(reading.get(), uploading.get(), pending, true); continue;
        }
        reading.reset(); uploading.reset(); pending.clear(); sources.clear();
        std::deque<GpuJob> remaining;
        { std::lock_guard<std::mutex> lock(jobs_mutex); remaining.swap(jobs); }
        for (auto& job : remaining) if (job.retirement) ledger->budget->release(job.retirement);
        break;
      }
      try {
        std::string diagnostic;
        if (uploading && advance(*uploading)) {
          deliver_frame(std::move(uploading->event)); uploading.reset();
        }
        if (reading) {
          if (std::chrono::steady_clock::now() >= reading->event->deadline) throw std::runtime_error("Frame-forwarding source readback timed out");
          const auto complete = relay_readback_ready(reading->staging->texture, false, diagnostic);
          if (complete < 0) throw std::runtime_error(diagnostic);
          if (complete > 0) {
            Packet packet; packet.kind = dsh_frame_forwarding::release; packet.frame_id = ledger->release_source(reading->event->delivery);
            if (!enqueue(packet)) throw std::runtime_error("Cannot return frame-forwarding source credit");
            // A staged replaceable frame supersedes older staged replaceable frames; ordered frames stay queued.
            if (reading->event->packet.max_frames & frame_replaceable) {
              pending.erase(std::remove_if(pending.begin(), pending.end(),
                [](const GpuJob& job) { return (job.event->packet.max_frames & frame_replaceable) != 0; }), pending.end());
            }
            pending.push_back(std::move(*reading)); reading.reset();
          }
        }
        if (!uploading && !pending.empty()) {
          auto& job = pending.front();
          if (std::chrono::steady_clock::now() >= job.event->deadline) throw std::runtime_error("Frame-forwarding frame expired before upload");
          auto target = available_slot(relay_targets);
          if (target) {
            const auto& packet = job.event->packet;
            const auto submitted = relay_upload(job.staging->texture, packet.width, packet.height, display_adapter,
              relay_device, target->texture, job.event->deadline, stopped, diagnostic);
            if (submitted < 0) throw std::runtime_error(diagnostic);
            if (submitted > 0) {
              job.target = target; job.texture = target->texture; job.staging.reset();
              job.event->resource = relay_handle(target->texture); job.event->presentation_adapter = display_adapter;
              { std::lock_guard<std::mutex> lock(ledger->mutex); ledger->frames.at(job.event->delivery).target = target; }
              uploading = std::make_unique<GpuJob>(std::move(job)); pending.pop_front();
            }
          }
        }
        GpuJob job; bool found = false;
        std::shared_ptr<RelayStaging> staging;
        if (!reading) staging = available_slot(relay_staging);
        {
          std::lock_guard<std::mutex> lock(jobs_mutex);
          if (!jobs.empty() && (jobs.front().retirement || staging)) {
            job = std::move(jobs.front()); jobs.pop_front(); found = true;
          }
        }
        if (found) {
          if (job.retirement) {
            sources.erase(job.allocation);
            ledger->budget->release(job.retirement);
          }
          else {
            auto& event = *job.event; const auto& packet = event.packet;
            if (std::chrono::steady_clock::now() >= event.deadline) throw std::runtime_error("Frame-forwarding frame expired in source queue");
            job.staging = staging;
            if (!relay_readback_begin(event.resource, packet.width, packet.height, packet.stride, staging->texture, sources[packet.allocation_id], diagnostic,
                event.adapter, &event.source_keyed_mutex, event.deadline)) throw std::runtime_error(diagnostic);
            if (producer_adapter != event.adapter) throw std::runtime_error("Frame-forwarding texture adapter differs from producer handshake");
            reading = std::make_unique<GpuJob>(std::move(job));
          }
          continue;
        }
      } catch (const std::exception& exception) { fail_connection(exception.what()); continue; }
      wait_relay(reading.get(), uploading.get(), pending, false);
    }
    { std::lock_guard<std::mutex> lock(ledger->mutex); relay_staging.clear(); relay_targets.clear(); }
    relay_device.reset(); clear_validation_device();
  }
#endif
  void copy_loop() {
#if defined(_WIN32)
    {
      std::unique_lock<std::mutex> lock(jobs_mutex);
      jobs_ready.wait(lock, [&] { return input_done || !jobs.empty(); });
    }
    if (presentation_path == PresentationPath::cpu_relay) { relay_loop(); return; }
#endif
    std::deque<GpuJob> active;
#if defined(_WIN32)
    bool retiring = false, stalled_reported = false;
    std::chrono::steady_clock::time_point cleanup_deadline;
#endif
    for (;;) {
#if defined(_WIN32)
      if (stopped) {
        if (!retiring) { retiring = true; cleanup_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(readback_timeout); }
        std::string diagnostic;
        if (!gpu_idle(diagnostic)) {
          if (!stalled_reported && std::chrono::steady_clock::now() >= cleanup_deadline) {
            stalled_reported = true;
            report_blocked("Frame-forwarding GPU cleanup is stalled; resources and budget remain retained");
          }
          wait_gpu(active, true); continue;
        }
        // All submitted copies completed or their device was removed before ownership is released.
        active.clear();
      } else {
        try {
          deliver_ready(active);
          for (size_t index = 1; !stopped && index < active.size(); ++index) {
            // A completed head is delivered before another slot performs Map or upload.
            const auto prior_size = active.size(); deliver_ready(active);
            if (active.size() != prior_size) break;
            advance(active[index]);
          }
          deliver_ready(active);
        } catch (const std::exception& exception) { fail_connection(exception.what()); continue; }
      }
#endif
      GpuJob job; bool found = false, finished;
      {
        std::lock_guard<std::mutex> lock(jobs_mutex);
        if (!jobs.empty()) { job = std::move(jobs.front()); jobs.pop_front(); found = true; }
        finished = input_done && jobs.empty();
#if defined(_WIN32)
        if (!found) ResetEvent(jobs_event);
#endif
      }
      if (found) {
        if (job.retirement) {
#if defined(_WIN32)
          relay_textures.erase(job.allocation);
#endif
          ledger->budget->release(job.retirement);
        } else if (!stopped) {
          try {
            prepare_frame(job);
#if defined(_WIN32)
            if (job.texture) active.push_back(std::move(job));
            else
#endif
            deliver_frame(std::move(job.event));
          } catch (const std::exception& exception) { fail_connection(exception.what()); }
        }
        continue;
      }
      if (finished && active.empty()) break;
#if defined(_WIN32)
      wait_gpu(active, false);
#else
      std::unique_lock<std::mutex> lock(jobs_mutex);
      jobs_ready.wait(lock, [&] { return input_done || !jobs.empty(); });
#endif
    }
    clear_validation_device();
#if defined(_WIN32)
    relay_textures.clear(); relay_device.reset();
#endif
  }
  uint64_t next_delivery();
  void read_loop() {
    while (!stopped) {
      Received received;
      int result = channel->receive(received, 100);
      if (result == 0) continue;
      if (result < 0) {
        if (channel->foreign_packet()) fail_connection("Frame-forwarding producer sent a packet for another connection");
        else if (channel->invalid_resource()) fail_connection("Frame-forwarding producer sent a handle it does not own");
        else if (!stopped) fail_connection("Frame-forwarding producer connection lost");
        break;
      }
      const auto received_at = std::chrono::steady_clock::now();
      auto& packet = received.packet;
      if (packet.marker != magic || !std::memchr(packet.text, 0, sizeof(packet.text))) {
        release_resource(received.resource); fail_connection("Frame-forwarding producer sent an invalid packet"); break;
      }
      if (packet.version != DSH_FRAME_FORWARDING_PROTOCOL_VERSION) {
        release_resource(received.resource);
        fail_connection("Frame-forwarding protocol mismatch: producer version " + std::to_string(packet.version)
          + ", receiver version " + std::to_string(DSH_FRAME_FORWARDING_PROTOCOL_VERSION));
        break;
      }
      if (packet.kind == allocate && !received.resource) {
        bool valid;
        {
          std::lock_guard<std::mutex> lock(ledger->mutex);
          uint64_t reserved = 0; for (auto& allocation : ledger->allocations) reserved += allocation.second->bytes / allocation_factor;
          valid = !stopped && packet.allocation_id && !ledger->allocations.count(packet.allocation_id) && ledger->allocations.size() < max_frames &&
            packet.max_bytes && packet.max_bytes <= source_byte_budget(presentation_path, max_frames, max_bytes) &&
            reserved <= source_byte_budget(presentation_path, max_frames, max_bytes) - packet.max_bytes;
#if defined(_WIN32)
          if (presentation_path == PresentationPath::cpu_relay) {
            valid = valid && packet.max_bytes <= max_bytes / (2 * max_frames + 2);
            if (valid) ledger->allocations.emplace(packet.allocation_id, reserve_relay(packet.allocation_id, packet.max_bytes));
          } else
#endif
          if (valid) ledger->allocations.emplace(packet.allocation_id, ledger->budget->request(packet.allocation_id, packet.max_bytes * allocation_factor, output));
        }
        if (!valid) { fail_connection("Invalid frame-forwarding allocation request"); break; }
      } else if (packet.kind == deallocate && !received.resource) {
        bool used = false;
        std::shared_ptr<Reservation> reservation;
        {
          std::lock_guard<std::mutex> lock(ledger->mutex);
          for (auto& frame : ledger->frames) if (frame.second.resource && frame.second.allocation == packet.allocation_id) used = true;
          auto allocation = ledger->allocations.find(packet.allocation_id);
          if (!used && allocation != ledger->allocations.end()) {
            reservation = allocation->second; ledger->allocations.erase(allocation);
          }
        }
        if (used) { fail_connection("Producer released an in-use frame-forwarding allocation"); break; }
        if (reservation) {
          GpuJob job{{}, packet.allocation_id, std::move(reservation)};
          if (!post(std::move(job))) {
            // Close retires this reservation after the worker has drained its GPU resources.
            { std::lock_guard<std::mutex> lock(ledger->mutex); ledger->allocations.emplace(packet.allocation_id, std::move(job.retirement)); }
            fail_connection("Frame-forwarding GPU job queue rejected allocation retirement"); break;
          }
        }
        if (presentation_path == PresentationPath::iosurface) clear_validation_device();
      } else if (packet.kind == frame) {
        if (!received.resource || !packet.frame_id || packet.frame_id > 9007199254740991ULL ||
            !packet.width || !packet.height || packet.width > 16384 || packet.height > 16384 ||
#if defined(__APPLE__)
            // IOSurface aligns row pitch; resource_dimensions checks the actual surface stride.
            packet.stride < packet.width * 4) {
#else
            packet.stride != packet.width * 4) {
#endif
          release_resource(received.resource); fail_connection("Invalid frame-forwarding frame fields"); break;
        }
#if defined(__APPLE__)
        const auto size = resource_bytes(received.resource);
#else
        const auto size = static_cast<uint64_t>(packet.stride) * packet.height;
#endif
        bool accepted;
        const auto delivery = next_delivery();
        {
          std::lock_guard<std::mutex> lock(ledger->mutex);
          auto allocation = ledger->allocations.find(packet.allocation_id);
          size_t source_count = 0;
          for (auto& frame : ledger->frames) if (frame.second.resource) ++source_count;
          accepted = allocation != ledger->allocations.end() && allocation->second->granted && size <= allocation->second->bytes / allocation_factor && source_count < max_frames && size <= max_bytes && ledger->bytes <= max_bytes - size && delivery <= 9007199254740991ULL;
          for (auto& frame : ledger->frames) if (frame.second.resource && (frame.second.allocation == packet.allocation_id || frame.second.source_id == packet.frame_id)) accepted = false;
          if (accepted) { ledger->frames.emplace(delivery, HeldFrame{received.resource, size, packet.allocation_id, packet.frame_id}); ledger->bytes += size; }
        }
        if (!accepted) { release_resource(received.resource); fail_connection("Frame-forwarding frame budget or identifier violated"); break; }
        auto event = std::make_unique<Event>(); event->type = "frame"; event->packet = packet; event->resource = received.resource; event->delivery = delivery;
        event->ledger = ledger; event->source = weak_from_this(); event->deadline = received_at + std::chrono::milliseconds(readback_timeout);
        if (presentation_path == PresentationPath::iosurface) process_frame(std::move(event));
        else {
          GpuJob job; job.event = std::move(event);
          if (!post(std::move(job))) { fail_connection("Frame-forwarding GPU job queue rejected frame"); break; }
        }
      } else if (packet.kind == message && !received.resource) {
        auto event = new Event; event->type = "message"; event->text = packet.text; if (!emit(event)) break;
      } else if (packet.kind == goodbye && !received.resource) break;
      else { release_resource(received.resource); fail_connection("Unexpected frame-forwarding message"); break; }
    }
  }
  void run();
};
struct CloseWork { napi_deferred deferred = nullptr; napi_ref keep = nullptr; };
/** Constant-time comparison of a presented TX secret. */
bool same_secret(const char (&presented)[65], const std::string& expected) {
  if (!std::memchr(presented, 0, sizeof(presented)) || std::strlen(presented) != expected.size()) return false;
  unsigned char difference = 0;
  for (size_t index = 0; index < expected.size(); ++index) difference |= static_cast<unsigned char>(presented[index] ^ expected[index]);
  return difference == 0;
}
/**
 * One logical channel: Idle, Active(N) and Draining(N) while it accepts producers, then Closed. While connection N is
 * active, other candidates are refused as busy; while it drains, one authenticated successor waits and others are
 * refused. The successor receives ready once N's frames are released.
 */
struct Receiver {
  napi_env env = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  // Signals worker completion to the JavaScript thread; its finalizer frees the owning holder.
  napi_threadsafe_function done = nullptr;
  std::atomic<bool> ended{false};
  bool environment_closing = false, closing_handle = false;
  bool main_released = false, worker_released = false, dispatcher_closed = false;
  std::mutex dispatch_mutex;
  std::unique_ptr<CloseWork> close_work;
  std::unique_ptr<Listener> listener;
  Endpoint endpoint;
  uint32_t max_frames = 0;
  uint64_t max_bytes = 0;
  uint32_t readback_timeout = 0;
  std::string display_adapter;
  std::shared_ptr<Budget> budget;
  std::shared_ptr<DrainSignal> drain = std::make_shared<DrainSignal>();
  std::atomic<uint64_t> deliveries{1};
  std::mutex state_mutex;
  uint64_t next_connection = 1;
  /** The active or draining connection. */
  std::shared_ptr<Connection> current;
  /** An authenticated successor waiting for the current connection to drain. */
  std::unique_ptr<Candidate> waiting;
  /** Ended connections whose threads have not been joined, or whose frames are still held after close. */
  std::vector<std::shared_ptr<Connection>> retired;
  std::atomic<bool> stopped{false};
  /** A failed dispatch requests a stop without taking state_mutex. */
  std::atomic<bool> stopping{false};
  napi_threadsafe_function callback = nullptr;
  std::thread worker;
  bool closing = false;
  desktop_bridge::Bridge desktop_sink;
  std::shared_ptr<std::atomic<unsigned>> pending_rejection = std::make_shared<std::atomic<unsigned>>(0);
  // The three connection transitions and the GPU worker's drain-blocked warning each occur at most once per
  // connection. The listener fails once; invalidated settlements stop the channel and are bounded by held frames.
  // These notices share the FIFO, not the producer quota. Successive short connections can accumulate notices
  // during a JS stall: the 256-item bound is per connection, not per receiver.
  bool emit(Event* raw, Connection* producer = nullptr) {
    std::unique_ptr<Event> event(raw);
    {
      std::unique_lock<std::mutex> lock(dispatch_mutex);
      if (dispatcher_closed || worker_released) return false;
      if (producer && !event->reserve(producer->pending_events, 256)) {
        lock.unlock();  // Stopping interrupts I/O; it must not hold the dispatcher lock.
        producer->fail_connection("Frame-forwarding producer exceeded the pending event limit (256)");
        return false;
      }
      if (event->type == "rejected" && !event->reserve(pending_rejection, 1)) return true;
      const auto result = napi_call_threadsafe_function(callback, event.get(), napi_tsfn_nonblocking);
      if (result == napi_ok) { event.release(); return true; }
      // napi_closing relinquishes the native thread's TSFN reference.
      if (result != napi_closing) napi_release_threadsafe_function(callback, napi_tsfn_release);
      worker_released = true; dispatcher_closed = true;
    }
    // Callers may hold state_mutex; the listener performs the stop this requests.
    stopping = true; drain->notify(); return false;
  }
  void close_dispatcher() {
    std::lock_guard<std::mutex> lock(dispatch_mutex);
    dispatcher_closed = true;
    if (!worker_released) { worker_released = true; napi_release_threadsafe_function(callback, napi_tsfn_release); }
    if (!main_released) { main_released = true; napi_release_threadsafe_function(callback, napi_tsfn_abort); }
  }
  /** Close the channel: the listener stops, a waiting successor is refused and the current connection ends. */
  void stop() {
    std::shared_ptr<Connection> active;
    std::unique_ptr<Candidate> successor;
    {
      std::lock_guard<std::mutex> lock(state_mutex);
      if (stopped.exchange(true)) return;
      active = current; successor = std::move(waiting);
      if (listener) listener->interrupt();
    }
    if (successor) refuse(*successor, reject_closed);
    if (active) active->stop();
    drain->notify();
  }
  void fail_channel(const std::string& text) {
    auto event = new Event; event->type = "failed"; event->text = text; emit(event); stop();
  }
  void refuse(Candidate& candidate, const std::string& reason) {
    Packet refusal; refusal.kind = goodbye; std::snprintf(refusal.text, sizeof(refusal.text), "%s", reason.c_str());
    candidate.channel->send(refusal);
    candidate.channel.reset();
    auto event = new Event; event->type = "rejected"; event->text = reason; emit(event);
  }
  /**
   * @returns The refusal reason, or empty for a producer holding the credential that supports transferable channels and
   *   names only handles of its own.
   */
  std::string authenticate(const Candidate& candidate) const {
    const auto& packet = candidate.hello.packet;
    if (packet.marker != magic || packet.kind != hello || !std::memchr(packet.text, 0, sizeof(packet.text))) return reject_credential;
    if (packet.version != DSH_FRAME_FORWARDING_PROTOCOL_VERSION)
      return std::string(reject_protocol) + ": producer version " + std::to_string(packet.version)
        + ", receiver version " + std::to_string(DSH_FRAME_FORWARDING_PROTOCOL_VERSION);
    if (!same_secret(packet.token, endpoint.token)) return reject_credential;
    if (!(packet.max_frames & hello_transferable)) return reject_capability;
    if (!(packet.max_frames & hello_producer_local_handles)) return reject_local_handles;
    return {};
  }
  /** Promote an authenticated candidate to the current connection; the caller holds state_mutex. */
  void start(std::unique_ptr<Candidate> candidate) {
    std::shared_ptr<Connection> connection;
    try {
      connection = std::make_shared<Connection>(*this, next_connection++, candidate->hello.pid, std::move(candidate->channel));
    } catch (const std::exception& exception) {
      auto event = new Event; event->type = "rejected"; event->text = exception.what(); emit(event); return;
    }
    const auto& hello_packet = candidate->hello.packet;
    connection->producer_adapter = hello_packet.text;
    connection->presentation_path = resolve_presentation_path(connection->producer_adapter, display_adapter, (hello_packet.max_frames & hello_keyed_mutex) != 0);
    connection->allocation_factor = allocation_bytes_factor(connection->presentation_path);
    connection->channel->bind_connection(connection->id);
    Packet response; response.kind = ready; response.max_frames = max_frames;
    response.max_bytes = source_byte_budget(connection->presentation_path, max_frames, max_bytes);
    response.stride = hello_packet.max_frames & hello_capabilities;
    // A candidate that vanished while waiting takes no connection.
    if (!connection->channel->send(response)) return;
    connection->ledger->connected = true;
    current = connection;
    auto event = new Event; event->type = "connected"; event->pid = connection->pid; event->connection = connection->id; emit(event);
    connection->thread = std::thread([raw = connection.get()] { raw->run(); });
  }
  void admit(std::unique_ptr<Candidate> candidate) {
    if (const auto reason = authenticate(*candidate); !reason.empty()) { refuse(*candidate, reason); return; }
    std::lock_guard<std::mutex> lock(state_mutex);
    if (stopped) refuse(*candidate, reject_closed);
    else if (!current) start(std::move(candidate));
    else if (!current->ledger->connected && !waiting) waiting = std::move(candidate);
    else refuse(*candidate, reject_busy);
  }
  /** A waiting successor that disconnected, or spoke before ready, gives up its place; the caller holds state_mutex. */
  void probe_waiting() {
    if (!waiting) return;
    Received early;
    const auto result = waiting->channel->receive(early, 0);
    if (result == 0) return;
    if (result == 1) { release_resource(early.resource); refuse(*waiting, reject_credential); }
    waiting.reset();
  }
  void join_retired() {
    std::vector<std::shared_ptr<Connection>> ended_connections;
    { std::lock_guard<std::mutex> lock(state_mutex); ended_connections = retired; }
    for (auto& connection : ended_connections) if (connection->thread.joinable()) connection->thread.join();
    std::lock_guard<std::mutex> lock(state_mutex);
    retired.erase(std::remove_if(retired.begin(), retired.end(), [](const std::shared_ptr<Connection>& connection) {
      return !connection->thread.joinable() && connection->ledger->empty();
    }), retired.end());
  }
  void listen_loop() {
    try {
      while (!stopped && !stopping) {
        join_retired();
        { std::lock_guard<std::mutex> lock(state_mutex); probe_waiting(); }
        auto candidate = std::make_unique<Candidate>();
        const auto result = listener->accept(*candidate, 100);
        if (result < 0) { if (!stopped && !stopping) fail_channel("Frame-forwarding channel listener failed"); break; }
        if (result == 1) admit(std::move(candidate));
      }
    } catch (const std::exception& exception) { fail_channel(exception.what()); }
    stop();
    std::shared_ptr<Connection> active;
    {
      std::lock_guard<std::mutex> lock(state_mutex);
      // Dropping the listener withdraws the endpoint, so the TX credential no longer connects.
      listener.reset();
      active = current;
    }
    if (active && active->thread.joinable()) active->thread.join();
    join_retired();
    {
      std::lock_guard<std::mutex> lock(dispatch_mutex);
      if (!worker_released) { worker_released = true; napi_release_threadsafe_function(callback, napi_tsfn_release); }
    }
    ended = true;
    // A closing environment finishes through its async cleanup hook instead.
    napi_call_threadsafe_function(done, nullptr, napi_tsfn_nonblocking);
  }
  /** Release one delivery of whichever connection owns it; credit returns only to that connection while it is connected. */
  bool release(uint64_t delivery) {
    std::vector<std::shared_ptr<Connection>> owners;
    {
      std::lock_guard<std::mutex> lock(state_mutex);
      if (current) owners.push_back(current);
      owners.insert(owners.end(), retired.begin(), retired.end());
    }
    for (auto& connection : owners) {
      uint64_t source_id = 0;
      if (!connection->ledger->release(delivery, true, &source_id)) continue;
      connection->notify_jobs();
      if (source_id) {
        Packet packet; packet.kind = dsh_frame_forwarding::release; packet.frame_id = source_id;
        if (connection->ledger->connected && !connection->enqueue(packet)) connection->stop();
      }
      return true;
    }
    return false;
  }
  /** Queue control JSON for one connection; false when that connection is not the current, connected one. */
  bool send(uint64_t connection_id, const Packet& packet) {
    std::lock_guard<std::mutex> lock(state_mutex);
    return current && current->id == connection_id && current->ledger->connected && current->enqueue(packet);
  }
};
Connection::Connection(Receiver& receiver, uint64_t connection, uint32_t producer, std::unique_ptr<Channel> link)
    : owner(receiver), id(connection), pid(producer), channel(std::move(link)), max_frames(receiver.max_frames),
      max_bytes(receiver.max_bytes), readback_timeout(receiver.readback_timeout), display_adapter(receiver.display_adapter) {
  ledger->budget = receiver.budget; ledger->drain = receiver.drain;
#if defined(_WIN32)
  jobs_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  retry_timer = reinterpret_cast<HANDLE>(create_gpu_retry_timer());
  if (!jobs_event || !retry_timer) {
    if (jobs_event) CloseHandle(jobs_event);
    if (retry_timer) CloseHandle(retry_timer);
    throw std::runtime_error("Cannot create frame-forwarding GPU worker wake event or retry timer");
  }
#endif
}
bool Connection::emit(Event* event) {
  event->connection = id;
  if (desktop_bridge::take_frame(owner, owner.desktop_sink, event)) return true;
  // Only frames destined for JS use a slot; a Desktop frame can instead produce a presentation error.
  const bool producer_event = event->type == "message" || event->type == "presentation-error" || event->type == "frame";
  return owner.emit(event, producer_event ? this : nullptr);
}
void Connection::report_blocked(const std::string& text) {
  auto event = new Event; event->type = "drain-blocked"; event->text = text; emit(event);
}
uint64_t Connection::next_delivery() { return owner.deliveries.fetch_add(1); }
void Connection::run() {
  try {
    writer = std::thread([this] { write_loop(); });
    copier = std::thread([this] { copy_loop(); });
    read_loop();
  } catch (const std::exception& exception) { fail_connection(exception.what()); }
  stop();
  { std::lock_guard<std::mutex> lock(jobs_mutex); input_done = true; }
  notify_jobs();
  if (copier.joinable()) copier.join();
  if (writer.joinable()) writer.join();
  clear_validation_device();
  ledger->connected = false;
  // Releasing the channel closes the producer's connection port or pipe instance.
  { std::lock_guard<std::mutex> lock(output->mutex); channel.reset(); }
  ledger->retire_idle();
  {
    auto event = new Event; event->type = "disconnected";
    { std::lock_guard<std::mutex> lock(failure_mutex); event->text = failure; }
    emit(event);
  }
  {
    std::unique_lock<std::mutex> lock(owner.drain->mutex);
    owner.drain->changed.wait(lock, [&] { return owner.stopped.load() || owner.stopping.load() || ledger->empty(); });
  }
  const bool drained = ledger->empty();
  if (drained) { auto event = new Event; event->type = "drained"; emit(event); }
  std::lock_guard<std::mutex> lock(owner.state_mutex);
  if (owner.current.get() == this) { owner.retired.push_back(owner.current); owner.current.reset(); }
  if (drained && !owner.stopped && owner.waiting) owner.start(std::move(owner.waiting));
}
void receiver_done_finalized(napi_env, void* data, void*) {
  auto holder = static_cast<std::shared_ptr<Receiver>*>(data);
  if ((*holder)->cleanup) napi_remove_async_cleanup_hook((*holder)->cleanup);
  delete holder;
}
void settle_close(Receiver* self) {
  if (!self->close_work) return;
  if (!self->environment_closing) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(self->env, &scope) == napi_ok) {
      napi_value result; napi_get_undefined(self->env, &result);
      napi_resolve_deferred(self->env, self->close_work->deferred, result);
      napi_close_handle_scope(self->env, scope);
    }
  }
  napi_delete_reference(self->env, self->close_work->keep);
  self->close_work.reset();
}
void receiver_finish_on_main(Receiver* self) {
  if (!self->ended || self->closing_handle) return;
  self->closing_handle = true;
  // The reader joins both I/O helpers and drains submitted GPU work before setting ended.
  if (self->worker.joinable()) self->worker.join();
  settle_close(self);
  {
    std::lock_guard<std::mutex> lock(self->dispatch_mutex);
    if (!self->main_released) { self->main_released = true; napi_release_threadsafe_function(self->callback, napi_tsfn_release); }
  }
  napi_release_threadsafe_function(self->done, napi_tsfn_release);
}
void receiver_abandon_setup(Receiver* self, std::shared_ptr<Receiver>* holder) {
  self->stop(); self->ended = true; self->environment_closing = true; self->closing_handle = true;
  if (self->callback) self->close_dispatcher();
  if (self->done) napi_release_threadsafe_function(self->done, napi_tsfn_abort);
  else delete holder;
}
napi_value string(napi_env env, const std::string& value) { napi_value result; napi_create_string_utf8(env, value.data(), value.size(), &result); return result; }
napi_value number(napi_env env, double value) { napi_value result; napi_create_double(env, value, &result); return result; }
void property(napi_env env, napi_value object, const char* name, napi_value value) { napi_set_named_property(env, object, name, value); }
/** End the connection of a frame that cannot be delivered; the frame's ledger entry is released with the event. */
void undeliverable(const Event& event, const char* text) {
  if (auto connection = event.source.lock()) connection->fail_connection(text);
}
void dispatch(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<Event> event(static_cast<Event*>(data));
  if (!env || !callback) return;
  // A frame of a stopped connection is released undelivered; one that outlived its deadline ends its connection.
  if (event->type == "frame" && !event->ledger->accepting_frames) return;
  if (event->type == "frame" && std::chrono::steady_clock::now() >= event->deadline) {
    undeliverable(*event, "Frame-forwarding frame expired in the JavaScript delivery queue"); return;
  }
  napi_value object; napi_create_object(env, &object);
  property(env, object, "type", string(env, event->type));
  if (event->connection) property(env, object, "connectionId", number(env, static_cast<double>(event->connection)));
  if (event->type == "frame") {
    property(env, object, "frameId", number(env, static_cast<double>(event->packet.frame_id)));
    property(env, object, "deliveryId", number(env, static_cast<double>(event->delivery)));
    property(env, object, "width", number(env, event->packet.width)); property(env, object, "height", number(env, event->packet.height));
    property(env, object, "stride", number(env, event->packet.stride)); property(env, object, "metadata", string(env, event->packet.text));
    property(env, object, "transport", string(env, "shared-texture"));
    napi_value source_keyed_mutex;
    napi_get_boolean(env, event->source_keyed_mutex, &source_keyed_mutex);
    property(env, object, "sourceKeyedMutex", source_keyed_mutex);
    napi_value buffer;
    if (napi_create_buffer_copy(env, sizeof(event->resource), &event->resource, nullptr, &buffer) != napi_ok) {
      bool pending = false;
      napi_is_exception_pending(env, &pending);
      if (pending) { napi_value exception; napi_get_and_clear_last_exception(env, &exception); }
      undeliverable(*event, "Cannot allocate frame-forwarding handle buffer"); return;
    }
    property(env, object, "handle", buffer);
    napi_value presentation;
    if (event->presentation_adapter.empty()) napi_get_null(env, &presentation);
    else presentation = string(env, event->presentation_adapter);
    property(env, object, "presentationAdapterId", presentation);
    property(env, object, "adapterId", string(env, event->adapter));
    std::lock_guard<std::mutex> lock(event->ledger->mutex);
    if (!event->ledger->accepting_frames) return;
    if (std::chrono::steady_clock::now() >= event->deadline) {
      undeliverable(*event, "Frame-forwarding frame expired during JavaScript delivery"); return;
    }
    event->ledger->frames.at(event->delivery).delivered = true;
    event->delivered = true;
  } else if (event->type == "connected") property(env, object, "pid", number(env, event->pid));
  else if (!event->text.empty() || event->type == "message") property(env, object, "text", string(env, event->text));
  napi_value global, result; napi_get_global(env, &global); napi_call_function(env, global, callback, 1, &object, &result);
}
napi_value fail(napi_env env, const char* text) { napi_throw_error(env, nullptr, text); return nullptr; }
Receiver* receiver(napi_env env, napi_value value) {
  void* result = nullptr;
  if (napi_get_value_external(env, value, &result) != napi_ok || !result) { napi_throw_type_error(env, nullptr, "Invalid native receiver"); return nullptr; }
  return static_cast<std::shared_ptr<Receiver>*>(result)->get();
}
bool uint_value(napi_env env, napi_value value, uint64_t& output) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) || number < 1 || number > 9007199254740991.0 || std::floor(number) != number) return false;
  output = static_cast<uint64_t>(number); return true;
}
std::string token() {
  unsigned char random[32];
#if defined(__APPLE__)
  arc4random_buf(random, sizeof(random));
#else
  if (BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) throw std::runtime_error("Cannot generate render authentication secret");
#endif
  const char* hex = "0123456789abcdef"; std::string result;
  for (auto byte : random) { result += hex[byte >> 4]; result += hex[byte & 15]; } return result;
}
napi_value create(napi_env env, napi_callback_info info) {
  napi_value args[6]; size_t count = 6; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint64_t max_frames, max_bytes, timeout; napi_valuetype callback_type; char adapter[32]{}; size_t adapter_size;
  if (count != 6 || !uint_value(env, args[0], max_frames) || max_frames > 1024 || !uint_value(env, args[1], max_bytes) ||
      !uint_value(env, args[5], timeout) || timeout > UINT32_MAX ||
      napi_get_value_string_utf8(env, args[4], adapter, sizeof(adapter), &adapter_size) != napi_ok || adapter_size >= sizeof(adapter) - 1 ||
      napi_typeof(env, args[2], &callback_type) != napi_ok || callback_type != napi_function) return fail(env, "Invalid native receiver options");
#if defined(_WIN32)
  if (!adapter_size) return fail(env, "Frame forwarding unavailable: Windows requires a display adapter");
#endif
  std::shared_ptr<Receiver> value;
  // Owned by the completion function once it exists; freed by its finalizer.
  std::shared_ptr<Receiver>* done_holder = nullptr;
  try {
    value = std::make_shared<Receiver>(); value->env = env;
    value->max_frames = static_cast<uint32_t>(max_frames); value->max_bytes = max_bytes;
    value->display_adapter = adapter; value->readback_timeout = static_cast<uint32_t>(timeout);
    void* budget_pointer = nullptr;
    if (napi_get_value_external(env, args[3], &budget_pointer) != napi_ok || !budget_pointer) return fail(env, "Invalid frame-forwarding budget");
    value->budget = *static_cast<std::shared_ptr<Budget>*>(budget_pointer);
    if (max_bytes > value->budget->limit) return fail(env, "Channel budget exceeds shared frame-forwarding budget");
    value->endpoint.pid = process_id(); value->endpoint.token = token();
#if defined(__APPLE__)
    value->endpoint.name = "ai.deepseek.render." + token();
#else
    value->endpoint.name = "\\\\.\\pipe\\dsh-render-" + token();
#endif
    value->listener = listen(value->endpoint, value->readback_timeout);
    // The TX credential: producers present its secret; it names the receiver process, never a producer.
    auto tx = std::string("1|") + std::to_string(value->endpoint.pid) + "|" + value->endpoint.token + "|" + value->endpoint.name;
    auto name = string(env, "DSH frame-forwarding receiver");
    if (napi_create_threadsafe_function(env, args[2], nullptr, name, 0, 2, nullptr, nullptr, nullptr, dispatch, &value->callback) != napi_ok)
      return fail(env, "Cannot create frame-forwarding event dispatcher");
    done_holder = new std::shared_ptr<Receiver>(value);
    auto done_name = string(env, "DSH frame-forwarding receiver completion");
    if (napi_create_threadsafe_function(env, nullptr, nullptr, done_name, 0, 1, done_holder, receiver_done_finalized, value.get(),
      [](napi_env, napi_value, void* context, void*) { receiver_finish_on_main(static_cast<Receiver*>(context)); }, &value->done) != napi_ok) {
      receiver_abandon_setup(value.get(), done_holder); return fail(env, "Cannot create native receiver completion handle");
    }
    if (napi_add_async_cleanup_hook(env, [](napi_async_cleanup_hook_handle, void* data) {
      auto self = static_cast<Receiver*>(data); self->environment_closing = true;
      self->stop(); self->close_dispatcher();
      // Node closes the completion function during teardown, so wait for the worker here instead of relying on its signal.
      if (self->worker.joinable()) self->worker.join();
      receiver_finish_on_main(self);
    }, value.get(), &value->cleanup) != napi_ok) {
      receiver_abandon_setup(value.get(), done_holder); return fail(env, "Cannot register native receiver cleanup");
    }
    napi_value external, result;
    auto raw = value.get();
    auto holder = std::make_unique<std::shared_ptr<Receiver>>(value);
    if (napi_create_external(env, holder.get(), [](napi_env, void* data, void*) {
      std::unique_ptr<std::shared_ptr<Receiver>> holder(static_cast<std::shared_ptr<Receiver>*>(data));
      (*holder)->stop(); (*holder)->close_dispatcher();
    }, nullptr, &external) != napi_ok) {
      receiver_abandon_setup(raw, done_holder); return fail(env, "Cannot create native receiver owner");
    }
    holder.release();
    napi_create_object(env, &result); property(env, result, "native", external); property(env, result, "tx", string(env, tx));
    raw->worker = std::thread([raw] { raw->listen_loop(); });
    return result;
  } catch (const std::exception& exception) {
    if (value && value->callback) receiver_abandon_setup(value.get(), done_holder);
    return fail(env, exception.what());
  }
}
napi_value send(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 3) return fail(env, "Expected receiver, connection ID and control JSON");
  auto value = receiver(env, args[0]); uint64_t connection; if (!value) return nullptr;
  if (!uint_value(env, args[1], connection)) return fail(env, "Invalid frame-forwarding connection ID");
  Packet packet; packet.kind = message; size_t length;
  if (napi_get_value_string_utf8(env, args[2], nullptr, 0, &length) != napi_ok || length >= sizeof(packet.text)) return fail(env, "Control message exceeds frame-forwarding limit");
  napi_get_value_string_utf8(env, args[2], packet.text, sizeof(packet.text), &length);
  if (!value->send(connection, packet)) return fail(env, "Frame-forwarding connection is not active");
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value release(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) return fail(env, "Expected receiver and delivery ID");
  auto value = receiver(env, args[0]); uint64_t id; if (!value) return nullptr;
  if (!uint_value(env, args[1], id)) return fail(env, "Invalid delivery ID");
  napi_value result; napi_get_boolean(env, value->release(id), &result); return result;
}
napi_value close(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) return fail(env, "Expected receiver");
  auto value = receiver(env, args[0]); if (!value) return nullptr;
  if (value->closing) return fail(env, "Native receiver close already requested");
  auto work = std::make_unique<CloseWork>(); napi_value promise;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_reference(env, args[0], 1, &work->keep) != napi_ok)
    return fail(env, "Cannot retain native receiver close operation");
  value->close_work = std::move(work); value->closing = true; value->stop();
  if (value->closing_handle) settle_close(value);
  else receiver_finish_on_main(value);
  return promise;
}
napi_value create_budget(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint64_t bytes;
  if (count != 1 || !uint_value(env, args[0], bytes)) return fail(env, "Invalid shared frame-forwarding byte budget");
  auto budget = new std::shared_ptr<Budget>(std::make_shared<Budget>(bytes));
  napi_value result;
  napi_create_external(env, budget, [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<Budget>*>(data); }, nullptr, &result);
  return result;
}
/** Inspect an Electron-owned handle without selecting another GPU. */
napi_value get_adapter(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void* data = nullptr; size_t size = 0;
  if (count != 1 || napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(uintptr_t))
    return fail(env, "Expected an eight-byte native texture handle");
  uintptr_t handle; std::memcpy(&handle, data, size);
  return string(env, resource_adapter(handle));
}
napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"createBudget", nullptr, create_budget, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getAdapter", nullptr, get_adapter, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"send", nullptr, send, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"attachSink", nullptr, desktop_bridge::attach_sink<Receiver, &Receiver::desktop_sink>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setDeliverable", nullptr, desktop_bridge::set_deliverable<Receiver, &Receiver::desktop_sink>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
