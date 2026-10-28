# Agent Note: Compress the Remote stream WebSocket with permessage-deflate

Status: implemented

English | [中文](2026-10-18-websocket-permessage-deflate.zh.md)

## Problem

The Web GUI carries every live Remote stream over one physical WebSocket, `/api/remote.mux`: model token deltas, session events, tool output, terminal output, and the `$events` fan-out. The mux itself is the implemented [Remote duplex stream](2026-09-19-remote-duplex-stream.md) design; this note adds one transport option to it. The Host's HTTP surface already exposes `compression: 'none' | 'gzip'`; before this option the WebSocket had no equivalent, so the link stayed uncompressed.

Over a tunnel, a reverse proxy, or an admitted public URL, the large JSON frames — session replay, long tool output, terminal scrollback — spend bandwidth the protocol can already reclaim. Browsers offer `permessage-deflate` in the upgrade handshake without asking, so the missing half was the server's.

## Decision

The Gateway Config adds `websocketCompression: 'none' | 'deflate'`, defaulting to `'deflate'`, and passes the resolved boolean into the mux. The mux constructs `WebSocketServer` with these transport options and decides compression per outbound frame:

| Option | Value | Why |
|---|---|---|
| Frame compression threshold | `1024` characters of the JSON text, decided in the mux send path | `ws` ignores its `threshold` option while context takeover is enabled ([upstream 41ae5631](https://github.com/websockets/ws/commit/41ae5631)), so the mux passes `compress` per frame; frames below 1,024 characters (most token-level `item` frames) stay uncompressed and out of the zlib pool |
| `perMessageDeflate.zlibDeflateOptions.level` | `1` | Interactive frames value latency over ratio; the HTTP gzip default in this repository is also `1` |
| Context takeover | `ws` default (enabled both ways) | Best ratio for repetitive JSON; no per-message dictionary rebuild |

The mux constructor takes one options object carrying `heartbeatIntervalMs`, `streamInboxBytes`, and `compression`, because the Gateway resolves the config vocabulary and `stream-server.ts` does not learn `'none' | 'deflate'`.

Nothing on the client changes: the browser API offers the extension already, the Node carrier uses `ws` with `perMessageDeflate: true` by default, and a client that offers nothing gets an uncompressed upgrade.

### Negotiation and degradation

| Peer | Result |
|---|---|
| Browser (`client/connection` opens a native `WebSocket`) | Negotiates the extension; both directions compressed |
| Node `ws` carrier (tests, authenticated Desktop callers) | Negotiates the extension; both directions compressed |
| Client that does not offer the extension | Upgrade succeeds without `Sec-WebSocket-Extensions`; frames identical to an uncompressed connection |
| New Host with an old Client, or the reverse | No protocol change; the extension is per connection and optional |
| `websocketCompression: 'none'` | No extension is negotiated; frames are uncompressed |

### Failure and capacity

| Condition | Behavior |
|---|---|
| Buffered uplink exceeds `streamInboxBytes` | Still fails the logical stream with `gateway/uplink-overflow`; the budget counts decompressed frame bytes, so its meaning does not change |
| Ping/Pong heartbeat | Ping cadence is unaffected: control frames are never compressed, and the activity rule's Pong and inbound-frame arms are unchanged |
| Downlink write liveness | A sub-threshold write stays synchronous, so it counts as peer activity only when the local send buffer was already full; a frame whose JSON text reaches 1,024 characters compresses asynchronously, so its completed write counts as buffered activity |
| zlib saturation | Compression runs on the libuv thread pool behind `ws`'s global limiter; the event loop is not blocked, but thread-pool capacity is shared with file I/O |

## Alternatives considered

**Compress frames with gzip.** Rejected because WebSocket has no gzip frame format; RFC 7692 defines `permessage-deflate` as the only registered per-message compression extension.

**Let the client choose.** Rejected because the browser `WebSocket` API exposes no extension parameters and no way to disable negotiation; the decision can only live on the server.

**Mirror the HTTP surface with `compressionLevel` and `compressionThresholdBytes`.** Deferred, not rejected: no measurement justifies exposing tuning knobs yet, and the repository forbids hiding a real tunable in a constant while also forbidding speculative configuration. Add the fields when a deployment needs a different trade-off.

**Enable compression unconditionally.** Rejected because the choice varies by deployment: a loopback deployment pays CPU for no bandwidth gain and must be able to turn it off, which is what the Config field is for.

**Compress only the downlink.** Rejected because the extension is negotiated per connection and applies to both directions; a one-way accept is not expressible, and the uplink frames are small anyway.

## Consequences

Compression reclaims the bandwidth of large JSON frames over a tunnel, a reverse proxy, or an admitted public URL. Frames below 1,024 characters stay out of the zlib pool, and context takeover keeps the dictionary across messages, so repetitive JSON compresses well without per-message rebuilds.

**Thread-pool contention.** zlib shares the libuv pool with file I/O. The 1,024-character threshold keeps small streaming frames out of it; a saturated pool delays compressed frames rather than blocking the loop.

**Per-connection memory.** Each negotiated connection holds a deflate and an inflate context for its lifetime. One socket per browser tab keeps this proportional to open tabs; an implementation that expects many idle tabs should measure before enabling by default.

**No benefit over loopback.** The common local deployment gains nothing but CPU, which is why the field exists; the default is chosen for remote and tunneled use.

**Unmeasured default.** The `'deflate'` default rests on the HTTP gzip precedent and on remote deployments, not on an on/off byte-and-latency comparison. Record that comparison when one is run and revisit the default if local overhead proves visible.

**Weakened write liveness.** A compressed downlink write completes when `ws` has deflated and written it, not when the TCP peer acknowledges data, so continuous compressed downlink traffic counts as buffered activity and delays missed-heartbeat termination. The heartbeat rule and its code are unchanged.

The Gateway unit tests pin default negotiation, no-extension behavior, a client that offers nothing, the per-frame threshold, and the compressed-write liveness consequence; the config default and the generated config catalog are updated in the same change.
