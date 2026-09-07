# Agent Note: Session history, control state, and Remote event transport

Status: implemented

English | [中文](2026-08-18-session-history-and-event-transport.zh.md)

## Problem

The browser consumes three kinds of data with different lifecycles: persistable, paginated Session logs; process-local state that needs an opening baseline to converge after reconnect; and immediate notifications that need no replay.

These kinds of data cannot share one recovery rule. Session logs have stable sequence numbers and persistence, so a cursor can fill gaps; queue, jobs, and Workspace lists need a complete snapshot to replace an old mirror; ordinary notifications only promise delivery within the current Connection generation.

Observing Session history, lists, and projections must allow cold reads. If transport performs a general Typert lookup whenever an argument contains a Session or Agent, opening a page, switching tabs, or reconnecting the network implicitly resumes an Agent, so observation gains execution side effects.

Commands such as prompt, create, fork, and model selection do need to create or resume an Agent according to their own semantics. Activation authority must belong to each Remote method, not be decided implicitly by the carrier, parameter types, or a shared lookup.

The legacy API Proxy all-Session mux, `HostFrame`, and Workspace notifications encode domain data, baselines, errors, and connection lifecycle in one handwritten protocol. Each additional state duplicates frame declarations, a Client bridge, reconnect handling, and cleanup logic, while API Proxy cannot return to owning only business methods that have not yet migrated.

Host-to-Client Cordis events also have two invocation modes. Ordinary notifications only need broadcast delivery; Agent-scoped waterfalls such as Approval and Question must let a Client claim, delegate through `next()`, return a result, or reject while preserving one Host invocation identity across multiple Clients, disconnects, and cancellation.

These requirements need one general transport lifecycle without making Gateway understand Session, Workspace, Approval, or Question business data.

## Decision

API Gateway owns Remote transport, stream lifecycles, and Remote Event coordination. Session Controller and Workspace Controller own their Host APIs, wire types, and Client domain adapters. Client Runtime only composes and consumes these objects; it does not implement another carrier state machine.

Current ownership is:

```text
[client/connection]
|-- Host description
|-- Connection generation
`-- unary RPC transport

[api/gateway/client]
|-- RemoteStream
|-- RemoteSnapshotStream
|-- RemoteJournalStream
`-- ctx.remote.$on + $events pump

[api/session-controller]
|-- ctx.remote.session unary commands
|-- session.control snapshot stream
|-- session.page + session.follow journal
`-- Session Client adapters

[api/workspace-controller]
|-- ctx.remote.workspace unary commands
|-- workspace.follow snapshot stream
`-- Workspace Client model and adapter

[api/remotes]
`-- application Remote Event allowlist and Host Cordis source

[client/runtime]
`-- compose Session and Workspace domain state for consumers
```

API Proxy owns neither the Session or Workspace Remote namespace nor the Host downlink event carrier. `/api/events.host`, `HostFrame`, `stream/error`, `ServerRequest`, and their WebSocket/SSE branches do not participate in this data path.

### Connection generation and physical connections

The browser's Client Remote plugin starts `RemoteStreamMuxClient` idempotently on activation and connects to `/api/remote.mux` immediately. The physical WebSocket remains resident even when there is no business logical stream, but the mux performs no independent retry scheduling.

The Host sends one RFC 6455 Ping control frame to every open mux socket at the configured `websocketHeartbeatIntervalMs` interval (two seconds by default). The browser replies with Pong at the protocol layer; neither control frame enters the Remote stream JSON union or changes Connection generation state. Before each Ping, the Host marks the socket as awaiting Pong and terminates it at the next interval if no Pong arrived.

After an initial connection failure or the loss of a connected socket, open logical streams end their current physical generation with `RemoteStreamCarrierError`. `ConnectionController` owns the continuous exponential retry schedule with a capped delay; each attempt asks the mux to replace any candidate or active socket exactly once before reopening `$events`. A user-requested reconnect resets the attempt sequence and bypasses the delay through the same path ([decision](../../archived/feature/2026-08-28-web-connection-recovery-control.md)).


The browser's network-status events are inputs to the same Controller. `offline` withdraws the Connection generation and suspends automatic retries; the next `online` transition restarts the base backoff. These events never establish connectivity: only a fresh `$events` ready frame publishes a Connection generation.

In-process `connection.rpc.open` uses the same logical endpoint semantics while bypassing the browser WebSocket mux.

The Gateway-internal `$events` logical stream is the sole generation source for `ConnectionHandle`. It does not depend on whether any business `$on` subscription exists, so connection health does not vary with the number of UI listeners.

The Host event source installs incremental listeners synchronously before returning its first frame. Gateway then sends `{ type: 'ready', clientId, host: { home } }`; this frame proves that the current generation can receive increments and carries the stable Host path-display fact.

`ConnectionController` publishes `connected` only after `$events` readiness, so a Session or Workspace baseline cannot be read before Host incremental listeners are ready.

Unexpected normal completion of `$events`, a Host error, a malformed opening frame, or a carrier failure ends the current Connection generation. Connection withdraws the generation, then re-establishes `$events` under its bounded backoff unless the browser is offline or a user requests an immediate retry.

Gateway stream generation, Connection generation, and a Session business open epoch are three independent counters: the first identifies physical replacement of one logical stream, the second identifies a Host-availability handshake, and the last prevents an obsolete Session open from writing into current state.

Host plugin disposal stops the heartbeat timer, terminates mux sockets, and waits for active iterators. Client plugin disposal stops retry delays, cancels candidate and active sockets, ends logical streams, and awaits quiescence of background loops and consumers.

### General Remote stream model

Gateway Client provides three React-independent, single-consumer lifecycle objects:

```text
RemoteStream<Item>
|-- RemoteSnapshotStream<Snapshot, Delta>
`-- RemoteJournalStream<Page, Entry, Cursor>
```

Domain Controllers use them through composition or thin adapters; Session and Workspace do not inherit a common Controller base class that knows domain frames.

#### `RemoteStream`

`ctx.remote.$stream(options)` returns a `RemoteStream<Item>` responsible for reopening, cancellation, and disposal of one logical stream across physical generations.

Each item carries a monotonic generation, that generation's `AbortSignal`, and `accept()`. A domain consumer calls `accept()` only after validating the opening cursor or baseline.

Only `RemoteStreamCarrierError` permits retry. When the Host remains available, one independent reopen is allowed; otherwise the stream waits for a new Connection generation. Business errors, protocol errors, and opening failures terminate immediately.

`restart()` replaces only the current physical generation and preserves the logical stream. `dispose()` permanently ends the logical stream, pending retry, and iterator, then waits for quiescence.

`RemoteStream` does not understand baselines, deltas, pages, cursors, sequence numbers, or any domain frame.

#### `RemoteSnapshotStream`

`RemoteSnapshotStream<Snapshot, Delta>` requires each generation to start with exactly one complete snapshot, followed only by deltas.

An update before the snapshot or a second snapshot in the same generation is a terminal protocol error.

The generation is accepted only after its snapshot has been applied successfully. The previously published state remains readable while the carrier reconnects, and the new generation's snapshot replaces the old mirror atomically.

The domain adapter supplies frame discrimination, snapshot replacement, a delta reducer, carrier state, and a terminal failure sink. The general layer parses no Session or Workspace fields.

Session control and Workspace state each use an independent `RemoteSnapshotStream`.

#### `RemoteJournalStream`

`RemoteJournalStream<Page, Entry, Cursor>` combines one live follow with a page method in the same namespace. It applies to an append-only journal with a stable order, paginated history, and a live tail.

Initial opening establishes follow and obtains its opening cursor before reading the initial page. Live entries produced while the page request is pending already enter the follow queue, closing the race between reading history and subscribing afterward.

The general layer removes overlap between the page and queued entries by cursor, verifies continuity, and publishes one complete window after the page covers the opening cursor.

Contiguous live entries publish `append`; older history pages publish `prepend`. Reconnect, cursor jumps, or continuity that cannot be proven trigger a tail-page repair.

The old window remains readable during repair. The page and live entries accumulated during that read form a continuous window and publish one `replace`, never exposing a half-repaired state.

If a page request is canceled with its physical carrier generation, the journal waits for the next generation's opening cursor and rereads the page at that cursor. This cancellation does not leak to the domain object as a terminal page failure.

`RemoteJournalStream` owns the opening cursor, resume cursor, pagination, reconnect catch-up, overlap removal, and gap repair. A domain Session object does not copy these state machines.

### Session Controller

`packages/api/session-controller` provides Host `ctx.sessionController` and the generated `ctx.remote.session` namespace.

It owns Session list, search, create, selectModel, rename, fork, prompt, attachment, updateQueue, cancel, page, follow, and control. The Host-generation model catalog is exposed separately through `session/modelCatalog` because it is not Session-specific.

The package separates agent, commands, control, history, and list controllers internally, but Session identity resolution, activation policy, subagent ownership, and Remote error projection have one public owner.

Other Host Remote namespaces reuse the same identity rules through `ctx.sessionController.inspect()` or `resolveAgent()`; they do not retain a second Session resolver.

#### Activation policy

Session Remote methods pass `SessionId` or `SessionAddress`; parameter types do not trigger a general Typert Session lookup.

Each method explicitly selects a cold inspection, live-only lookup, or resume-capable resolution:

| Operation | Source or result without a live Agent | Activation rule |
|---|---|---|
| `session.list`, `search` | headers and projection cache; a bounded small-log read can resolve uncertain blankness | Never resumes an Agent |
| `session.page(address)` | attached Session or persistence log | Never resumes an Agent |
| `session.follow(address)` | one live or prepared observation carrying the opening page and projections | Publishes the snapshot first, then promotes an ordinary cold Session once in the background |
| `session.control()` | current attached Agents, pending registry, and process-local registries | Baseline and reconnect do not resume an Agent |
| `session.attachment`, fork source read | authorized durable Session data | A read does not resume an Agent |
| `session.updateQueue`, `cancel` | only the current live Agent | Does not resume vanished state |
| `models`, `selectModel`, `rename`, `prompt` | command resolves the target Session | Resumes only when the method explicitly permits it |
| `create` and fork target | new Session/Agent | The user command supplies creation authority |

Reading titles, lists, and projections does not require an Agent. An observation operation cannot inherit resume authority merely because another Remote endpoint uses Agent lookup.

`SessionQuery.observeSession()` chooses an attached Session or serves a cold one from the reader's own prepared cache, filled through a persistence read handle. The cache shares concurrent cold reads and pins an entry until every observation lease is released. An observation computes either all registered projections or none; callers may expose a subset, but no caller creates a partial projection state.

`session.list` never performs an unbounded cold-log scan. It uses cached projection hints when available and may fully observe only an individually stored artifact within the configured small-log byte limit to distinguish an abandoned blank Session. Missing or unreadable hints keep the row visible with unknown metadata.

`model/selection` is a required-on-read durable event because it changes the model route used by the next request. Its projection records both the last request selection and a later pending selection; prompt assembly consumes the pending value when the matching `request/header` is committed.

#### Session journal

`session.page` returns a history window clipped on message boundaries with contiguous internal sequence numbers. Every request must carry an explicit `throughSeq`; this value comes from the corresponding `session.follow` generation's opening cursor and fixes the read at the same log cut. A tail page without `beforeSeq` must end exactly at `throughSeq`, where `-1` denotes an empty log. `beforeSeq` only selects an older page before that cut and cannot replace the synchronization cursor. `maxMessages` limits user/assistant message count without dropping chunks, tools, or state events between those messages.

The tail page also carries a projection baseline no later than `throughSeq`; older pages carry only historical entries. The Client merges pages and subsequent live control updates by projection watermark.

Ordinary Sessions and direct subagents use one `SessionAddress` protocol. A direct-subagent address carries parent Session, child Session, and mode; a cold Host read verifies durable ownership and descriptor rather than authorizing access from the child id alone.

`session.follow` installs `session/event` and `session/created` listeners before observing an attached or prepared Session.

The first follow response is a complete `{ type: 'snapshot', header, cursor, events, hasMore, projections }` frame. Every reconnect sends another complete snapshot replacement; the protocol has no `afterSeq`. Events committed during observation remain buffered and are emitted after the snapshot in sequence order.

A cold ordinary Session can publish its prepared snapshot immediately. After that first frame, the Controller transfers a retained observation to one background promotion; follow does not wait for activation. Direct-subagent addresses never use this promotion path.

Client `SessionEventStream` extends `RemoteJournalStream` and supplies only `session.follow`, `session.page`, the Session sequence algorithm, and repair requests. The general layer validates and publishes the opening snapshot directly. It calls `session.page({ throughSeq })` only for older history or when a later event reveals a sequence gap.

```text
ctx.remote.session.follow(address, pageArgs) ----------------|
  snapshot(header, cursor, page, projections), event*        |[]> SessionEventStream
ctx.remote.session.page(address, throughSeq, pageArgs) -------|    |-- replace(window)
                                                                  |-- prepend(history)
                                                                  `-- append(live entry)
```

Each Client Session owns only one current `events: SessionEventStream | undefined`. The read-only `SessionEventSource` gives the materialized event window to Conversation consumers.

A Session's `openGeneration` only prevents an asynchronous result retired by resync, address replacement, or disposal from writing into current state. It does not participate in transport retry.

A terminal failure from the initial page, repair page, or follow enters the current Session's `openError`. A stale business epoch or stale stream cannot overwrite newer state.

#### Session live control

`session.control()` is a Host-wide snapshot stream. One browser can observe transient state for all current live Sessions without opening a journal for every transcript.

Each generation emits a complete baseline first, followed by queue, jobs, and projection deltas. The baseline reads attached Agents and process-local registries without resuming cold Agents.

Queue and jobs use complete replacement values and apply last-wins. Agent attach, detach, Session disposal, and owner disposal can all clear a stale mirror through an empty value or a new baseline.

The original `approval/request` and `user-questions/request` events are forwardable waterfalls. If an Agent-scoped Client listener claims a request, it returns directly. If all delivered Clients call `next()`, the original Cordis waterfall continues to later Host listeners. Session control neither stores nor replays these requests.

The projection baseline and a tail page's log cut are produced independently. The Client always retains the value with the higher sequence number. Subscribing to live projection does not start an Agent merely to obtain a value.

Session added, removed, activity, running status, and Agent error without a turn position do not enter the stateful control stream; they are `ctx.remote.$on` notifications that are either repairable from a list baseline or need no replay.

Session-list `updatedAt` is `max(header.createdAt, sessionListMetadata.lastPromptAt)`. Only a user-originated `user/message` updates `lastPromptAt`; it can be recovered from a cold projection and does not depend on whether a browser follows that Session.

### Workspace Controller

`packages/api/workspace-controller` provides Host `ctx.workspaceController` and the generated `ctx.remote.workspace` namespace.

It owns create, rename, delete, insertBefore, insertSessionBefore, archiveSession, and `follow`. Workspace registry remains the durable source of truth; the Controller owns Remote commands, projection, and error mapping.

`WorkspaceFeed` synchronously observes storage `domain/changed`, and each follow generation emits a complete baseline before `upsert`, `remove`, `order`, and `archived` deltas.

A complete `order` frame is authoritative for Workspace ordering. It avoids having the Client infer display order from upsert arrival order and converges after a reconnect baseline.

`createWorkspaceStateStream()` assembles `workspace.follow` as a `RemoteSnapshotStream`. Client Runtime only starts and owns that stream.

`ClientWorkspaceModel` lives on Workspace Controller's Client face. It owns baseline/increment parsing, the materialized list, the archived set, command-result echo, and merge rules for races between unary and stream arrivals.

A successful unary command can update the local model immediately; a later stream commit still corrects state with the Host projection and complete order. Deleted Workspace ids are recorded so a delayed result cannot reinsert them.

```text
ctx.remote.workspace.follow() -|[]> RemoteSnapshotStream
                                      |-- replace(baseline)
                                      |-- upsert/remove(view)
                                      |-- replace(order)
                                      `-- replace(archived ids)
```

Workspace Remote methods, state feed, and Client data model do not pass through API Proxy or depend on `host/workspace-*` notifications.

### Remote Event

Remote Event reuses owner packages' Cordis `Events` declarations. The original Host event is the sole business signature, and Client `ctx.remote.$on(event, listener)` derives its parameters, waterfall result, and `next()` from that declaration.

The allowlist in `packages/api/remotes` is the sole source of application selection. Each entry explicitly marks `emit` or `waterfall`; this mode determines Host listening, the legal Client key set, and the wire frame type together.

The system declares no `RemoteInvocationMap`, requires no second Client `@Remote`, and does not infer invocation mode by checking whether the final runtime argument is a function.

Remote Event downlink frames form an explicit discriminated union:

```text
ready     { type, clientId }
emit      { type, event, args }
waterfall { type, event, eventId, agentId, request }
cancel    { type, eventId }
```

Both WebSocket JSON and in-process carrier entry points start from `unknown` and validate the discriminant plus exact fields. Dispatch after validation accepts only the typed union. TypeScript static types do not replace wire validation.

Ordinary `emit` arguments must be lossless JSON. The Client calls `parallel()` on a Cordis key private to each Remote instance, preserving registration order, calling-fiber ownership, and listener-error isolation.

The private key prevents Host events and same-named Client-local Cordis events from triggering one another. Client Remote maintains neither its own subscription registry nor a handwritten listener chain.

Returning waterfalls currently support Agent scope only. The event signature must contain one request with a direct `agent` field followed by a `next()` returning the same result type, and the whole event returns a Promise.

The Host projects only top-level `agent` and `signal` fields from the request: `agent` becomes top-level `agentId` in the frame, `signal` becomes the delivery lifetime, and all remaining fields must be lossless JSON as a whole.

The Client synchronously resolves or materializes an Agent Context from `agentId`, restores the current delivery signal into the request's direct `signal` field, and invokes Cordis `waterfall()` on the target Context's private key. Before the first successful Session-list baseline, the Session-backed adapter lets transport materialize a scope; after that baseline, the list lifecycle owns scope liveness.

The system does not scan arbitrarily deep objects, transmit path arrays or placeholders, deep-clone/restore Context and AbortSignal, or wait for a future Agent Context.

When no Client adapter is registered, its resolver returns no Context, or resolution throws, that Client immediately returns `next`. It does not subscribe to a registry, recheck races after resolution, or create a temporary Fiber for one delivery.

Gateway Host retains `eventId`, the Host continuation, and delivered Client generations for every unfinished waterfall. A new Client generation receives a replay of the same pending event.

Each generation's queue guarantees one delivery, so the Client stores no `seen` set. `clientId + eventId` binds a result to the current generation; a reply from an old connection cannot complete delivery on a new one.

When several Clients receive a waterfall, the first result or rejection completes the Host invocation and sends `cancel` to the other Clients. Gateway continues the original Cordis chain only after every delivered Client returns `next`.

Host caller-signal cancellation, Agent Context disposal, Client-generation completion, and losing-Client cancellation all terminate their corresponding waits.

The Client returns `next`, result, or rejection through the existing HTTP unary RPC `$events/result`; downlink events continue to share the Remote WebSocket mux, with no duplex WebSocket for responses.

Gateway only verifies that a waterfall return value has a lossless JSON representation; it does not interpret business fields. Semantics such as whether a Question answer belongs to an offered option remain owned by the requester or UI domain and are not revalidated by transport.

When `UserQuestionService` observes that the caller's `AbortSignal` was canceled during a request and the provider threw an ordinary error, it normalizes that failure to `UserQuestionError` with `ASK_ABORTED` while retaining the original error as `cause`. A domain error already supplied by the provider preserves its identity.

A failure of `$events/result` fails the current Connection generation. Host withdraws that Client's delivery with the generation, the pending event is replayed in the next generation, and Client maintains no second result-retry queue.

Ordinary `$on` notifications are not replayed after disconnect. State whose correctness depends on recovery must have a query, cursor, or opening baseline and cannot rely on eventual Remote Event delivery.

An event is not replayed when its Client listener registers after arrival. HMR has no dedicated redelivery semantics.

### API Proxy's remaining boundary

Session Controller and Workspace Controller provide generated Remote namespaces directly; API Remotes and API Gateway provide Host-to-Client events directly.

Client Connection maintains only Host generation, description, and generic RPC. It does not parse domain frames.

Client Runtime only receives domain changes produced by Controller adapters. It recognizes no `HostFrame`, `session/subscribed`, `session/event` mux frame, or `host/workspace-*` frame.

API Proxy carries only independent business APIs it owns. Session, Workspace, Remote Event, and Connection generation do not depend on it.

## Alternatives considered

**Resume an Agent whenever any Session stream opens.** Viewing history, reading a title, reconnecting a tab, or observing background state would gain execution side effects, and multiple browsers could trigger duplicate resumes. Cold logs and projections already have persistence sources.

**Permit `session.follow` only for live Agents.** The first transcript render would have to resume an Agent or reintroduce the race between unary history and live subscription. Following by identity before a cold read covers both history and future explicit activation.

**Split Session transport and Session commands into two public packages.** Both depend on Session address, Agent activation policy, subagent ownership, error mapping, and Client mount ordering. One public Controller preserves unified ownership while internal classes can evolve independently.

**Move queue, jobs, projection, Workspace, and logs to ordinary `$on`.** Ordinary events have no reconnect baseline, cursor, or gap repair, so one missed delivery leaves permanently stale state. Only notifications that need no recovery, can be repaired by an independent query, or carry their own lifetime as a waterfall fit `$on`.

**Make every domain Controller inherit a page/follow/retry base class.** Session journals and Workspace snapshots have different opening, recovery, and ordering rules. Gateway's three compositional stream objects reuse transport lifecycle while domain adapters declare only their own frame semantics.

**Declare a separate Client invocation map for Remote Event.** A second map or Client `@Remote` would copy owner Cordis event signatures and create a drift point. Deriving `$on` listeners and results from the same `Events` declaration preserves equivalence by construction.

**Project Agent scope through arbitrary object depth.** Recursive Context and AbortSignal scans need path, placeholder, clone, and restore protocols and turn incidental object structure into a wire promise. Top-level `agent` and `signal` cover current waterfalls.

**Wait for a Client Agent Context or adapter before dispatching.** Registry waiters, post-resolution race checks, and temporary delivery Fibers add lifecycle to a Client that can synchronously resolve or materialize its target. Returning `next` when the resolver cannot provide a target immediately preserves Cordis waterfall semantics.

**Use an independent physical WebSocket or duplex stream for Remote Event.** Gateway mux already provides authenticated upgrade, multiplexing, cancellation, error mapping, and reconnect. Downlink `$events` plus HTTP `$events/result` expresses request/response without a third connection.

**Send application-level JSON heartbeat frames.** This would expand the strict Remote stream message union and require browser handling for traffic with no business meaning. WebSocket Ping/Pong provides carrier activity without changing logical-stream semantics.

**Retain API Proxy's Host mux.** This keeps the handwritten union, schema, response envelope, and second stream lifecycle, and prevents Session and Workspace Controllers from owning their data protocols independently.

**Update Session list time from aggregate `session/event`.** List correctness would depend on which Sessions a browser consumes and would mistake arbitrary plugin events for user activity. The durable `lastPromptAt` projection expresses the ordering fact directly.

## Verification

Gateway mux tests pin connection without logical streams, idle residency, one physical attempt per request, configurable Ping/Pong without application messages, active-stream carrier failure, cancellation, and no reconnect after disposal.

Connection tests pin missing, duplicate, and withdrawn generation sources, readiness timeout, and generation withdrawal and rebuilding after failure.

`RemoteStream` tests pin single consumption, retry reset after opening acceptance, generation-only `restart()`, no retry for terminal errors, and disposal quiescence.

`RemoteSnapshotStream` tests pin exactly one opening snapshot per generation, rejection of an update before a snapshot, rejection of duplicate snapshots, and reconnect replacement.

`RemoteJournalStream` tests pin snapshot-first opening, contiguous append, historical prepend, reconnect replacement, gap repair, and one atomic replacement.

Session Host tests pin cold page/follow without increasing attached Agents, contiguous events reaching a cold follow after an explicit prompt, direct-subagent ownership, message-aligned pagination, and terminal-error projection.

Session control tests pin baseline-first delivery, no cold-Session resume, attach/detach cleanup, queue and jobs replacement, and the projection watermark.

Session Client tests pin one journal owner per Session, no writeback from stale open epochs, independent cancellation of control and journal, and retaining the published window during carrier retry.

Workspace Host tests pin baseline-first delivery, upsert/remove, authoritative order, archived set, and follower disposal.

Workspace Client tests pin snapshot replacement, unary/stream races, no resurrection after delete, stable ordering, and terminal failure.

Remote Event type tests reject unselected events, non-void unscoped events, non-Agent-scoped waterfalls, and modes that disagree with signatures.

Remote Event Host tests pin listener-before-ready, payload validation, pending replay, first result across multiple Clients, all-next delegation, rejection, Host cancellation, Context release, and losing-Client cancellation.

Remote Event Client tests pin instance-private keys, Cordis registration order, Agent Context resolution, `next`, result, rejection, cancellation, rejection of stale-generation replies, and Connection-generation failure when `$events/result` fails. User Question tests pin normalization of in-progress signal cancellation and preservation of its cause.

Missing, duplicate, and withdrawn sources; non-ready first items; unknown discriminants; extra fields; and non-JSON values all fail loudly at their respective wire entries.

Static checks pin that API Proxy exports no Session/Workspace Host-frame carrier and Client Runtime contains no corresponding bridge.

## Consequences

The browser can read a durable Session while its Agent is stopped. Opening an ordinary Session publishes the prepared snapshot before one background promotion begins; list, search, page, and other observation-only reads never activate it.

Durable logs repair a missing suffix by sequence number and page; Session control and Workspace state converge through opening snapshots; ordinary Remote Events promise no replay. Recovery semantics follow the data kind instead of imitating one another.

Gateway owns only transport, generation, pending waterfalls, and strict wire validation, not Session or Workspace business fields. A domain Controller supplies only openers, cursor rules, baseline reducers, and error presentation.

Each resident browser connection adds one empty Ping/Pong exchange per configured interval. Deployments can shorten the interval for stricter idle timeouts without changing the Remote stream protocol or browser code.

Session and Workspace Host APIs, stream adapters, and Client data models each have an explicit owner. API Proxy is no longer their intermediary.

The general stream objects add three explicit layers while deleting the retry, cancellation, generation, baseline, and gap-repair shells previously duplicated by each Controller.

Remote waterfalls preserve first claim across multiple Clients, continuation of the Host chain after every Client calls `next`, reconnect replay of pending calls, and end-to-end cancellation. The current protocol supports only top-level Agent scope and lossless-JSON requests and results.

This decision extends the allowlist and single Cordis-signature design from [Remote event delivery](2026-08-10-remote-event-delivery.md): ordinary notifications use `emit`, while Agent-scoped async waterfalls use the same `ctx.remote.$on` surface with explicit `waterfall` mode. It creates no second invocation map.

This decision takes over the Session, Workspace, and Host-event carriers retained by [simple unary API Proxy migration](../../archived/architecture/2026-08-10-unary-apiproxy-remote-migration.md) while preserving the complete jobs snapshot, process-local lifecycle, and “observation does not resume an Agent” semantics required by [background job display](../feature/2026-08-08-web-background-job-display.md).
