# Agent Note: Remote duplex stream: one kind of stream, an uplink channel, and an invocation context

Status: implemented

English | [中文](2026-09-19-remote-duplex-stream.zh.md)

## Problem

### Current state

`dsh-api-gateway` multiplexes every Typert Remote stream over one WebSocket at the fixed path `/api/remote.mux` (`packages/api/gateway/src/stream-protocol.ts`). A Host method decorated with `@Remote({ mode: 'stream' })` that returns an `Iterable` or `AsyncIterable` becomes one Host-to-Client logical stream; the optional final `signal: AbortSignal` is the only reserved parameter, never enters the wire arguments, and is appended by the Gateway after the decoded business parameters (`packages/api/gateway/src/index.ts`). The generated method the Client receives returns a bare `AsyncIterable`.

There are only five wire frames:

| Direction | Frame | Definition |
| --- | --- | --- |
| Client to Host | `{ type: 'open', streamId, endpoint, payload }` | `stream-protocol.ts` |
| Client to Host | `{ type: 'cancel', streamId }` | `stream-protocol.ts` |
| Host to Client | `{ type: 'item', streamId, value? }` | `stream-protocol.ts` |
| Host to Client | `{ type: 'error', streamId, error: { code, message, details } }` | `stream-protocol.ts` |
| Host to Client | `{ type: 'end', streamId }` | `stream-protocol.ts` |

The Client can send only open and cancel. The parser `parseRemoteStreamClientMessage` (`stream-protocol.ts`) throws on any other frame, and a Host connection that receives one closes the whole socket with 1008 (`stream-server.ts`). In short, the Gateway today supports only "a backend iterable sent to the frontend". Every feature that needs the frontend to send data to the backend continuously takes its own detour.

A Host method also has no notion of who initiated this call: `InvokeRemoteRequest = { namespace, method, args, signal }` (`packages/api/gateway/src/types.ts`) has no caller slot, `RemoteStreamOpener` has the signature `(endpoint, payload, signal)` (`stream-server.ts`), and the WebSocket checks the cookie once, at the handshake.

### Three unrelated uplink mechanisms

| Feature | Uplink path | Location | Cost |
| --- | --- | --- | --- |
| Web terminal keystrokes | One unary RPC `terminal.write(agent, id, attachmentId, data)` per xterm `onData`; the Client serializes them through a promise chain and caps its own byte budget | `packages/api/terminal-controller/src/client/model.ts`; Host `src/index.ts` | One HTTP round trip and one authentication per keystroke; two carriers correlated by hand through `attachmentId`; `inputFull` when the budget is exhausted |
| File upload | A `Blob` or `ReadableStream` goes to the native `POST /api/session/uploadFileBinary` outside the Remote layer, with `duplex: 'half'` | `packages/client/file-upload/src/client/runtime.ts`; route `src/index.ts` | Bypasses Typert descriptors; no type projection |
| Answers to approvals and questions | The Host sends waterfall frames down the `$events` stream, the Client answers through a separate unary RPC `$events/result`, correlated by `clientId` plus `eventId` | `packages/api/gateway/src/client/remote-events.ts`; Host `index.ts` | A second correlation key; `index.ts` records the race this creates |

These three mechanisms solve the same problem: the Client wants to write into a logical stream that is already open.

### Concrete costs

- **Aligning two carriers.** The terminal uses `attachmentId` to correlate the `follow` stream with the `write` RPC and to decide who owns input. Approvals use `clientId` to correlate the `$events` stream with the `$events/result` RPC.
- **No ordering guarantee.** A unary RPC travels over HTTP and is unordered relative to the WebSocket downlink; the terminal can preserve order only by serializing writes on the Client.
- **Separate authentication and lookup per uplink.** Every `write(agent, id, attachmentId, data)` resolves `agent`, looks up the terminal, and validates the attachment.
- **No EOF.** The Client cannot express "I am done writing"; a half-close needs yet another RPC.
- **Cancellation does not cover both halves.** Cancelling the downlink stream does not cancel queued uplink writes, and vice versa.
- **Backpressure implemented three times.** The downlink pulls the iterator at the pace of the socket write callback (`stream-server.ts`); the terminal uses a bounded follower that makes a slow consumer fail explicitly (`terminal-controller/src/stream.ts`); the uplink relies on the Client capping `maxInputBytes` itself.
- **The documentation is already stale.** `docs/api-gateway.md:160` still says Remote handles one request and one result, a sentence that lags the stream mode the README records.

### Relation to background jobs

The process-shaped duplex stream face of background jobs (archived as a draft PR on branch `worktree/job-stdio-stream-pair-archive`) models a job as a pair of mirrored stream faces; for the browser to attach to it, one Remote stream must carry both a downlink and an uplink. It is one motivation for this Note but not in its scope: whether jobs need a dedicated read-write stream is an architecture question for the jobs line itself. This Note covers only the transport layer.

### Goals

1. The transport layer has one kind of stream, duplex by nature: downlink `item` / `end` / `error`, uplink `item` / `end`, one `streamId`, one generation.
2. The uplink type and the downlink type are written in the same place: the method's return type.
3. A Host method takes its uplink from the invocation context; the invocation context also carries the caller (the Peer).
4. The Client receives a handle that can read, write, and close, not a bare `AsyncIterable`.
5. Upper-layer protocols (snapshot, journal, any business-defined stream) stay out of the transport layer.

## Decision

### In one sentence

Every Remote stream accepts a Client uplink. The method's return type `RemoteStream<Out, In = never>` declares the downlink item type and the uplink item type together; the generator derives two codecs from it. A Host method takes the uplink iterator through `this.ctx.invocation.uplink<In>()` and learns the caller through `this.ctx.invocation.peer`. The generated Client method returns a `RemoteStreamHandle<Out, In>`: `for await` reads the downlink, `send` / `end` write the uplink, `dispose` closes. Reopening after disconnection, cursor resumption, and baseline validation all belong to upper-layer protocols.

```
                 Client                                             Host
   ─────────────────────────────────              ───────────────────────────────────────────
   const s = remote.job.attach(req, signal)
        │  open { streamId, endpoint, payload } ───────▶  opener(endpoint, payload, uplink, peer, control)
        │                                                     │ prepareInvocation
        │  s.send(v1) → item { streamId, v1 }    ───────▶  inbox.push(v1)   │ invocation = { request, service, peer, signal, uplink() }
        │  s.send(v2) → item { streamId, v2 }    ───────▶  inbox.push(v2)   │ receiverContext.extend({ invocation }).get(service)
        │  s.end()    → end  { streamId }        ───────▶  inbox.end()      │ method(...args, signal)
        │                                        ◀───────  item { streamId, o1 }   │   for await (v of this.ctx.invocation.uplink()) …
        │  for await (o of s) …                  ◀───────  item { streamId, o2 }   │   yield o …
        │  s.dispose() → cancel { streamId }     ───────▶  control.abort()         │ signal aborts; uplink.return()
        │                                        ◀───────  end | error
```

### Terms

| Term | Meaning |
| --- | --- |
| Logical stream | One call identified by one `streamId`, spanning `open` to the terminal frame |
| Generation | One physical lifetime of a logical stream. The transport layer knows exactly one generation; disconnection is failure, and reopening belongs to the upper layer |
| Downlink | The Host-to-Client `item` sequence, terminated by `end` or `error` |
| Uplink | The Client-to-Host `item` sequence, terminated by `end` (half-close) or ended together with `cancel` |
| Half-close | One direction has ended while the other remains open |
| Item | One business value in one direction; every item is validated by the codec independently |
| inbox | The bounded uplink queue the Host keeps per logical stream |
| Peer | The party the connection layer admitted, one `PeerScope`; this Host has exactly one Peer, the operator |
| Invocation context | `RemoteInvocation`: the request, receiving service, Peer, cancellation signal, and uplink entry of this call |

### Type signatures

```text
// @deepseek-ai/dsh-typert-protocol
/**
 * One Remote stream. Host face: the method returns it, and at runtime it is AsyncIterable<Out>.
 * On the Client face the generated method returns RemoteStreamHandle<Out, In>; each name has exactly one meaning.
 * In is the item type the Client may send uplink; the default never means the method reads no uplink.
 */
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }

// Host
@Remote({ mode: 'stream' })
async *attach(request: JobAttachRequest, signal: AbortSignal): RemoteStream<JobFollowFrame, JobInputFrame> {
  const uplink = this.ctx.invocation.uplink<JobInputFrame>()
  void (async () => { for await (const frame of uplink) … })()
  yield …
}

// Generated Client signature: same parameters, returns the handle
attach(request: JobAttachRequest, signal?: AbortSignal): RemoteStreamHandle<JobFollowFrame, JobInputFrame>

// Client usage
const stream = remote.job.attach(req, signal)
for await (const frame of stream) …
stream.send(frame)     // typed as JobInputFrame
stream.end()
stream.dispose()
```

`RemoteStream` is an alias rather than an interface, deliberately: if the transport layer later takes a Node stream form, only the alias definition and the adapters at both ends change; method signatures, descriptors, and upper-layer protocols stay untouched.

### Host face

```text
/** The context of this Remote call. A method reads it through this.ctx.invocation. */
export interface RemoteInvocation {
  readonly request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }
  /** Cordis service key of the receiving service. */
  readonly service: string
  /** The Peer that initiated the call. In-process carriers and unadmitted calls are the operator. */
  readonly peer: PeerScope
  /** Carrier cancellation: Client cancel, socket closure, uplink failure. */
  readonly signal: AbortSignal
  /**
   * The uplink items of this call. Can be taken once; the second call throws. With an uplink codec
   * in the descriptor each item is decoded to In; without one, items are delivered as unknown with
   * only a JSON-safety check.
   * The iteration ends after the Client's end; when the method ends the downlink, the Gateway calls
   * its return() and drops unconsumed items.
   * The generic In is only the caller's type assertion; runtime decodes per the descriptor and does not cross-check.
   */
  uplink<In = unknown>(): AsyncIterable<In>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Remote call this Context was derived for; undefined on a Context not derived from a Remote call. */
    readonly invocation: RemoteInvocation | undefined
  }
}
```

Rules:

1. Any `mode: 'stream'` method may call `this.ctx.invocation.uplink()`; a unary method may too, but its stream ends when the method returns, so uplink items are readable only while the method runs.
2. While `uplink()` has not been called, uplink items accumulate in the inbox until the limit is exceeded (see Backpressure) or the stream ends and they are dropped. This is deliberate: a method that does not read the uplink need not know the uplink exists.
3. When `In` defaults to `never`, the descriptor has no uplink codec; the Client handle's `send` has type `never`, so nothing can be sent at compile time. If frames still arrive at runtime (from a hand-built client), they are delivered as `unknown`.
4. `this.ctx.invocation` is `undefined` on a Context not derived from a Remote call; a method that reads it handles the optional as TypeScript requires, or asserts it on the method's first line. The accessor for that property is registered once when the `TypertRemoteService` base class is constructed, so any composition that installs a Remote service can read it.

#### How the invocation context reaches the method

The mechanism relies on two existing Cordis behaviors:

- `ctx.extend(meta)` is `Object.create(parent)` plus own properties (`vendor/cordis/src/context.ts:99-107`): no registration, no fiber, nothing to release, so deriving one per call costs nothing.
- `ctx.get(service)` returns the `createTraceable(ctx, service)` proxy (`vendor/cordis/src/reflect.ts:233-234`, `utils.ts:117-125`). Reading the `ctx` property returns the accessing Context directly (`utils.ts:175`); reading a method wraps it in `createShadowMethod`, whose `apply` replaces `this` with a shadow receiver whose `ctx` is `ctx.extend({ [symbols.shadow]: origin })` (`utils.ts:149-163`).
- The Gateway therefore writes `receiverContext.extend({ invocation }).get(descriptor.service)` to obtain a per-call view and calls `Reflect.apply(method, callReceiver, args)`; inside the method body, `this.ctx.invocation` reads this call through the prototype chain. The deferred execution of an async generator body is unaffected, because `this` was bound to the shadow object at call time.

### PeerScope

```text
/** The opaque identity of one Peer. */
export type PeerId = Branded<'PeerId'>

/** One Peer's session on this Host: opened and released by the admitting side; ctx owns connection-lifetime registrations. */
export interface PeerScope {
  readonly id: PeerId
  readonly ctx: Context
  dispose(): Promise<void>
}
```

This Host has exactly one Peer: the operator. `@deepseek-ai/dsh-client-connection` creates it with `createScope(connectionCtx, peer)` when the service applies, the same mechanism an Agent uses to create its own scope: the Peer object is the ScopeKey, `peer.ctx` carries connection-lifetime effects, and `dispose()` runs with the Connection's release and quiets the fiber. It is exposed as `connection.operator`.

| Member | Semantics |
| --- | --- |
| `connection.operator: PeerScope` | The only Peer; lives and dies with the Connection |
| `connection.admit(request): PeerAdmission` | Runs the existing `requestRejection`: returns `{ rejection: 401 \| 403 }` when refused, otherwise `{ peer: operator }`. Future admitters plug in here |

The Gateway's `handleUpgrade(req, socket, head, peer)` binds an opener with a fixed Peer to that socket and registers socket closure in `peer.ctx.effect`; when the scope is already inactive, it closes the socket directly with 1001 instead. When `InvokeRemoteRequest.peer?` or the `peer` parameter of `RemoteStreamOpener` is absent, the answer is the operator, so existing in-process callers change nothing; in a composition without a Connection, the operator stand-in the Gateway builds for itself is likewise created through `createScope`, with the same `dispose()` contract. Looking up a Peer by id, associating a carrier with a second Peer, and Peer open and close events all wait until the first consumer that needs multiple Peers appears.

The Peer carries no access model: who the Peer is and what it may do are attached by business plugins on their own through `peer.ctx`.

### Client face

```text
/** The handle a generated method returns on the Client face. A different name from the Host's RemoteStream, exported from the same entry point. */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /** Send one uplink item. Throws on a value that is not lossless JSON, after termination, or after end. */
  send(item: In): void
  /** Half-close the uplink: sends the end frame. Idempotent. */
  end(): void
  /** Cancel the whole logical stream: sends the cancel frame (when no terminal frame has arrived); the downlink iterator ends quietly. */
  dispose(): void
}
```

- The handle represents one generation. When the carrier is lost, `for await` fails with `RemoteStreamCarrierError` and the handle ends there; whether to reopen, and with which arguments, belongs to the upper-layer protocol.
- `send` is synchronous: it runs the `isRemoteJsonValue` check before enqueuing and throws synchronously on a value that is not lossless JSON. The browser's `WebSocket.send` has no write callback, so throttling sends would be meaningless; the Host-side inbox limit is the only backpressure point.
- When a terminal frame (`end` / `error`) arrives, the mux client stops the pump and closes the uplink queue immediately on the receive path, so later `send` / `end` throw without waiting for the consumer's next read.
- `dispose()` calls `return()` on the carrier iterator, so the `cancel` frame is sent even when nobody is reading the downlink; afterwards the handle's `next()` ends immediately and buffered items are dropped. A consumer that `break`s out of `for await` early is equivalent to `dispose()`.
- The `$stream` supervisor, `RemoteSnapshotStream`, and `RemoteJournalStream` are upper-layer tools outside the transport layer. The object their `open` factories receive is the handle itself, with unchanged `for await` behavior; exposing `send` to these upper-layer protocols is deferred.

### Wire frames

```text
export type RemoteStreamClientMessage =
  | { readonly type: 'open'; readonly streamId: string; readonly endpoint: string; readonly payload: unknown }
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }   // new: uplink item
  | { readonly type: 'end'; readonly streamId: string }                              // new: uplink half-close
  | { readonly type: 'cancel'; readonly streamId: string }

/** Frames sent by the Host are unchanged. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  | { readonly type: 'end'; readonly streamId: string }
```

Parsing rules: `item` has exactly the keys `type` and `streamId` plus an optional `value`, and `value` must be a lossless JSON value (`isRemoteJsonValue`); `end` has exactly the keys `type` and `streamId`. Any other frame is a frame-format violation, and the socket closes with 1008. No binary frames are introduced.

### Logical stream state machine

#### Host side

```
                open frame
   (none) ───────────────────▶ opening ──── opener resolves ────▶ running
                                  │                                  │
                                  │ item frame: inbox.push           │ item frame: inbox.push
                                  │ end frame: inbox.end             │ end frame: inbox.end (uplink half-close)
                                  │                                  │ method yield: sends item frame
                                  │ cancel frame / socket close ────▶│ cancel frame / socket close: control.abort
                                  ▼                                  ▼
                               aborted ◀───────────────────────── finished (sends end or error frame)
```

`item` frames that arrive during `opening` enter the inbox: `receive()` is synchronous and creates the `ActiveStream` and its inbox while handling the `open` frame, whereas the opener is asynchronous. Items the Client sends immediately after `open` are not lost.

#### Client side

```
   call generated method ──▶ await socket ──▶ send open ──▶ handle usable
                                                            │ send(v): sends item; end(): sends end
                                                            │ downlink: inbox.next() → yield; end → ends; error → throws
                                                            │ downlink terminates first: send/end throw
                                                            │ dispose or caller signal abort: sends cancel (when no terminal frame has arrived)
```

### Half-close and termination

| Uplink | Downlink | Result |
| --- | --- | --- |
| Client `end` | Still open | The Host's `uplink()` iteration ends; the method keeps producing. This is the stdin EOF form |
| Still open | The Host method finishes and sends `end` | The Client handle terminates, and later `send` / `end` throw; the Host calls `return()` on the `uplink` iterator and drops unconsumed items |
| Still open | The Host method throws and sends `error` | Same as above; the Client downlink fails with `RemoteError` |
| Client `dispose` or signal abort | Any | Sends `cancel`; the Host runs `control.abort()`, `cancellableStream` closes `uplink` first and then calls `return()` on the method iterator; no terminal frame is sent |
| Socket closes | Any | The Host aborts every stream and awaits `done`; on the Client every stream fails with `RemoteStreamCarrierError` |
| `item` received after `end` | Any | The stream fails with a `gateway/protocol` error frame and aborts; the socket stays open |
| `item` / `end` with an unknown `streamId` | Any | Ignored, like `cancel`: after the Host ends a stream and deletes its id, uplink frames still in flight from the Client are normal and must not take down the other streams on the same socket |

### Cancellation wait lifetime

`cancellableStream`, `UplinkDecoder.next()`, and the Client uplink pump each create a cancellation or stop promise per read. `Promise.race` does not remove the losing input's reaction when a read completes: reusing a stream-wide pending promise retains completed races and their item results until that promise settles or becomes unreachable. Read-local promises keep retained cancellation state independent of the number of delivered items.

The Host downlink clears its current reject callback after each read and checks cancellation before reading again. The uplink decoder retains only pending reads: abort rejects them, while normal close resolves all of them with `done`, including overlapping reads. The Client pump drops its stop promise after each read and does not start another read after stopping. Source iterators retain their existing release ownership; closing the Host uplink still precedes returning the method iterator.

### Ordering guarantees

Frames on one socket arrive in total order: a logical stream's `open`, `item`…, `end` reach the Host in send order, and uplink items enter `uplink()` in the order of `send`. There is no cross-direction ordering guarantee between uplink and downlink; a protocol that needs request-response pairing carries its own sequence numbers.

### Backpressure

WebSocket has no per-stream window like HTTP/2: one connection is one serial write chain, and a slow stream holds up the other streams on the same connection. This property of the downlink is unchanged. For the uplink:

**A bounded inbox plus whole-stream failure.** The Host meters each logical stream's inbox in UTF-8 bytes of its frames, with the limit set by the Gateway config `streamInboxBytes` (default 262144) and applied to every stream. On overflow the whole logical stream fails with `gateway/uplink-overflow`: the downlink breaks with it, an `error` frame goes to the Client, and the `uplink()` iterator ends with the same error. No data is discarded; a method that does not read its uplink while the Client keeps sending is a usage error, and the failure exposes it explicitly.

Credit frames wait until a consumer that needs sustained high-volume uplink appears; the inbox limit is the initial credit, and adding them is incremental.

### Security and validation

| Item | Rule |
| --- | --- |
| Authentication | Same as today: `connection.requestRejection(req)` at upgrade; descriptor and lookup-parameter validation at open. Uplink items belong to an already authenticated stream and are not authenticated again |
| Peer | Admitted at upgrade as one `PeerScope`; `invocation.peer` of every stream on that socket is that Peer |
| Item validation | With an uplink codec, every item is decoded strictly, and a failure fails the whole stream with the existing `gateway/input-invalid` (details `{ endpoint, field: 'uplink' }`); without a codec, only JSON-safety validation applies |
| Frame size | A single frame keeps the `maxPayload` of `ws`; the inbox limit bounds the accumulated total |

### In-process and worker carriers

| Carrier | Change |
| --- | --- |
| `ClientConnectionRpc.open` (`packages/client/connection/src/rpc.ts:245-250`) and `RpcStreamOpen` (`client/rpc.ts:21-25`) | Append an optional `uplink?: AsyncIterable<unknown>`; in process there are no frames and no inbox, the caller's iterator is the source of `uplink()` directly, and backpressure is the pace of the iterator itself |
| Worker tunnel (`packages/experimental/webworker-runtime`) | The page adds `stream-uplink-item` / `stream-uplink-end` frames; `serveStream` assembles them into an `uplink` handed to `seams.openStream`. Same-origin trusted boundary: no inbox limit, and items after `end` are dropped |
| `remote-mock` (`packages/test-support/remote-mock`) | `StreamHandle.uplink: AsyncIterable<unknown>`; `rpc.open` passes it through |

An in-process carrier with no `peer` means the operator.

### Relation to `$events`

`$events` is a stream on a reserved endpoint; with uplink frames, waterfall answers can become uplink items on the same `streamId`, `clientId` becomes redundant because `streamId` already identifies the generation, and `$events/result` disappears together with the race at `index.ts:527-529`. Out of scope for this Note; see Deferred.

## Type and wire definitions

### typert protocol (`packages/typert/protocol/src`)

```text
// types.ts
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }
export type PeerId = Branded<'PeerId'>
export interface PeerScope { readonly id: PeerId; readonly ctx: Context; dispose(): Promise<void> }
export interface RemoteInvocation { … }              // see Host face
declare module '@deepseek-ai/cordis' { interface Context { readonly invocation: RemoteInvocation | undefined } }

export interface InvocationDescriptor {
  // existing fields unchanged; mode still has only 'stream'
  readonly mode?: 'stream'
  /** Uplink item codec, generated from In of the return type RemoteStream<Out, In>; absent when In is never. */
  readonly uplink?: { readonly codec: TypertCodec }
  readonly cancellation?: { readonly parameter: 'signal' }
  readonly result: TypertCodec
}
```

The `Remote` decorator, `RemoteMethodOptions`, and `RemoteMethodMarker` recognize only `mode: 'stream'`.

### typert generator (`packages/typert/generator/src`)

- `model.ts`: `InvocationModel.uplink?: { boundary: RemoteBoundaryModel }`.
- `analyzer.ts` `remoteResultType`: for `mode: 'stream'`, the accepted return-type wrappers are `Iterable<Out>`, `AsyncIterable<Out>`, and `RemoteStream<Out, In?>`. `RemoteStream` is recognized the same way as the standard library's `AsyncIterable`: by symbol name plus declaring file (`types.ts` of `@deepseek-ai/dsh-typert-protocol`). The first type argument is the downlink item; when the second is present and is not `never`, an `uplink` boundary is generated under the key `${endpoint}:uplink`.
- `emitter.ts`: the descriptor literal emits `uplink: { codec }`; the generated Client signature returns `RemoteStreamHandle<Out, In>`.
- The parameter loop recognizes no parameter named `uplink`.

### Two names, one entry point

A Host method declares a stream with `RemoteStream<Out, In>`; the Client holds a `RemoteStreamHandle<Out, In>`. Both are exported from the main entry point of `@deepseek-ai/dsh-typert-protocol`, and the handle interface has no Host dependency. The generated Client contract writes the return type as `RemoteStreamHandle<Out, In>`. One name has one meaning: the `RemoteStream` that Client code obtains from the main entry point is always the declaration type and is never confused with the handle.

### Gateway Host (`packages/api/gateway/src`)

```text
// types.ts
export interface InvokeRemoteRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  /** Uplink items; absent is equivalent to an iterator that ends immediately. */
  readonly uplink?: AsyncIterable<unknown>
  /** The Peer that initiated the call; absent means the operator. */
  readonly peer?: PeerScope
  readonly signal?: AbortSignal
}

export interface TypertGatewayWireStream {
  open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: PeerScope | undefined, signal: AbortSignal) => Promise<AsyncIterable<unknown>>
  failure: (error: unknown) => RemoteStreamFailure
}

// stream-server.ts
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

// index.ts Config addition
/** Uplink inbox limit per logical stream, in UTF-8 bytes of frames (default 262144). */
readonly streamInboxBytes?: number
```

`prepareInvocation`:

```text
const args = await Promise.all(descriptor.parameters.map(parameter => this.resolveParameter(parameter, request.args, endpoint)))
const signal = request.signal ?? NEVER_ABORTED_SIGNAL
const invocation = new GatewayInvocation(
  { namespace: request.namespace, method: request.method, args: request.args },
  descriptor.service,
  request.peer ?? this.operatorPeer(),
  signal,
  new UplinkDecoder(request.uplink ?? EMPTY_ASYNC_ITERABLE, descriptor.uplink?.codec, endpoint, control),
)
const callReceiver = receiverContext.extend({ invocation }).get(descriptor.service) as object
if (descriptor.cancellation !== undefined) args.push(signal)
```

`GatewayInvocation.uplink()` returns the decoder on the first call and throws on the second. `UplinkDecoder` is a hand-written iterator: with a codec it runs `decode(codec, value, endpoint, 'uplink')` per item and, on failure, calls `control.abort(failure)` and throws; without a codec it applies only the `isRemoteJsonValue` check. The `finally` of `cancellableStream` closes the decoder first (`invocation.close()`) and then awaits the method iterator's `return()`, so a method blocked on `uplink.next()` can exit. The mode branches are the existing two, unary and stream. SRC fallback: the descriptor has no `uplink` codec, and `uplink()` delivers `unknown`.

### Gateway Host mux (`stream-server.ts`)

```text
interface ActiveStream { readonly control: AbortController; readonly inbox: UplinkInbox; done: Promise<void> }

/** Bounded uplink queue; iterated as the source of uplink(). */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  constructor(maxBytes: number, onOverflow: (error: RemoteError) => void)
  push(value: unknown, frameBytes: number): void   // push after ended fails the stream with gateway/protocol; overflow calls onOverflow
  end(): void                                        // idempotent
  fail(error: unknown): void                         // ends the iterator with an error on cancel or carrier closure
  next() / return()                                  // hand-written: next races failure, return releases immediately
}
```

`receive(text)` dispatch:

```
open   : exists → throw (socket 1008); otherwise create { control, inbox, done } and start the pump
item   : missing → ignore; otherwise inbox.push(value, bytes)
end    : missing → ignore; otherwise inbox.end()
cancel : missing → ignore; otherwise control.abort(new Error('Remote stream cancelled'))
```

`pump` passes the inbox and the socket's Peer to the opener and calls `inbox.fail(...)` in its `finally`. An abort whose reason is a `RemoteError` is sent by the pump as an `error` frame (a failure raised by the Gateway or the mux); an abort whose reason is a plain `Error` (cancel, socket closure) sends no terminal frame.

### Gateway Client (`packages/api/gateway/src/client`)

- `prepareInvocation` strips no uplink parameter; the positional parameters are the business parameters plus the optional `signal`.
- `invokeStream` returns a `RemoteStreamHandle`: it holds an uplink queue internally, `send` enqueues and a pump sends the `item` frames, `end` sends the `end` frame, and `dispose` aborts the generation signal. The downlink is still the iterator that `openRemoteStream` returns.
- `RemoteStreamMuxClient.open(endpoint, payload, signal, uplink?)`: after sending the `open` frame it starts the uplink pump, which sends one `item` per item and `end` when the source ends; when the downlink terminates or the signal aborts, it stops the pump and calls the source's `return()` (without awaiting, so a keyboard-style generator cannot hang it); when the source throws, it calls `inbox.fail(error)`, the downlink fails with that error, and `finally` sends `cancel` under the existing rules. The pump checks `this.socket === socket`, so an old generation never sends frames on a new socket.
- In-process carrier: `connection.rpc.open(channel, endpoint, payload, signal, uplink)`.

## Placement

| Package | Carries |
| --- | --- |
| `dsh-typert-protocol` (`types.ts`, `index.ts`) | `RemoteStream`, `RemoteStreamHandle`, `PeerId`, `PeerScope`, `RemoteInvocation`, the `ctx.invocation` declaration merge, `InvocationDescriptor.uplink`; the decorator recognizes only `mode: 'stream'`; `TypertRemoteService` registers the `invocation` accessor when constructed |
| `dsh-typert-registry` | Load-time validation that `uplink.codec` is a valid strict codec |
| `dsh-typert-generator` (`model.ts`, `analyzer.ts`, `emitter.ts`) | `remoteResultType` recognizes `RemoteStream<Out, In>` and generates the `uplink` boundary; the descriptor emits `uplink: { codec }`; the generated Client signature returns `RemoteStreamHandle<Out, In>`; the parameter loop accepts only business parameters and a final `signal` |
| `dsh-client-connection` (`operator-peer.ts`, `rpc.ts`, `rpc-host.ts`, `index.ts`) | The operator `PeerScope`; `connection.operator` and `admit`; the `/api` and upgrade routes obtain the Peer through `admit`; the optional `uplink` of `rpc.open` |
| `dsh-api-gateway` Host (`stream-protocol.ts`, `stream-server.ts`, `types.ts`, `index.ts`) | `item` / `end` frames; `UplinkInbox`; `Config.streamInboxBytes`; `GatewayInvocation` and `extend({ invocation })`; `UplinkDecoder`; `handleUpgrade(req, socket, head, peer)`; `operatorPeer()` |
| `dsh-api-gateway` Client (`client/index.ts`, `client/stream-client.ts`) | `invokeStream` returns the handle; the uplink pump is driven by the handle's queue |
| `dsh-webworker-runtime`, `dsh-remote-mock` | The worker tunnel's two uplink frames and the `serveStream` assembly; `StreamHandle.uplink`; the direct proxy returns the real handle |
| Documentation | The READMEs of gateway, the api group, connection, protocol, and generator; `docs/api-gateway`; the type-equiv blocks of `docs/subsystems/typert`; the config and Cordis catalogs |

## Key sequences

### Open, uplink, half-close, downlink end

```
Client caller      mux client              mux server              gateway                 Host method
   │ attach(req)        │                       │                     │                         │
   │───────────────────▶│ open { id, ep, payload } ──────────────────▶│ create inbox            │
   │ s.send(v1)         │ item { id, v1 } ───────────────────────────▶│ inbox.push(v1)          │
   │                    │                       │                     │ prepareInvocation       │
   │                    │                       │                     │ extend({ invocation })  │
   │                    │                       │                     │── method(req, signal) ─▶│
   │                    │                       │                     │                         │ uplink() → v1
   │ s.send(v2)         │ item { id, v2 } ───────────────────────────▶│ inbox.push(v2)          │ → v2
   │ s.end()            │ end { id } ────────────────────────────────▶│ inbox.end()             │ iteration ends
   │◀── yield o1 ───────│◀────────────────────── item { id, o1 } ─────│◀── yield o1 ────────────│
   │◀── ends ───────────│◀────────────────────── end { id } ──────────│◀── method returns ──────│ gateway calls uplink.return()
```

### Client dispose

```
Client caller      mux client              mux server              gateway                 Host method
   │ s.dispose()        │                       │                     │                         │
   │───────────────────▶│ stop pump; source return() (not awaited)    │                         │
   │◀── iterator ends ──│ cancel { id } ─────────────────────────────▶│ control.abort()         │
   │                    │                       │                     │ cancellableStream: invocation.close() closes uplink
   │                    │                       │                     │ iterator.return() ─────▶│ finally cleanup
   │                    │                       │ no terminal frame   │                         │
```

### inbox overflow

```
Client caller      mux client              mux server                        gateway / Host method
   │ s.send(vN)         │ item { id, vN } ─────▶│ inbox.push: bytes > streamInboxBytes │
   │                    │                       │ onOverflow → control.abort(RemoteError uplink-overflow)
   │                    │                       │                                      │ uplink() ends with that error; method iterator return()
   │◀── throw ──────────│◀──────────────────────│ error { id, uplink-overflow }: the pump sends an error frame because the reason is a RemoteError
```

## Boundary matrix

| Event | opening | running | Uplink ended | Downlink terminated |
| --- | --- | --- | --- | --- |
| `item` received | Buffered in the inbox | Into the inbox | The stream fails with `gateway/protocol` | Ignored |
| `end` received | inbox.end | inbox.end | Idempotent | Ignored |
| `cancel` received | abort | abort | abort | Ignored |
| inbox overflow | The stream fails with `uplink-overflow` | Same | Impossible | Impossible |
| Decode failure | Impossible | The stream fails with `input-invalid` | Same | Impossible |
| Host method finishes | Impossible | Sends `end`; `uplink.return()` | Sends `end` | Already sent |
| Host method throws | Sends `error` | Sends `error`; `uplink.return()` | Sends `error` | Already sent |
| Socket closes | abort, await done | Same | Same | Nothing |
| Client `send` | Queued, sent after open | Sent | Throws | Throws |
| Client `end` | Recorded, sent after open | Sent | Idempotent | Ignored |
| Client-side downlink ends first | Impossible | Stop the pump; source `return()`; no `end` sent | Nothing | Nothing |

## Error codes

| Code | When |
| --- | --- |
| `gateway/input-invalid` | Existing: a parameter codec fails to decode; new: an uplink item fails to decode |
| `gateway/uplink-overflow` | New: the inbox exceeds `streamInboxBytes` |
| `gateway/protocol` | New: an `item` after `end` |
| `gateway/cancelled` | Existing: `signal` aborted |

New codes are registered in `packages/api/gateway/src/remote-error-codes.ts` and in the README's error-code section.

## Minimal echo method

`packages/api/gateway/tests/echo-stream.host.spec.ts` runs the same method through the WebSocket carrier and through the in-process carrier:

```text
class EchoService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'echo', { namespace: 'echo' }) }

  @Remote({ mode: 'stream' })
  async *echo(prefix: string, signal: AbortSignal): RemoteStream<string, string> {
    for await (const item of this.ctx.invocation!.uplink<string>()) {
      signal.throwIfAborted()
      yield `${prefix}${item}`
    }
  }
}

// Client
const stream = remote.echo.echo('> ')
stream.send('a'); stream.send('b'); stream.end()
const replies: string[] = []
for await (const reply of stream) replies.push(reply)   // ['> a', '> b']
```

## Alternatives considered

**A shared cancellation controller for all three reading loops.** Each loop already has an owner with distinct close behavior. Read-local promises bound retained state without moving those responsibilities into a new abstraction.

**Requiring source iterators to cancel their own `next()`.** Gateway accepts arbitrary iterables, whose pending reads need not respond to cancellation or `return()`. Gateway must still wake its own waiters independently of source cleanup.

**A separate `mode: 'duplex'` plus a reserved parameter `uplink: AsyncIterable<In>` alongside `signal`.** Special logic everywhere: the analyzer must recognize a second reserved parameter and its position rules, the generated signature gains a parameter, load time must validate `duplex ⟺ uplink`, and because the mux does not know the method mode, the Gateway must reject uplink frames on behalf of `'stream'` methods. Duplex is an inherent property of the transport-layer stream, not a mode of the method: the carrier already has `streamId`, `open`, and `cancel`; the uplink adds just two more frames, which any stream can receive and which are simply not sent when unused.

**Declaring the uplink type in a decorator option, `@Remote({ mode: 'stream', uplink: 'JobInputFrame' })`.** A string reference to a type name is not checked by the compiler and breaks on rename. The return-type alias puts both types in one compiler-visible place.

**Passing a schema at runtime: `uplink(schema)`.** Bypasses the generator, the Client loses type projection, and it splits from the "strict codec per item" system. The codec still comes from the generator; the generic in the method is only an assertion.

**Having the analyzer cross-check the hand-written generic of `uplink<In>()` against the return type.** A business-specific check whose mistakes the caller bears, consistent with the other hand-written assertions in the repository; not added.

**A transport-layer handle with reopening, cursors, and a `reopen` hook.** Reopening after disconnection belongs to the upper-layer protocol: a job resumes through an `opened` frame carrying `from` and a client that remembers `next` and calls again; snapshot and journal each have their own anchors and classification. The transport layer knows one generation.

**Putting the Client's `send` on the `AsyncIterable` the generated method returns.** Hanging methods on an `AsyncIterable` is unconventional; the handle type `RemoteStreamHandle` extends it explicitly.

**Copying the Access mechanism.** Access control is business semantics, served by `vouch` and the `remote/invoke` waterfall; this Note only needs "whose stream is this", and `PeerScope` suffices.

**Keeping unary RPC for the uplink.** One HTTP round trip, one authentication, and one lookup per uplink; two carriers with no ordering relation that only Client-side serialization can order; no EOF; cancellation that does not cover both halves; a hand-made correlation key per feature.

**A native HTTP request body stream.** A one-shot request body with no association to the downlink stream, bypassing Typert descriptors, and browser support for full-duplex fetch cannot be relied on.

**One dedicated WebSocket per duplex stream.** Loses the authentication, heartbeat, and multiplexing shared with the existing downlink streams, and every feature manages its own socket lifecycle.

**WebTransport or HTTP/2 bidirectional streams.** They have per-stream flow control, but support on the browser and Node sides, proxy traversal, and the Electron carrier are all immature; adding two frames to the existing mux is orders of magnitude cheaper than replacing the transport layer.

## Consequences

- **Bought**: one stream with two directions, so interactive scenarios such as terminal keystrokes, approval answers, and background-job stdin no longer each build their own "one stream plus one unary"; a Host method knows its caller; the uplink and downlink types are declared in one place, the return type; uplink items come from the browser and are validated strictly per item at the Host, while downlink items are Host-produced typed values that pass straight through; the generated output and wire frames of existing `AsyncIterable<Out>` methods and unary methods are completely unchanged.
- **`this.ctx.invocation` is `undefined` outside a Remote call**, so a method that reads it must handle the optional; a service method invoked only directly in process correctly reads `undefined`.
- **The inbox limit applies to every stream**: a method that does not read its uplink fails as a whole when it receives many uplink frames. This is a deliberate explicit failure, recorded in the README.
- **The operator is the only Peer**, and `admit` is the only admission point; the first consumer that needs a second Peer must add opening, association, and events in `dsh-client-connection`.
- **No cross-direction ordering guarantee between uplink and downlink**; a protocol that needs request-response pairing carries its own sequence numbers.
- **Upper-layer protocols do not yet expose `send`**: consumers of `$stream`, snapshot, and journal use only the downlink today; the object they receive is already the handle.
- **The worker tunnel behaves differently from the WebSocket carrier**: no inbox limit, and items after `end` are dropped, because page to worker is a same-origin trusted boundary.

## Testing

Retention cases in `gateway-stream.host.spec.ts` and `gateway.client.spec.ts` count live iterator results after a full GC while the streams remain open. Lifecycle cases cover normal close waking multiple pending uplink reads, cancellation between reads, synchronous abort followed by a source exception, and termination during a Client send.

- `packages/api/gateway/tests/echo-stream.host.spec.ts`: the same echo method passes through the WebSocket carrier and through the in-process carrier.
- Gateway Host: exact-key validation in frame parsing; `UplinkInbox` buffering during opening, `item` after `end`, overflow, ignored unknown `streamId`, and cleanup on socket closure; `UplinkDecoder` delivery with and without a codec and abort on decode failure; `uplink()` taken only once; the `extend({ invocation })` view and the origin of `peer`; `cancellableStream` closing the uplink before `return()`.
- Gateway Client: the handle's `send` (JSON validation, queued before open, throws after termination), idempotent `end`, `dispose` driving the `cancel` frame and ending later reads; the pump's three exits; the pump stopping as soon as a terminal frame arrives.
- typert: the analyzer's handling of `RemoteStream<Out, In>`, `RemoteStream<Out>`, `never`, and the existing `AsyncIterable<Out>`; decorator options; registry load-time validation.
- connection: the three outcomes of `admit`, 401, 403, and the operator; the operator reaching handlers through the bridge and the shared handler; release with the Connection.
- remote-mock and the worker tunnel: uplink pass-through; the direct proxy returning the real handle.
- Existing stream and unary method tests pass without changed expectations.

## Deferred

- `$stream` / snapshot / journal expose the handle's `send` to upper-layer protocols.
- Web terminal: one `attach` stream replaces `follow` plus `write` plus `resize`, and `attachmentId` retires.
- Duplex `$events`: waterfall answers become uplink items on the same `streamId`, and `$events/result` and `clientId` retire.
- Credit frames: wait for a consumer that needs sustained high-volume uplink; the inbox limit is the initial credit.
- The `streamInboxBytes` default of 262144 is far more than keyboard and stdin need; if the first consumer is terminal paste, it may be aligned with the `maxInputBytes` of `terminal-controller`.
- A Host-initiated half-close frame (the Host stops reading the uplink but keeps writing the downlink): no consumer; not added.
- `uplink()` on unary methods: it can read items that arrive while the method runs, semantically valid but of doubtful use; allowed, noted in the README.

## Related

- [Remote event delivery](2026-08-10-remote-event-delivery.md): the unary `$events/result` answer path; the duplex `$events` item under Deferred partially supersedes it once it lands.
- [Session history and event transport](2026-08-18-session-history-and-event-transport.md): the `$stream()` supervisor and the journal / snapshot protocols above it, which this note leaves unchanged.
- [Web sidebar terminal](../feature/2026-09-09-web-sidebar-terminal.md): the unary terminal `write` and `attachmentId`; the `attach` stream under Deferred replaces it once it lands.
