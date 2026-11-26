/*
 * In-process C ABI through which a native module in the Desktop Host presents shared textures over a
 * `shared-texture-hop.node` connection. JavaScript receives a `dsh_shared_texture_sink_v2*` as the `sink` external that
 * `connect` returns and hands it to the consuming module, which declares these structures itself: field order and
 * types here are the ABI, and a consumer must check `magic` and `version` before use. A consumer built for another
 * version must refuse the sink: versions share no layout.
 *
 * Lifetime: the sink is reference-counted with an atomic intrusive count. The `sink` external owns one reference and
 * releases it when finalized; a consumer that keeps the pointer beyond that external calls `retain` first and
 * `release` when done. `retain`, `release`, and `present` may be called from any thread.
 *
 * Presentation: `present` returns DSH_SHARED_TEXTURE_PRESENT_OK when the request left the Host; exactly one
 * `on_delivered` then follows, and after it exactly one `on_settled`, both on the hop's reader thread. A callback must
 * not block, and may call `present`, `retain`, or `release`. Any other result means the request did not leave the Host:
 * no callback follows, the texture may be reused immediately, and `err_buf` (when `err_cap` > 0) holds a NUL-terminated
 * reason. Callbacks may run before `present` returns, so `user_data` must be ready before the call.
 *
 * DSH_SHARED_TEXTURE_PRESENT_REJECTED refuses only that frame and leaves the connection usable: missing arguments,
 * invalid frame fields, 128 unsettled requests, or a send that failed without ending the connection, such as a send
 * timeout. DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED means the connection was closed or lost; every later `present` on
 * this sink returns it, so the consumer stops using the sink and obtains a new one.
 *
 * Connection loss: when the connection can no longer carry a frame (Main gone, pipe broken, dead ingress port, or Main
 * dropping a connection whose replies it cannot deliver), found by the reader or by a send, every outstanding request
 * is settled as invalidated (after a failed `on_delivered` when it had none). A `present` whose message was sent
 * returns DSH_SHARED_TEXTURE_PRESENT_OK and is settled this way even when the connection ended while it was sending.
 */
#ifndef DSH_SHARED_TEXTURE_SINK_H
#define DSH_SHARED_TEXTURE_SINK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DSH_SHARED_TEXTURE_SINK_MAGIC 0x44535453u /* "DSTS" */
#define DSH_SHARED_TEXTURE_SINK_VERSION 2u

/* `present` results. */
#define DSH_SHARED_TEXTURE_PRESENT_OK 0           /* Request left the Host; on_delivered and on_settled follow. */
#define DSH_SHARED_TEXTURE_PRESENT_REJECTED 1     /* This frame was refused; no callback follows; connection remains usable. */
#define DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED 2 /* Connection is closed or broken; no callback follows; obtain a new sink. */

/** Per-request completion callbacks; `user_data` is passed back unchanged. */
typedef struct dsh_shared_texture_callbacks_v2 {
  void* user_data;
  /** `error` is NULL on success; otherwise a NUL-terminated reason valid only during the call. */
  void (*on_delivered)(void* user_data, const char* error);
  /** `invalidated` is 0 when Main released the texture and 1 when the presentation was invalidated. */
  void (*on_settled)(void* user_data, int invalidated);
} dsh_shared_texture_callbacks_v2;

/** One presentation; every pointer is read only during the `present` call. */
typedef struct dsh_shared_texture_frame_v2 {
  uintptr_t handle;          /* macOS: IOSurfaceRef; Windows: shareable NT HANDLE owned by caller */
  uint32_t width;            /* 1..8192 */
  uint32_t height;           /* 1..8192 */
  uint32_t timeout_ms;       /* 1..30000: Host-local deadline for on_delivered */
  uint8_t pixel_format;      /* 0 = bgra, 1 = rgba */
  const char* metadata_json; /* UTF-8 JSON, 0..4096 bytes; may be NULL when metadata_len is 0 */
  size_t metadata_len;
} dsh_shared_texture_frame_v2;

typedef struct dsh_shared_texture_sink_v2 {
  uint32_t magic;    /* DSH_SHARED_TEXTURE_SINK_MAGIC */
  uint32_t version;  /* DSH_SHARED_TEXTURE_SINK_VERSION */
  void* ctx;
  void (*retain)(void* ctx);
  void (*release)(void* ctx);
  int (*present)(void* ctx, const dsh_shared_texture_frame_v2* frame, const dsh_shared_texture_callbacks_v2* cb,
                 char* err_buf, size_t err_cap);
} dsh_shared_texture_sink_v2;

#ifdef __cplusplus
}
#endif

#endif /* DSH_SHARED_TEXTURE_SINK_H */
