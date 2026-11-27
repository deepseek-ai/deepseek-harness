# Agent Note: Frame-forwarding channels with transferable credentials, producer-local handles, covered views, and a memory-sized budget

Status: implemented

English | [中文](2026-10-18-frame-forwarding-channels.zh.md)

## Problem

A frame-forwarding view authorized one producer process. The Host plugin started the producer, passed it a private endpoint, and called `bind(viewId, pid)`; the receiver accepted only that PID, could not be rebound, and failed the view when the producer disconnected. Replacing a producer therefore meant a new receiver, a new view identifier, and a new renderer consumer: the Office preview's CPU restart rebuilt the whole path, a crashed engine took its view with it, and the parent had to know the child's PID before the child connected. A PID is also a poor authorization identity: the operating system reuses it, it names a process rather than a holder of authority, and a successor process of the same feature cannot inherit it.

Once any process holding a channel's credential may connect a producer, what such a producer can do to the Host matters. On Windows a producer duplicated each frame's NT handle into the receiver's process and sent the resulting value, and the receiver treated whatever value arrived as a handle of its own. A packet with a forged value therefore made the Host open that handle as a texture or, on an error path, close it, whichever Host object it named. The same scheme also required the producer to hold `PROCESS_DUP_HANDLE` on the Host, which an engine running in a sandbox below the Host's integrity level cannot obtain.

All channels of the window share one byte budget, granted first come, first served. A producer whose view was hidden stopped rendering but kept its idle pooled surfaces and its pending requests, so a visible view could wait behind a hidden one for budget nobody was using. While one view occupied the screen in a slideshow, the views it covered kept rendering frames nobody could see, and nothing told frame forwarding which channel covered the others.

The budget was also a fixed 256 MiB, at most 1 GiB, whatever the machine. A channel streaming 4K frames holds up to three 3840×2160 surfaces of 31.64 MiB each, so two such channels filled it, and on the Windows relay path, which also reserves three target textures and two staging textures per channel, a 4096-pixel-wide slideshow frame exceeded the share one allocation may take.

## Decision

### Channels and credentials

A receiver is a logical channel with two halves. The Host plugin calls `frameForwarding.channel()` and receives `{ tx, rx }`: `tx` is an opaque, serializable credential that any process holding a copy may present, and `rx` is the receive identity the renderer passes to `frameForwarding.connect(rx)`. `close(rx)` closes the channel permanently and withdraws the credential, and a channel also closes when the Cordis scope that read the service is disposed. `bind`, `bindProducer`, and the receiver's permanent expected PID no longer exist; the OS-reported peer process is checked per physical connection only for packet origin and handle duplication. The credential never reaches a renderer, a log, or a diagnostic.

### Connections and handoff

A channel serves one connection at a time and moves Idle → Active(N) → Draining(N) → Idle → Active(N+1); Closed and Failed are reachable from every state. Connection IDs increase and are never reused; ready carries N, and every later packet is checked against it. While N is connected, other candidates are refused as `channel-busy`, and N is never preempted, even when it stops responding. After N disconnects by goodbye, error, or process exit, N keeps its frames, allocations, budget, relay state, and submitted GPU work until each is released. During that drain one authenticated successor waits for ready within its own deadline and cancellation, and others are refused. Frames and allocations are keyed by connection, delivery IDs stay unique within the channel, credit returns only to the frame's own connection, and a late release of N returns nothing to N+1. GPU work whose completion is unknown keeps its resources and reports `drain-blocked`; no timeout ends a drain. On macOS each connection has its own Mach ports, delivered in ready; on Windows each connection uses its own pipe instance; a failed handshake closes only its candidate. A producer's `close()` completes once its own sender is closed, and the successor's ready completes the handoff.

### Producers name only their own handles

The hello capability `producer-local-handles` declares that every handle a producer names belongs to it. On Windows a frame carries a handle value in the producer's process. When a pipe client connects, the receiver opens that process with `PROCESS_DUP_HANDLE | SYNCHRONIZE` from `GetNamedPipeClientProcessId`, and it duplicates each frame's value from there. A value that names no handle of a live producer ends that connection as "sent a handle it does not own" without touching any Host handle; a producer that already exited took its handles with it, and its connection ends as lost. A hello that carries a handle is dropped, and the producer side never interprets a received value. macOS keeps Mach port transfer, where the kernel names the right in the receiver.

### Compatibility

Channels change no wire protocol version, constant, packet layout, or endpoint prefix; they add hello capability bits that both sides check. The current wire protocol, version 2, sends each packet as a fixed header followed by only the bytes of its text and requires the same capabilities. The hello declares `transferable-tx` and `producer-local-handles`. Ready carries the connection ID in its token field and, in `ready.stride`, unused before, echoes the capabilities the receiver accepted. A receiver refuses a producer without `transferable-tx` as `transferable-tx-required`, one without `producer-local-handles` as `producer-local-handles-required`, and a producer of another version as `protocol-mismatch`, naming both versions. A producer refuses a ready without a connection ID or without the `producer-local-handles` echo, so neither side of a mixed build sends or reads a handle value under the other rule. Build records (the Kit's `sdk.json`, `receipt.json`, and prebuild manifests, and DSH's `frame-forwarding.json`) list `capabilities: ["transferable-tx", "producer-local-handles"]`, and their loaders and verifiers reject artifacts without both, so a matching version number alone never passes a compatibility check. Desktop [preinstalls the receiver](2026-10-15-desktop-shared-texture-api.md). The Kit 0.2.3 engine is a protocol 1 producer, which the protocol 2 receiver refuses as `protocol-mismatch`.

### Host and renderer

The Host keeps the renderer's latest viewport per channel, sends it to each new connection, and presents frames only from the current connection, up to the latest viewport's version. The gate opens before the viewport is sent, because the receiver judges a frame in native code, possibly before the Host's JavaScript handles the acknowledgement that preceded it. A viewport request belongs to the connection that received it and reports `producer-changed` when that connection ends; a timeout fails the request and keeps the channel. Each event-stream subscription starts with a snapshot of every channel's state, then carries states with increasing sequence numbers and producer errors. Frame metadata carries `connectionId` beside `generation`, which remains the viewport version. A `FrameRx` streams the latest frame across producer switches. Frames whose connection state has yet to arrive wait within the channel's frame limit, and the renderer releases frames from earlier connections. Native producers can still use `dsh_frame_forwarding_submit` for ordered delivery or `dsh_frame_forwarding_submit_latest` for replaceable frames. `ready()` resolves once a producer acknowledged the latest viewport.

On `invalidated`, which [Desktop's settlement](2026-10-15-desktop-shared-texture-api.md) reports when the document, renderer, or GPU process went away first, the bridge queues the notice, then stops the receiver and the frame's connection before releasing the delivery, so its producer never writes that texture again; the forwarder closes the channel as `lost` when it handles the notice. A producer disconnect, by contrast, drains and hands over.

### Hidden and covered views return their surfaces

A consumer sends its next viewport version with `visible: false` whenever its view is hidden or covered. The producer SDK's `dsh_frame_forwarding_trim` deallocates every surface that is neither acquired nor submitted: available surfaces, the queued latest frame, granted allocations not yet created, and pending requests; on Windows it then flushes the producer's D3D11 context, because D3D11 destroys a released texture only at the next flush. The Kit engine trims after acknowledging an invisible viewport, so its allocations return to the shared budget, and its next visible frame requests them again.

### The window budget follows physical memory

`maxBytes: auto`, the default, resolves to half of physical memory and at least 256 MiB when the first channel opens; no budget exceeds physical memory, and a larger byte count is reduced to it with a Host warning. Sizing waits for the first channel because a Host that never loads the receiver, such as the browser worker deployment, cannot read physical memory. The budget is a ceiling, not a reservation: each channel still holds at most `maxFrames` surfaces, so a larger budget lets more channels hold surfaces at once without enlarging any of them. A producer whose allocation does not fit waits until other channels return surfaces; its channel stays open, and its consumer keeps what it shows and draws a placeholder where content has not arrived.

### Fullscreen belongs to frame forwarding

A receive channel shows its consumer's element fullscreen through the document's Fullscreen API with `FrameRx.requestFullscreen(element)`, which the consumer calls before its click handler awaits anything. One channel holds fullscreen at a time. Every other channel learns `{ active: true, holder: false }` and treats its view as covered; the holder learns `active: false` when the fullscreen ends, including on Escape; closing the holding channel or disposing the Client leaves its fullscreen. Desktop exposes no window control of its own ([shared-texture API](2026-10-15-desktop-shared-texture-api.md)).

Each document view runs its Host operations in arrival order, and different views run concurrently, so a view that waits for frame surfaces delays only its own later operations. A frame that misses `frameTimeoutMs`, or the Kit engine's own report that no frame surface became free, does not fail the view: tiles and page previews request their frame again once the late request settles, a slideshow keeps its stream, and the view keeps its retained tiles, page previews, or last slideshow frame, draws a checkerboard where nothing has arrived, and says that it waits for graphics memory until a frame draws.

## Alternatives considered

**Rebind the receiver to a successor's PID.** This keeps the PID as authority, still requires the parent to learn the child's PID before it connects, and needs a new bind call for crash takeover.

**Preempt a connected producer after a timeout.** A stalled producer may still own GPU work on the channel's textures, so preemption would hand those textures to a successor while they are in use. Only the operating system's disconnect or the producer's own close starts a drain.

**Connect the successor at once and keep the old connection's frames separately.** Two producers would share one channel's budget and frame limit, and the renderer would interleave their frames. Draining first keeps one producer's resources and credit in flight at a time.

**Open a new channel per producer, as before.** Every producer switch would replace the renderer's consumer and lose its viewport and stream subscription.

**Mark channels with a new wire protocol version.** Channels change no packet layout; capability bits that both sides check refuse mixed builds as well, and the frame-forwarding README promises that within a version the wire changes only by such capabilities.

**Return invalidated textures through a drain.** Desktop cannot observe their remaining references, so a successor could write a texture a stale document still reads; a closed channel is the only state in which releasing them is safe.

**Validate the received value before use.** The receiver could check that a value names a shared D3D11 texture. That checks the object's type, not its owner: a forged value naming another channel's texture or any other shared object of the Host passes, and error paths still release the value.

**Keep producer-side duplication and verify it in the receiver.** The receiver cannot tell a value the producer duplicated in from a value it guessed without the producer's handle table, and the producer would still need `PROCESS_DUP_HANDLE` on the Host, which a sandboxed engine lacks.

**A new wire message that pauses covered producers.** Viewport visibility already tells a producer to stop rendering, carries a version the Host orders, and reaches each new connection through the viewport replay, so a separate pause message would duplicate it.

**Per-channel byte caps or a channel count limit.** Trimming covered views and closing channels with the scope that opened them handle the observed contention; on the Windows relay path the budget formula would make a low cap block a 4K slideshow. Deferred until a measurement shows the need.

**Fullscreen the document element and keep the slideshow overlay on `document.body`.** The application chrome would then share the fullscreen screen, including the Windows menu and caption controls that need their own fullscreen handling, and frame forwarding could not name the covering view.

**Keyboard Lock.** Letting a holder keep Escape suits games, not slideshows, and is deferred until a consumer needs it.

**Keep a fixed default budget.** 256 MiB held two 4K streams on the shared-texture paths and refused a 4096-pixel-wide frame on the relay path, however much memory the machine had.

**A quarter of physical memory**, the ceiling Chromium sets for a renderer's tile memory. Half lets more views render at once, which suits using whatever the machine has, and still stays below the working set Metal recommends, about two thirds to four fifths of unified memory.

**95% or 100% of physical memory.** The operating systems' graphics limits are lower: WDDM lets graphics use `min(80%, max(RAM − 16 GB, 50%))` of system memory, and Metal's recommended working set is the fraction above. The same memory also holds the engines, Chromium, and other applications. Frame forwarding would never refuse first: exhaustion would surface wherever the operating system fails an allocation, for example in Chromium's GPU process, whose exit closes every channel, and nothing would bound the frame memory producers make the Host and the GPU process hold.

**Fail a view whose frame misses its deadline.** A missing allocation is usually temporary: hiding, covering, or closing another view frees it, while a failed view waits for the user to retry.

**Run every Office operation in one Host queue.** A view waiting for frame surfaces would hold every other document's operations for the engine's whole wait, and opening one document would stall the others.

**Tell a budget wait from a stalled engine.** The receiver does not report a pending grant to the Host, and distinguishing that state would require a new producer-to-Host diagnostic; an engine that stops answering still ends at `operationTimeoutMs`.

**Size the budget from the operating system's GPU budget** (DXGI `QueryVideoMemoryInfo`, Metal `recommendedMaxWorkingSetSize`). It would follow dedicated video memory, which physical memory does not show, but requires platform-specific native queries in the receiver.

## Verification

The Kit's transport tests and DSH's [receiver native e2e](../../../../packages/experimental/frame-forwarding/tests/receiver-native.e2e.ts) connect a separate producer process with a copied credential and cover busy refusal, a waiting successor, deadline expiry, crash takeover, IDs reused across connections with late releases, mixed-build refusals in both directions including a producer built without `producer-local-handles` and a ready without the echo, budget return after repeated handoffs, and a trimmed producer's allocation passing to another channel sharing its budget. On Windows the Kit's tests close the connection of a producer that sends a receiver handle's value while that sentinel handle stays valid, and show the trimmed textures' video memory freed through the shared-texture and relay paths; the serialized native suite passes on macOS arm64, two Windows x64 hardware hosts, and Windows ARM64. The [Kit frames e2e](../../../../packages/experimental/frame-forwarding/tests/kit-frames-native.e2e.ts) hands a real Office engine's channel to a replacement and, after a crash, to a successor, renders two engines on two channels at once, and trims an invisible engine's surfaces. Unit specs cover the Host's viewport replay and connection-bound requests, the renderer's snapshot and sequence handling and early-frame ordering, the [wire adapter](../../../../packages/experimental/frame-forwarding/tests/wire.client.spec.ts) and [receive channel](../../../../packages/experimental/frame-forwarding/tests/rx.client.spec.ts) with the single fullscreen holder, coverage events, exits during a pending entry or after Escape, and exits on close and disposal. The [service specs](../../../../packages/experimental/frame-forwarding/tests/service.host.spec.ts) cover `auto` at half of physical memory, its 256 MiB floor, and the refused load of a budget above physical memory.

## Consequences

Producer replacement and crash takeover keep the channel, the renderer's consumer, and the viewport, and need no PID: a parent hands over a string. In exchange, every protocol 1 receiver, producer, engine, and build record must be upgraded together, and older builds are refused explicitly: Kit 0.2.2 and earlier producers and receivers cannot interoperate with these sources in either direction, so the Kit, its engines, and Desktop, which compiles the receiver when it packages, upgrade together. A stalled producer that stays connected blocks its channel until it exits or the channel closes, and a successor waits for Desktop and its consumers to release the previous producer's frames. A GPU-process exit closes the channels that had frames on screen, and its consumer must open a new channel instead of continuing on the old one. A producer must keep a sent handle open until the receiver reads the frame, and a producer that exits right after submitting loses that frame with its connection. An engine sandboxed below the Host's integrity level keeps working, since only the Host opens the other process; conversely a producer elevated above the Host, which the Host cannot open, cannot connect, and the receiver closes it during the handshake without a Host diagnostic. A view that becomes visible again waits for an allocation grant before its first frame, and trimming returns frame surfaces only, not an engine's own renderer caches. Escape always leaves fullscreen, and coverage is per document: a fullscreen element of the document covers every receive channel except the holder's. On Windows machines with 32 GB or less, half of physical memory equals the system memory WDDM lets graphics use, so the operating system's limit can be reached there before the budget; a discrete GPU keeps frames in its dedicated memory, which the budget does not see, and WDDM pages rather than fails when that memory runs out.
