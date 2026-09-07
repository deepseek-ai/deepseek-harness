# Agent Note: Cordis runtime tree inspection

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-cordis-runtime-tree-inspection.zh.md)

## Problem

The Inspector needs to present each Host and Client Cordis runtime as a tree in Chrome DevTools Elements. A Cordis Context or Fiber selected in Elements must also behave as a live Runtime object, while a Cordis object printed in Console must be revealable as the same semantic node. CDP identifiers cannot be the source model: `NodeId`, `BackendNodeId`, and `RemoteObjectId` have different owners and lifetimes, and a future model-facing runtime query must consume the same Cordis data without translating CDP.

Host and Client run the same Cordis abstractions in different JavaScript realms. Tree discovery and classification must therefore be one browser-safe implementation, while object resolution remains realm-local and only opaque references cross MessagePort or WebSocket boundaries.

## Decision

The Inspector uses one serialized Cordis tree model and keeps CDP as one adapter over it. The package separates live-object discovery, immutable snapshots, Worker-owned storage, and consumers:

The existing [cross-realm Inspector decision](../../implemented/architecture/2026-08-23-cross-realm-cdp-inspector.md) owns the Worker, source carriers, Runtime routing, and security model. This note owns only the Cordis semantic data and its consumers.

```text
Host Context/Fiber ─┐
                    ├─ CordisTreeCollector ─ CordisTreeSnapshot ─ source transport ─ CordisTreeStore ─┬─ CDP DOM adapter
Client Context/Fiber┘                                                                                 └─ future model adapter
```

`CordisTreeCollector` and its identity registry are browser-safe modules compiled into both package faces. Host and Client instantiate that same code against their own `ctx.root`; neither side carries a second classification implementation.

## Cordis tree model

`CordisTreeSnapshot` is a CDP-independent, lossless-JSON value with a schema version, monotonically increasing revision, object-registry id, truncation flag, and one nested root Context. Context nodes contain an opaque object handle and ordered Context/Fiber children. Fiber nodes contain their Cordis `uid`, an opaque object handle, and exactly one Context child representing `fiber.ctx`. Host and Client publish this same realm-tree type. No generated Context id, plugin metadata, service data, arbitrary property value, or object preview enters the tree.

The inspection tree starts at the root Context and omits the Cordis root Fiber. For every other plugin, its parent Context contains the Fiber and that Fiber contains its owned Context. A Context created by `extend()`, `isolate()`, or `intercept()` without a new Fiber remains a direct Context child. Nesting expresses parentage without generated node ids and preserves both object identities without introducing the `Fiber.ctx` / `Context.fiber` cycle.

The collector starts from the root, every live registry Fiber, and every event hook's owning Context. It follows Context prototype links back to the inspected root, unwraps Cordis shadow contexts, deduplicates by object identity, and excludes disposed fibers. `internal/plugin` and `internal/status` events schedule one microtask-coalesced replacement snapshot. Node-count and encoded-byte limits remove complete trailing branches, so every retained node still has its parent and every retained Fiber still has its owned Context.

## Identity and lifetime

The identities are intentionally distinct:

- Fiber `uid` comes from Cordis. Context currently has no Cordis-owned id and the Inspector does not expose a generated substitute.
- `InspectorObjectReference` is an opaque realm-local handle resolving a tree node to its live Context or Fiber. Snapshots carry the handle for routing, never as a semantic id or DOM attribute.
- `BackendNodeId` is assigned by the Worker to one retained `(source id, source generation, object reference)` and is shared by DevTools connections while that generation's snapshot is retained.
- `NodeId` is assigned per DevTools connection when a node enters that frontend's document. It remains stable while the corresponding backend node is retained and is discarded when that node leaves the tree, on the rare full-document fallback, or when the connection closes.
- `RemoteObjectId` is assigned by the selected Runtime session when `DOM.resolveNode` exposes the live object. It remains scoped to that DevTools connection and object group.

`sourceId` identifies one browser-tab Client runtime and is retained in that tab's `sessionStorage`, so automatic transport reconnects and page refreshes reuse it. Before opening the transport, a Client with Web Locks claims that id for its page lifetime; a simultaneously live tab copied from the same storage state cannot claim it and persists a fresh id instead. Browsers without Web Locks retain storage-backed refresh identity but cannot arbitrate copied live tabs. `generation` identifies one WebSocket admission and always rotates. Disconnect removes the synthetic context from the Console with `Runtime.executionContextDestroyed`. Reconnection announces a fresh CDP execution-context id because the destroyed id and its RemoteObjects cannot be reused, but this does not imply that the browser's underlying JavaScript realm was recreated.

Standard CDP does not place a `RemoteObjectId` field on `DOM.Node`. `DOM.Node` carries `nodeId` and `backendNodeId`; `DOM.resolveNode` returns the corresponding `Runtime.RemoteObject`, and `DOM.requestNode` performs the reverse mapping. The implementation keeps these three CDP identities correlated without adding non-standard DOM fields.

## Realm object bridge

Each collector registers a realm-local object table under a private global symbol. The table maps opaque handles to live objects and can identify a currently retained object by identity. Replacing a snapshot removes handles absent from the new tree; disposing the observer unregisters the table.

For Host nodes, the Worker uses that DevTools connection's private `node:inspector.Session` to evaluate a lookup in the Host table, producing a native V8 `RemoteObjectId`. For Client nodes, the Worker routes the same lookup through the existing typed Client Runtime channel and maps the returned Client handle to a connection-local CDP object id. No live object or engine object id crosses a source transport.

Client Runtime values carry an optional validated `InspectorObjectReference`, while Host Runtime values are probed through their native V8 object id. The common CDP adapter changes recognized evaluation results, properties, exceptions, Console arguments, and paused-frame objects to `subtype: "node"`, records the object-id-to-backend-node relation, and supplies the Cordis element description. This gives both directions: Elements can expose a live object, and a Context or Fiber returned or printed in Console can be revealed in Elements.

## Worker repository and updates

Sources publish the Cordis tree as retained state rather than an event history. Host MessagePort and Client WebSocket publishers keep the latest state record and include it in `source/replace` after admission, reconnection, or a resnapshot request. Live replacements still use the ordinary sequenced append path. The Worker validates every snapshot for exact fields, bounded node count and depth, unique object handles and Fiber uids, a Context root, and exactly one Context child per Fiber before atomically replacing the prior tree.

`CordisTreeStore` owns validated realm snapshots and source lifecycle only. Its internal reader retains live object routes for Runtime and DOM, while its public reader projects a detached `{ host, clients }` tree without transport or CDP ids. Host and Client `ctx.inspector.cordis.getTree()` calls use the same correlated query protocol and Worker reader without creating a CDP session. `CordisDomBackend` adds Worker-global backend ids, while each `CordisDomSession` owns frontend node ids, searches, enabled state, and RemoteObject correlations. A model adapter can consume the public reader without depending on DOM serialization or debugger activation.

Closing a source changes its stored tree from connected to disconnected instead of deleting the last snapshot. Object lookup excludes disconnected trees, so the snapshot remains inspectable as data without retaining or reviving a live Context, Fiber, or Runtime object. A replacement from the same source id and a new transport generation atomically restores the connected state. The configurable disconnected-tree limit evicts the oldest retained snapshots.

Accepted source snapshots rebuild the connection-neutral document and are diffed by stable backend node identity. A revision-only replacement emits no DOM event. Child insertion and removal use `DOM.childNodeInserted` and `DOM.childNodeRemoved`; attribute changes use their corresponding DOM events; sibling reorder falls back to `DOM.setChildNodes` for that parent only. Reusing one backend identity for a different node kind is the sole `DOM.documentUpdated` fallback. A disconnect invalidates object routes without changing the retained DOM tree, preserving expansion and selection; retention eviction removes only the evicted `<client>` node.

## CDP projection

The synthetic document has a `<host>` container and a `<clients>` container. `<host>` contains the Host root Context. `<clients>` contains one `<client>` per Client source, and each `<client>` contains that realm's root Context. These structural elements have no Runtime object or attributes. Context elements have no attributes. Fiber elements expose only `uid`, copied without reinterpretation from Cordis. Connected Context and Fiber elements resolve to live RemoteObjects; disconnected snapshots retain their DOM nodes but object resolution fails.

Standard CDP has no backend-controlled frozen, locked, or dimmed state for a node in the ordinary Elements tree. Chromium's detached-node presentation is frontend-local to the Memory panel's `DOM.getDetachedDomNodes` flow. No connection-state attribute or non-standard `DOM.Node` field is added until its presentation is decided.

The read-only adapter implements document retrieval, child requests, node description, attributes, outer HTML, search, backend-id pushes, node resolution, and reverse object lookup. Mutating DOM methods fail explicitly. Layout, CSS, accessibility, and browser DOM geometry are outside this semantic tree and return empty or unsupported responses only where Chrome DevTools requires a compatibility response.

## Alternatives considered

**Build CDP DOM nodes directly in each realm.** Rejected because Host and Client would duplicate classification, frontend ids would leak into source protocols, and a model consumer would need to reverse a presentation protocol back into Cordis concepts.

**Send live objects or V8 object ids to the Worker.** Rejected because structured clone and JSON do not preserve identity or behavior, and engine object ids belong to one inspector session.

**Generate an Inspector Context id.** Rejected because Cordis Context has no intrinsic id and a presentation adapter must not make an implementation key look like framework identity. Nested children express parentage; opaque object handles remain routing data.

**Use one id for Fiber uid, backend nodes, and frontend nodes.** Rejected because source reconnection, multiple DevTools connections, document refresh, and Runtime object release have independent lifetimes.

**Expose only Contexts and treat each Fiber-owned Context as the Fiber.** Rejected because it loses one of the two live objects, makes Console identity ambiguous, and prevents later Fiber-specific properties from having a stable owner.

**Put the model-facing API on the CDP adapter.** Rejected because model access would inherit Chrome-specific node serialization, per-connection ids, and enable state. The Worker repository is the shared source; CDP and model access are sibling adapters.

**Remove a realm tree when its source disconnects.** Rejected because transport loss would discard the last useful topology and collapse the user's Elements inspection state. Keeping old object handles usable was also rejected: a new connection generation cannot prove that any prior live object still exists.

## Verification

- The same collector implementation produces Host and Client snapshots from equivalent Cordis runtimes.
- Elements shows `<host>` and `<clients>/<client>` containers with each realm's root Context directly beneath its container.
- Context elements have no attributes; Fiber elements expose only their Cordis `uid`; the root Fiber is absent.
- Every connected Context and Fiber has a connection-local frontend node id, a Worker backend node id, and a resolvable connection-local Runtime object id without exposing them as attributes.
- `DOM.resolveNode` and `DOM.requestNode` round-trip Context and Fiber identities without sharing object ids across DevTools connections or source generations.
- A Context or Fiber returned by Runtime evaluation is node-branded and can be revealed in Elements.
- Disconnect destroys the Client execution context and its RemoteObjects while retaining the last Elements tree unchanged; a new transport generation replaces it after a complete snapshot arrives.
- Reconnect and resnapshot replay the latest tree state; unchanged snapshots emit no DOM mutation, while structural changes update only their affected parent or node. Malformed or oversized replacements do not replace the last valid snapshot.
- The stored snapshot and query API contain no CDP types and can support a future model-facing adapter unchanged.

## Consequences

Cordis exposes no complete global Context registry. The collector can recover contexts reachable from live fibers and event hooks; a context that is created, never used, and retained only by application code is intentionally absent.

Object recognition adds a Runtime round trip for each Host object that requires semantic identification. An annotation failure leaves an ordinary RemoteObject rather than breaking Runtime or Debugger delivery. Client Console observation preserves the original method result and schedules serialization afterward; each enabled DevTools session receives independently retained handles, so recognition never blocks the page call or shares objects between connections.

Sources continue to publish complete snapshots, keeping one shared Host/Client collector and allowing recovery after dropped observations. The Worker pays the snapshot comparison cost, then emits incremental CDP DOM mutations so unchanged revisions do not reset the Elements document. Node and byte limits preserve a valid prefix and report truncation; a later source delta protocol can replace the transport without changing the snapshot model or CDP projection.

The object table intentionally keeps every object in the current visible tree strongly reachable until the next replacement or observer disposal. This is bounded by the retained snapshot and must not become a general-purpose object registry.

The Worker retains only serialized metadata for a disconnected snapshot; any still-running source owns its realm-local object registry independently and disposal releases that registry. `maxDisconnectedCordisTrees` bounds Worker snapshot memory, and eviction removes the corresponding retained Client subtree.
