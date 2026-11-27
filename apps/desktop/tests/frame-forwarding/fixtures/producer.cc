#include "fixture-client.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  char error[256] = {};
  auto client = dsh_frame_forwarding_connect(argv[1], error, sizeof(error));
  if (!client) { std::fprintf(stderr, "%s\n", error); return 3; }
  uint64_t frame = 1;
  bool requested = true;
  // `render <metadata>` submits its metadata and reports `{"submitted":<frame>}` once the frame is submitted.
  std::string metadata = "{\"tile\":\"test\"}";
  bool report = false;
  while (true) {
    if (requested) {
      auto surface = dsh_frame_forwarding_acquire(client, 64, 64);
      if (surface) {
        std::vector<uint32_t> pixels(64 * 64, 0xff3366cc);
        if (!dsh_frame_forwarding_write_bgra(surface, pixels.data(), 64 * 4) || !dsh_frame_forwarding_submit(client, surface, frame++, metadata.c_str())) return 4;
        requested = false;
        if (report) dsh_frame_forwarding_send(client, ("{\"submitted\":" + std::to_string(frame - 1) + "}").c_str());
      }
    }
    dsh_frame_forwarding_event event{};
    if (dsh_frame_forwarding_poll(client, 100, &event) < 0) break;
    if (event.kind == 1) {
      if (std::strcmp(event.text, "exit") == 0) break;
      if (std::strcmp(event.text, "render") == 0) requested = true;
      if (std::strncmp(event.text, "render ", 7) == 0) { requested = true; report = true; metadata = event.text + 7; }
      if (std::strcmp(event.text, "ack") == 0) dsh_frame_forwarding_send(client, "{\"applied\":1}");
      // A hidden view returns its idle surfaces to the shared budget.
      if (std::strcmp(event.text, "trim") == 0 && dsh_frame_forwarding_trim(client)) dsh_frame_forwarding_send(client, "{\"trimmed\":1}");
    }
  }
  dsh_frame_forwarding_close(client); return 0;
}
