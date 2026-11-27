/**
 * libFuzzer harness for the frame-forwarding v2 wire parser.
 *
 * The harness includes the production `transport.cc` as a unity build so that the file-local `decode_packet` and
 * `encode_header` are reachable without changing production code. It parses every input twice, once as a Windows pipe
 * message (`padded=false`) and once as a macOS Mach message (`padded=true`), then checks the parser's contract:
 *
 * - a decoded packet must re-encode into a message that decodes to the same marker, version, kind, geometry, frame and
 *   allocation fields, token, and text, and whose text is NUL-terminated inside the capacity unless it fills it;
 * - both padding conventions must agree on every field when both accept the same bytes, because a producer's bytes
 *   reach one receiver over a pipe and another over Mach.
 *
 * A violated check aborts with the input in hex; libFuzzer records it as a crash artifact. Reusable packet buffers
 * mirror the receiver, which decodes into one `Received` for the life of a connection.
 */
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "transport.cc"

using namespace dsh_frame_forwarding;

namespace {

/** One decoded packet per padding convention, plus the re-decoded packet of the round-trip check. */
Packet unpadded_packet, padded_packet, roundtrip_packet;

[[noreturn]] void fail(const char* check, const char* detail, const uint8_t* data, size_t size) {
  constexpr size_t shown = 4096;
  std::fprintf(stderr, "\n[ff-fuzz] %s FAILED: %s\n[ff-fuzz] input_size=%zu input_hex=", check, detail, size);
  for (size_t index = 0; index < size && index < shown; ++index) std::fprintf(stderr, "%02x", data[index]);
  std::fprintf(stderr, "%s\n", size > shown ? "..." : "");
  std::fflush(stderr);
  std::abort();
}

bool same_fields(const Packet& left, const Packet& right) {
  return left.marker == right.marker && left.version == right.version && left.kind == right.kind &&
      left.width == right.width && left.height == right.height && left.stride == right.stride &&
      left.max_frames == right.max_frames && left.frame_id == right.frame_id &&
      left.allocation_id == right.allocation_id && left.max_bytes == right.max_bytes && left.resource == right.resource;
}

/** Compare two packet texts the way both peers read them: as a NUL-terminated string, or whole when unterminated. */
bool same_text(const Packet& left, const Packet& right) {
  const auto* left_end = static_cast<const char*>(std::memchr(left.text, 0, sizeof(left.text)));
  const auto* right_end = static_cast<const char*>(std::memchr(right.text, 0, sizeof(right.text)));
  if (!left_end || !right_end) {
    return !left_end && !right_end && std::memcmp(left.text, right.text, sizeof(left.text)) == 0;
  }
  const size_t left_size = static_cast<size_t>(left_end - left.text), right_size = static_cast<size_t>(right_end - right.text);
  return left_size == right_size && std::memcmp(left.text, right.text, left_size) == 0;
}

/**
 * Re-encode a decoded packet and decode it again.
 * @param padded Whether the peer's message padded the text to a multiple of 4 bytes, as Mach does.
 */
void check_roundtrip(const Packet& packet, bool padded, const uint8_t* data, size_t size) {
  WireHeader wire;
  const uint32_t text_size = encode_header(packet, wire);
  if (text_size > DSH_FRAME_FORWARDING_TEXT_CAPACITY || wire.text_size != text_size)
    fail("roundtrip", "encode_header reports an impossible text size", data, size);
  const size_t aligned = padded ? (static_cast<size_t>(text_size) + 3u) & ~size_t{3} : text_size;
  std::vector<char> rebuilt(sizeof(WireHeader) + aligned, 0);
  std::memcpy(rebuilt.data(), &wire, sizeof(wire));
  std::memcpy(rebuilt.data() + sizeof(WireHeader), packet.text, text_size);
  if (!decode_packet(rebuilt.data(), rebuilt.size(), padded, roundtrip_packet))
    fail("roundtrip", "a re-encoded packet is refused", data, size);
  if (!same_fields(packet, roundtrip_packet))
    fail("roundtrip", "packet fields differ after re-encoding", data, size);
  if (std::memcmp(packet.token, roundtrip_packet.token, sizeof(packet.token)) != 0)
    fail("roundtrip", "token differs after re-encoding", data, size);
  if (!same_text(packet, roundtrip_packet)) fail("roundtrip", "text differs after re-encoding", data, size);
  // The text a receiver reads must end inside the buffer, unless the sender filled it without a terminator, which the
  // receiver refuses; decode_packet leaves exactly that case unterminated.
  if (text_size < DSH_FRAME_FORWARDING_TEXT_CAPACITY && roundtrip_packet.text[text_size] != '\0')
    fail("roundtrip", "text is not terminated at its reported size", data, size);
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  if (size == 0) return 0;
  const auto* bytes = reinterpret_cast<const char*>(data);
  const bool unpadded = decode_packet(bytes, size, false, unpadded_packet);
  const bool padded = decode_packet(bytes, size, true, padded_packet);
  if (unpadded && padded && (!same_fields(unpadded_packet, padded_packet) ||
      std::memcmp(unpadded_packet.token, padded_packet.token, sizeof(unpadded_packet.token)) != 0 ||
      !same_text(unpadded_packet, padded_packet)))
    fail("padding", "pipe and Mach decodes of the same bytes differ", data, size);
  if (unpadded) check_roundtrip(unpadded_packet, false, data, size);
  if (padded) check_roundtrip(padded_packet, true, data, size);
  return 0;
}
