/**
 * DSTX v3: the little-endian messages the Desktop Host's `shared-texture-hop.node` and Electron Main's
 * `shared-texture-ingress.node` exchange. On macOS each message travels in one Mach message (the present request also
 * carries the IOSurface port and, on a connection's first request, the Host's reply port); on Windows each message is
 * one named-pipe message. Both structures are packed so their byte layout is the wire layout; read and write them with
 * `memcpy`. Each side refuses a message of any other version.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace dstx {

constexpr uint32_t kDstxMagic = 0x44535458;  // "DSTX"
constexpr uint32_t kDstxVersion = 3;
constexpr size_t kMaxMetadataBytes = 4096;
constexpr size_t kMaxErrorBytes = 256;
constexpr uint32_t kMaxDimension = 8192;
/** Request identifiers stay exact JavaScript numbers. */
constexpr uint64_t kMaxRequestId = (uint64_t{1} << 53) - 1;

enum DstxPixelFormat : uint8_t { DSTX_PIXEL_BGRA = 0, DSTX_PIXEL_RGBA = 1 };

/** Main -> Host reply kinds. */
enum DstxReplyKind : uint32_t {
  DSTX_DELIVERED_OK = 1,         // The renderer imported the texture; exactly one SETTLED_* follows.
  DSTX_DELIVERED_ERROR = 2,      // Delivery failed; with kDstxNoReferenceKept, Main kept no reference and sends nothing more.
  DSTX_SETTLED_RELEASED = 3,
  DSTX_SETTLED_INVALIDATED = 4,
};

/** DstxReplyHeader::flags bit valid only with DSTX_DELIVERED_ERROR. */
constexpr uint16_t kDstxNoReferenceKept = 1;

#pragma pack(push, 1)
/**
 * Host -> Main. Followed by `metadata[metadata_length]` (UTF-8 JSON). The Host's delivery deadline stays local to the
 * Host; Main answers every request whatever its age.
 */
struct DstxPresentHeader {
  uint32_t magic;
  uint32_t version;
  uint64_t request_id;       // 1..kMaxRequestId, unique within the Host process.
  uint64_t win32_nt_handle;  // Windows: the HANDLE value inside the Host process; macOS: 0.
  uint32_t width;            // 1..kMaxDimension
  uint32_t height;           // 1..kMaxDimension
  uint8_t pixel_format;      // DstxPixelFormat
  uint8_t reserved[3];       // 0
  uint16_t metadata_length;  // 0..kMaxMetadataBytes
  uint16_t reserved2;        // 0; keeps the header a multiple of 8 bytes
};

/** Main -> Host. Followed by `error[error_length]` (UTF-8). */
struct DstxReplyHeader {
  uint32_t magic;
  uint32_t version;
  uint32_t kind;          // DstxReplyKind
  uint16_t flags;         // kDstxNoReferenceKept
  uint16_t error_length;  // 0..kMaxErrorBytes
  uint64_t request_id;
};
#pragma pack(pop)

static_assert(sizeof(DstxPresentHeader) == 40, "DSTX present header layout");
static_assert(sizeof(DstxReplyHeader) == 24, "DSTX reply header layout");

constexpr size_t kMaxPresentBytes = sizeof(DstxPresentHeader) + kMaxMetadataBytes;
constexpr size_t kMaxReplyBytes = sizeof(DstxReplyHeader) + kMaxErrorBytes;

/**
 * Whether a present header is within protocol limits and declares exactly `payload_bytes` of trailing metadata.
 * `require_handle` selects the Windows rule (nonzero `win32_nt_handle`) instead of the macOS rule (zero).
 */
inline bool valid_present(const DstxPresentHeader& header, size_t payload_bytes, bool require_handle) {
  return header.magic == kDstxMagic && header.version == kDstxVersion
    && header.request_id >= 1 && header.request_id <= kMaxRequestId
    && (require_handle ? header.win32_nt_handle != 0 : header.win32_nt_handle == 0)
    && header.width >= 1 && header.width <= kMaxDimension && header.height >= 1 && header.height <= kMaxDimension
    && (header.pixel_format == DSTX_PIXEL_BGRA || header.pixel_format == DSTX_PIXEL_RGBA)
    && header.reserved[0] == 0 && header.reserved[1] == 0 && header.reserved[2] == 0 && header.reserved2 == 0
    && header.metadata_length <= kMaxMetadataBytes && payload_bytes == header.metadata_length;
}

/** Whether a reply header is within protocol limits and declares exactly `payload_bytes` of trailing error text. */
inline bool valid_reply(const DstxReplyHeader& header, size_t payload_bytes) {
  return header.magic == kDstxMagic && header.version == kDstxVersion
    && header.kind >= DSTX_DELIVERED_OK && header.kind <= DSTX_SETTLED_INVALIDATED
    && (header.flags & ~kDstxNoReferenceKept) == 0 && (header.flags == 0 || header.kind == DSTX_DELIVERED_ERROR)
    && header.request_id >= 1 && header.request_id <= kMaxRequestId
    && header.error_length <= kMaxErrorBytes && payload_bytes == header.error_length;
}

/** Longest prefix of `text` within `limit` bytes that does not split a UTF-8 sequence. */
inline size_t utf8_prefix(const char* text, size_t length, size_t limit) {
  if (length <= limit) return length;
  size_t end = limit;
  while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) --end;
  return end;
}

}  // namespace dstx
