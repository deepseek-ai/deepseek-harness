// Producer for the receiver's pending-event tests: floods control messages, submits frames, or presents a wrong
// credential repeatedly.
//
//   backlog-producer <tx> produce [key=value ...]
//     messages=N    control messages {"seq":i,"pad":"x..."} of about length=L bytes (defaults 0 and 64)
//     wait-go=1     poll until the receiver sends "go" before sending
//     frames=N      then submit N 64x64 frames, each once credit and an allocation are available; gives up after 5 s
//     frames-first=1  submit the frames right after connecting, before waiting for "go"
//     after=A       "hold" polls up to hold-ms=MS (default 10000) and reports whether the receiver ended the
//                   connection, answers "ping" and leaves on "exit"; "goodbye" closes at once; "crash" terminates
//     retry-busy=1  retry a connection refused as channel-busy every 10 ms for up to 20 s
//   backlog-producer <tx> refuse [count=N] [max-ms=MS]
//     Connect with the caller-corrupted credential until N attempts were refused for it (0: no limit) or MS elapsed.
//
// Every observation is one stdout line, `<ms since start> <word> <details>`. With signal=PREFIX, each word also
// creates the empty file PREFIX.<word>, so a test whose JavaScript thread is blocked can still observe progress.
#include "fixture-client.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#if defined(_WIN32)
#include <windows.h>
#include <d3d11.h>
#endif

static const auto started = std::chrono::steady_clock::now();
static std::map<std::string, std::string> options;
static long long elapsed() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
}
static long option(const char* key, long fallback) {
  const auto found = options.find(key);
  return found == options.end() ? fallback : std::atol(found->second.c_str());
}
static void say(const char* word, const std::string& details = {}) {
  std::printf("%lld %s %s\n", elapsed(), word, details.c_str());
  std::fflush(stdout);
  const auto signal = options.find("signal");
  if (signal != options.end()) std::ofstream(signal->second + "." + word, std::ios::binary);
}
[[noreturn]] static void crash() {
#if defined(_WIN32)
  TerminateProcess(GetCurrentProcess(), 9);
#endif
  std::abort();
}

static int refuse(const std::string& tx, dsh_frame_forwarding_connect_options& connect) {
  const long target = option("count", 1), max_ms = option("max-ms", 20000);
#if defined(_WIN32)
  // One device for every attempt, so each attempt costs only the pipe handshake.
  ID3D11Device* device = nullptr;
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
      D3D11_SDK_VERSION, &device, nullptr, nullptr))) { say("device-failed"); return 6; }
  connect.device = device;
#endif
  char error[512] = {};
  long credential = 0, other = 0, accepted = 0;
  std::string other_text;
  while ((target == 0 || credential < target) && elapsed() < max_ms) {
    auto client = dsh_frame_forwarding_connect_with_options(tx.c_str(), &connect, error, sizeof(error));
    if (client) { ++accepted; dsh_frame_forwarding_close(client); }
    else if (std::strstr(error, "credential was rejected")) { if (++credential == 1) say("refusing"); }
    else { ++other; other_text = error; }
  }
  say("refused", "credential=" + std::to_string(credential) + " other=" + std::to_string(other) + " accepted=" +
    std::to_string(accepted) + " other_text=" + other_text);
  return 0;
}

static int produce(const std::string& tx, dsh_frame_forwarding_connect_options& connect) {
  const long messages = option("messages", 0), length = option("length", 64), hold_ms = option("hold-ms", 10000);
  const long frames = option("frames", 0);
  const bool wait_go = option("wait-go", 0) != 0, retry_busy = option("retry-busy", 0) != 0;
  const bool frames_first = option("frames-first", 0) != 0;
  const std::string after = options.count("after") ? options["after"] : "goodbye";
  char error[512] = {};
  dsh_frame_forwarding_client* client = nullptr;
  long busy = 0;
  for (;;) {
    client = dsh_frame_forwarding_connect_with_options(tx.c_str(), &connect, error, sizeof(error));
    if (client || !retry_busy || std::strncmp(error, "channel-busy", 12) != 0 || elapsed() > 20000) break;
    ++busy;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (!client) { say("connect-failed", error); return 3; }
  say("connected", "busy=" + std::to_string(busy));
  auto event = std::make_unique<dsh_frame_forwarding_event>();
  const auto submit_frames = [&] {
    std::vector<uint32_t> pixels(64 * 64, 0xff3366cc);
    long submitted = 0;
    std::string failure;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (submitted < frames && failure.empty() && std::chrono::steady_clock::now() < deadline) {
      if (auto surface = dsh_frame_forwarding_acquire(client, 64, 64)) {
        if (!dsh_frame_forwarding_write_bgra(surface, pixels.data(), 64 * 4) ||
            !dsh_frame_forwarding_submit(client, surface, static_cast<uint64_t>(submitted + 1), "{}")) failure = "submit";
        else ++submitted;
        continue;
      }
      const int kind = dsh_frame_forwarding_poll(client, 20, event.get());
      if (kind < 0) failure = std::string("closed:") + event->text;
    }
    say("frames", "submitted=" + std::to_string(submitted) + " failure=" + failure);
  };
  if (frames > 0 && frames_first) submit_frames();
  if (wait_go) {
    bool go = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    while (!go && std::chrono::steady_clock::now() < deadline) {
      const int kind = dsh_frame_forwarding_poll(client, 100, event.get());
      if (kind < 0) { say("closed-before-go", event->text); dsh_frame_forwarding_close(client); return 4; }
      if (kind == 1 && std::strcmp(event->text, "go") == 0) go = true;
    }
    if (!go) { say("go-timeout"); dsh_frame_forwarding_close(client); return 5; }
    say("go");
  }
  long sent = 0, failed = 0;
  for (long index = 0; index < messages; ++index) {
    std::string json = "{\"seq\":" + std::to_string(index) + ",\"pad\":\"";
    const long pad = length - static_cast<long>(json.size()) - 2;
    if (pad > 0) json.append(static_cast<size_t>(pad), 'x');
    json += "\"}";
    if (dsh_frame_forwarding_send(client, json.c_str())) ++sent; else ++failed;
  }
  say("sent", "ok=" + std::to_string(sent) + " failed=" + std::to_string(failed));
  if (frames > 0 && !frames_first) submit_frames();
  if (after == "crash") { say("crashing"); crash(); }
  if (after == "goodbye") { dsh_frame_forwarding_close(client); say("goodbye"); return 0; }
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(hold_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    const int kind = dsh_frame_forwarding_poll(client, 100, event.get());
    if (kind < 0) { say("closed", event->text); dsh_frame_forwarding_close(client); return 0; }
    if (kind == 1 && std::strcmp(event->text, "exit") == 0) { say("exit-request"); dsh_frame_forwarding_close(client); say("goodbye"); return 0; }
    if (kind == 1 && std::strcmp(event->text, "ping") == 0) dsh_frame_forwarding_send(client, "{\"pong\":1}");
  }
  say("hold-timeout");
  dsh_frame_forwarding_close(client);
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 3) return 2;
  for (int index = 3; index < argc; ++index) {
    const std::string argument = argv[index];
    const auto equals = argument.find('=');
    if (equals == std::string::npos) return 2;
    options[argument.substr(0, equals)] = argument.substr(equals + 1);
  }
  const std::string tx = argv[1], mode = argv[2];
  dsh_frame_forwarding_connect_options connect{};
  connect.timeout_ms = 10000;
  if (mode == "refuse") return refuse(tx, connect);
  if (mode == "produce") return produce(tx, connect);
  return 2;
}
