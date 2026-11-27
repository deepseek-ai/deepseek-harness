/**
 * libFuzzer harness for the frame-forwarding trust establishment text paths.
 *
 * It mutates the three parsers that run before any pixel or handle crosses a process boundary:
 *
 * - `parse_endpoint` over a TX credential, which must either throw for an unusable credential or return an endpoint
 *   that survives being re-encoded into the `1|<pid>|<token>|<name>` form and parsed again;
 * - `parse_connection` over a 65-byte received token, which must either refuse it or return a safe integer that its own
 *   decimal form parses back to;
 * - the receiver's stamping of `Channel::send` together with the producer's `parse_connection`, which must agree on
 *   every connection identifier the receiver can assign.
 *
 * Rejecting malformed input by throwing is the documented behaviour of `parse_endpoint`; the harness catches it. A
 * violated check aborts with the input in hex, and libFuzzer records it as a crash artifact.
 */
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

#include "transport.cc"

using namespace dsh_frame_forwarding;

namespace {

/** Largest connection identifier the protocol accepts, matching the largest exactly representable JavaScript integer. */
constexpr uint64_t largest_connection = 9007199254740991ULL;

[[noreturn]] void fail(const char* check, const char* detail, const uint8_t* data, size_t size) {
  constexpr size_t shown = 4096;
  std::fprintf(stderr, "\n[ff-fuzz] %s FAILED: %s\n[ff-fuzz] input_size=%zu input_hex=", check, detail, size);
  for (size_t index = 0; index < size && index < shown; ++index) std::fprintf(stderr, "%02x", data[index]);
  std::fprintf(stderr, "%s\n", size > shown ? "..." : "");
  std::fflush(stderr);
  std::abort();
}

/** Stands in for a producer or receiver channel and keeps the token `Channel::send` stamped into the packet. */
class StampingChannel final : public Channel {
 public:
  char token[65] = {};
  int receive_packet(Received&, uint32_t) override { return 0; }
  bool send_packet(const Packet& packet, uintptr_t) override { std::memcpy(token, packet.token, sizeof(token)); return true; }
  void interrupt() override {}
  uint32_t peer_pid() const override { return 0; }
};

/** The packet a bound channel stamps; it carries no token of its own. */
Packet unstamped_packet;

void check_endpoint(const uint8_t* data, size_t size) {
  const std::string value(reinterpret_cast<const char*>(data), size);
  Endpoint endpoint;
  try {
    endpoint = parse_endpoint(value);
  } catch (const std::exception&) {
    // A credential the receiver cannot use is refused by throwing, before any channel exists.
    return;
  }
  // Whatever the parser accepted must be a usable endpoint, because the receiver publishes it and the producer parses
  // it back from the same text.
  if (endpoint.pid == 0 || endpoint.token.size() != 64 || endpoint.name.empty() || endpoint.name.size() > 200)
    fail("parse_endpoint", "accepted an endpoint the protocol cannot carry", data, size);
  // The pid field is decimal digits only on every platform: no sign, no whitespace, and no wrap through a 32-bit
  // `unsigned long`. Leading zeros are accepted.
  const auto first = value.find('|'), second = value.find('|', first + 1);
  const std::string pid_text = value.substr(first + 1, second - first - 1);
  if (pid_text.empty() || pid_text.find_first_not_of("0123456789") != std::string::npos
    || std::stoull(pid_text) != endpoint.pid)
    fail("parse_endpoint", "accepted a pid field that is not the decimal pid", data, size);
  const std::string encoded =
      "1|" + std::to_string(endpoint.pid) + "|" + endpoint.token + "|" + endpoint.name;
  try {
    const Endpoint again = parse_endpoint(encoded);
    if (again.pid != endpoint.pid || again.token != endpoint.token || again.name != endpoint.name)
      fail("parse_endpoint", "endpoint fields differ after re-encoding", data, size);
  } catch (const std::exception&) {
    fail("parse_endpoint", "an accepted endpoint no longer parses after re-encoding", data, size);
  }
}

void check_connection(const uint8_t* data, size_t size) {
  char token[65] = {};
  std::memcpy(token, data, size < sizeof(token) ? size : sizeof(token));
  const uint64_t connection = parse_connection(token);
  if (!connection) return;
  if (connection > largest_connection)
    fail("parse_connection", "accepted an identifier above the exact-integer limit", data, size);
  char encoded[65] = {};
  std::snprintf(encoded, sizeof(encoded), "%llu", static_cast<unsigned long long>(connection));
  if (parse_connection(encoded) != connection)
    fail("parse_connection", "an accepted identifier does not parse back from its decimal form", data, size);
}

void check_stamped_connection(const uint8_t* data, size_t size) {
  uint64_t connection = 0;
  std::memcpy(&connection, data, size < sizeof(connection) ? size : sizeof(connection));
  static StampingChannel channel;
  std::memset(channel.token, 0, sizeof(channel.token));
  channel.bind_connection(connection);
  if (!channel.send(unstamped_packet)) fail("Channel::send", "refused a packet on a bound connection", data, size);
  // A bound channel stamps the identifier into the token the producer parses back; an unbound one stamps nothing.
  const uint64_t parsed = parse_connection(channel.token);
  const uint64_t expected = connection >= 1 && connection <= largest_connection ? connection : 0;
  if (parsed != expected)
    fail("Channel::send", "the stamped connection identifier does not parse back", data, size);
}

}  // namespace

/**
 * Check fixed `parse_endpoint` cases once per run, so the sign, whitespace, and 32-bit range rules hold as a
 * deterministic regression on both platforms before any mutation starts.
 */
extern "C" int LLVMFuzzerInitialize(int*, char***) {
  const std::string token(64, 'k');
  const struct { const char* pid; uint32_t expected; } cases[] = {
    {"5", 5}, {"007", 7}, {"4294967295", 4294967295u},
    {"0", 0}, {"-5", 0}, {"+7", 0}, {" 5", 0}, {"5 ", 0}, {"", 0}, {"4294967296", 0}, {"-4294967295", 0},
    {"18446744073709551621", 0},
  };
  for (const auto& entry : cases) {
    const std::string credential = std::string("1|") + entry.pid + "|" + token + "|x";
    uint32_t pid = 0;
    try { pid = parse_endpoint(credential).pid; } catch (const std::exception&) { pid = 0; }
    if (pid != entry.expected) {
      std::fprintf(stderr, "\n[ff-fuzz] parse_endpoint FAILED: pid field \"%s\" gave %u, expected %u\n", entry.pid, pid, entry.expected);
      std::fflush(stderr);
      std::abort();
    }
  }
  return 0;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  if (size == 0) return 0;
  check_endpoint(data, size);
  check_connection(data, size);
  check_stamped_connection(data, size);
  return 0;
}
