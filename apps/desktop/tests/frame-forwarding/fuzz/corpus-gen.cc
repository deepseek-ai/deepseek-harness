/**
 * Write the seed corpus of the frame-forwarding wire parser with the production encoder.
 *
 * Usage: `corpus-gen <output directory> [canonical|extras]`
 *
 * `canonical` writes one legal packet of each kind, unpadded as a Windows pipe message. `extras` writes the seeds that
 * are too large or too specific for the checked-in corpus: a protocol-1 hello that only the version check reads, a
 * header-only hello, a message whose text fills the capacity without a terminator, and the Mach-padded form of seeds
 * whose text is not already a multiple of 4 bytes.
 */
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <direct.h>
#else
#include <sys/stat.h>
#endif

#include "transport.cc"

using namespace dsh_frame_forwarding;

namespace {

void make_directory(const std::string& path) {
#if defined(_WIN32)
  _mkdir(path.c_str());
#else
  mkdir(path.c_str(), 0755);
#endif
}

/** Write `packet` as a wire message; Mach pads the text to a multiple of 4 bytes with zeros. */
bool write_packet(const std::string& directory, const std::string& name, const Packet& packet, bool padded) {
  WireHeader wire;
  const uint32_t text_size = encode_header(packet, wire);
  const size_t aligned = padded ? (static_cast<size_t>(text_size) + 3u) & ~size_t{3} : text_size;
  std::vector<char> bytes(sizeof(WireHeader) + aligned, 0);
  std::memcpy(bytes.data(), &wire, sizeof(wire));
  std::memcpy(bytes.data() + sizeof(WireHeader), packet.text, text_size);
  const std::string path = directory + "/" + name;
  auto* file = std::fopen(path.c_str(), "wb");
  if (!file) { std::fprintf(stderr, "corpus-gen: cannot write %s\n", path.c_str()); return false; }
  const bool written = std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  std::fclose(file);
  if (!written) std::fprintf(stderr, "corpus-gen: short write to %s\n", path.c_str());
  return written;
}

void append(const std::string& directory, const std::string& name, const Packet& packet, bool padded) {
  if (!write_packet(directory, name, packet, padded)) std::exit(1);
}

Packet make_hello() {
  Packet packet;
  packet.kind = hello;
  packet.max_frames = hello_capabilities;
  std::memset(packet.token, 'k', sizeof(packet.token) - 1);
  std::snprintf(packet.text, sizeof(packet.text), "d3d11:0:1234");
  return packet;
}

void write_canonical(const std::string& directory) {
  append(directory, "hello.bin", make_hello(), false);

  Packet ready;
  ready.kind = dsh_frame_forwarding::ready;
  ready.max_frames = 3;
  ready.max_bytes = 64ull << 20;
  ready.stride = hello_capabilities;
  append(directory, "ready.bin", ready, false);

  Packet frame;
  frame.kind = dsh_frame_forwarding::frame;
  frame.frame_id = 1;
  frame.width = 800; frame.height = 600; frame.stride = 3200;
  frame.max_frames = frame_replaceable;
  frame.resource = 0x1234;
  append(directory, "frame.bin", frame, false);

  Packet release;
  release.kind = dsh_frame_forwarding::release;
  release.frame_id = 1;
  append(directory, "release.bin", release, false);

  Packet message;
  message.kind = dsh_frame_forwarding::message;
  std::snprintf(message.text, sizeof(message.text), "{\"n\":1}");
  append(directory, "message.bin", message, false);

  Packet goodbye;
  goodbye.kind = dsh_frame_forwarding::goodbye;
  std::snprintf(goodbye.text, sizeof(goodbye.text), "%s", reject_busy);
  append(directory, "goodbye.bin", goodbye, false);

  Packet allocate;
  allocate.kind = dsh_frame_forwarding::allocate;
  allocate.allocation_id = 1;
  allocate.max_bytes = 64ull << 20;
  allocate.width = 800; allocate.height = 600;
  append(directory, "allocate.bin", allocate, false);

  Packet allocated;
  allocated.kind = dsh_frame_forwarding::allocated;
  allocated.allocation_id = 1;
  append(directory, "allocated.bin", allocated, false);

  Packet deallocate;
  deallocate.kind = dsh_frame_forwarding::deallocate;
  deallocate.allocation_id = 1;
  append(directory, "deallocate.bin", deallocate, false);
}

/** Write a raw seed, such as the credential text the endpoint parser reads. */
void write_bytes(const std::string& directory, const std::string& name, const std::string& bytes) {
  const std::string path = directory + "/" + name;
  auto* file = std::fopen(path.c_str(), "wb");
  if (!file) { std::fprintf(stderr, "corpus-gen: cannot write %s\n", path.c_str()); std::exit(1); }
  const bool written = std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  std::fclose(file);
  if (!written) { std::fprintf(stderr, "corpus-gen: short write to %s\n", path.c_str()); std::exit(1); }
}

/** Write `size` bytes of a header prefix, which is all decode_packet reads of a foreign-version hello. */
void write_prefix(const std::string& directory, const std::string& name, uint32_t version) {
  const uint32_t prefix[3] = {magic, version, hello};
  const std::string path = directory + "/" + name;
  auto* file = std::fopen(path.c_str(), "wb");
  if (!file) { std::fprintf(stderr, "corpus-gen: cannot write %s\n", path.c_str()); std::exit(1); }
  const bool written = std::fwrite(prefix, 1, sizeof(prefix), file) == sizeof(prefix);
  std::fclose(file);
  if (!written) { std::fprintf(stderr, "corpus-gen: short write to %s\n", path.c_str()); std::exit(1); }
}

void write_extras(const std::string& directory) {
  // A protocol-1 hello: decode reads only marker, version, and kind so the receiver can refuse it by version.
  write_prefix(directory, "legacy-hello-v1.bin", 1);
  // A current-version hello that stops before the header: the version check does not apply, so it is refused.
  write_prefix(directory, "hello-truncated.bin", DSH_FRAME_FORWARDING_PROTOCOL_VERSION);

  // A message whose text has no terminator: the sender sends it whole and the receiver refuses it.
  Packet capacity;
  capacity.kind = message;
  std::memset(capacity.text, 'a', sizeof(capacity.text));
  append(directory, "message-capacity.bin", capacity, false);

  // Mach pads a text that is not a multiple of 4 bytes; seed both conventions.
  Packet odd_message;
  odd_message.kind = message;
  std::snprintf(odd_message.text, sizeof(odd_message.text), "{\"n\":12}");
  append(directory, "message.padded.bin", odd_message, true);
  Packet odd_goodbye;
  odd_goodbye.kind = goodbye;
  std::snprintf(odd_goodbye.text, sizeof(odd_goodbye.text), "channel-busy!");
  append(directory, "goodbye.padded.bin", odd_goodbye, true);
  append(directory, "hello.padded.bin", make_hello(), true);

  // Credentials the endpoint parser accepts, one it must refuse, and connection identifiers the handshake parses.
  const std::string secret(64, 'k');
  write_bytes(directory, "credential-valid.bin", "1|4321|" + secret + "|frame-forwarding");
  write_bytes(directory, "credential-short-token.bin", "1|4321|" + secret.substr(1) + "|frame-forwarding");
  write_bytes(directory, "connection-token.bin", "42");
  write_bytes(directory, "connection-token-limit.bin", "9007199254740991");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2 || argc > 3) {
    std::fprintf(stderr, "usage: corpus-gen <output directory> [canonical|extras]\n");
    return 2;
  }
  const std::string directory = argv[1];
  const std::string mode = argc == 3 ? argv[2] : "canonical";
  make_directory(directory);
  if (mode == "canonical") write_canonical(directory);
  else if (mode == "extras") write_extras(directory);
  else { std::fprintf(stderr, "corpus-gen: unknown mode %s\n", mode.c_str()); return 2; }
  return 0;
}
