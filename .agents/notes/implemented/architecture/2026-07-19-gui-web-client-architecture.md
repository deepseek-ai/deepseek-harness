# Agent Note: Web client architecture — the client cordis plugin tree, the slot system, and the React-free object layer

Status: implemented

English | [中文](2026-07-19-gui-web-client-architecture.zh.md)

> Division of labor: the historical channel-independent layering model and RPC protocol are recorded in the [archived layering and RPC protocol note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md); this document = the browser side: how the client cordis tree loads, how UI plugins compose through slots and services, and how the React-free object layer feeds React through immutable snapshots.

## Problem

Two forces shape the browser client. First, streaming: in an event-driven conversation UI, if business state (the event window, streaming accumulation, pending interactions, the connection state machine) scatters across React components and a global store, every token chunk shakes the render tree, and swapping the UI library means rewriting the business logic. Second, modularity: UI features (layout, sidebar, conversation, theme, locale) must be independently loadable plugins — composed at runtime from a host-served manifest, not compiled into one bundle — without giving up compile-time type safety across plugin boundaries.

## Decision

Both ends run cordis. The host is a cordis plugin tree; the browser runs a second, client-side cordis tree whose every UI capability is a plugin loaded dynamically by a shell-held loader. Inside that tree, cordis ctx hosts all runtime facts (services, stores, session scopes) and React is pure projection: components import nothing from the framework, receive everything through props, and subscribe to immutable snapshots via `useSyncExternalStore` (uSES below).

```
┌─ Host ─────────────────────────┐   ┌─ Browser ─────────────────────────────────────────┐
│ sessions/agents/SessionLog     │   │ client cordis root ctx                             │
│ Connection + Gateway: RPC/events│◀─▶│  ├ vendored Loader + ctx.modules（内核，壳静态持有）│
│ webserver:                     │   │  ├ immediately entries: connection/runtime/        │
│  ├ GET /plugins/<id>/client.js │   │  │   ui-theme/i18n（fetch bundle，boot 预拉）       │
│  └ GET / 注入 __DSH_BOOT__ 图  │   │  ├ lazy entries: layout/sidebar/                   │
│                                │   │  │   conversation/trajectory（fetch bundle，按需） │
└────────────────────────────────┘   │  ├ ui-renderer（fetch bundle，React 根）       │
                                     │  └ session scope ×N（观看驱动，惰性建）            │
                                     │ DOM loading 页 → settled → React UI 一次成型       │
                                     └────────────────────────────────────────────────────┘
```

## The client cordis tree and the loading chain

The loading chain — the two package kinds (plain vs dsh.client plugin), the module-system/plugin-governor split, the two-phase boot over the host-authored entry graph with revisions, and hot reload — is owned by the [client plugin loading note](2026-07-23-client-plugin-loading-model.md). The load-bearing facts for this document: the browser boots the same vendored `@cordisjs/plugin-loader` as the host with a client module system (`ctx.modules`, `packages/client/modules`) filling its `internal` contract; every unit with product behavior is an entry in the host-authored `__DSH_BOOT__` graph — every production plugin package (infrastructure included) carries the `dsh.client` declaration and arrives as a fetched `./client` tsdown closure bundle, `immediately` rows differing only in boot phase-one prefetch, while plain packages (react family, cordis, the not-yet-promoted libraries) stay shell-bundled, seeded, and invisible to the graph; bundles execute `window.__ModuleLoader__.load({ id, factory })` and their `require` is answered from the lazy CJS module table (seed words + registered factories, materialized and memoized on first require — cross-plugin value imports are a build error, cooperation goes through cordis services); global styles and CSS Modules are inlined in their owning plugin bundle and injected as `<style data-plugin="<id>">` at materialization (CSS Modules also receive hashed names; ownership tags make reload removal possible); hot reload is live in dev graphs — the webserver stat-polls the bundles it serves and broadcasts `rebuilt` SSE frames, and the `client-hmr` plugin swaps one fiber per frame. After `loader.await()` and an all-ACTIVE sweep, the framework-free kernel calls the dynamic UI renderer's `ctx.uiRenderer.mount(container)` once — every entry is created and every fiber reached ACTIVE, with FAILED/PENDING fibers listed loud; there is no partial-availability mode (progressive rendering is deferred work).

Type universes stay split at the aggregate level — `tsconfig.host.json` is the host program and `tsconfig.client.json` the client program, both referenced by the solution root `tsconfig.json` — because both sides merge cordis `Context` under the same keys (`sessions`, `loader`) with different services; client packages consume the wire vocabulary through pure type subpaths (`@deepseek-ai/dsh-session/types` and kin) so no host augmentation rides into the client program.

## The slot system: how the page composes

The slot system has its own note — the [slot system standard](2026-07-22-slot-type-chain-implementation.md) — and this document defers to it entirely. The one-paragraph summary for orientation: ui-renderer renders only `'root'`; a plugin composes UI through a single `register` call that occupies a slot, declares+authorizes its child slots (`children` spec object), declares its store, and injects its business face; component props arrive in four auto-derived shares (`PropsRuntime<K>` / `PropsRenderSlots<S>` / `PropsStore<H>` / inject), each from its single source of truth. `SlotMap` declaration merging is the type authority and entries carry only the owner share ("whoever injects it, owns its type"); every rendered entry sits in a per-entry error boundary.

Implementation homes: registry core and the props-share types live in `packages/client/ui-slots`; the outlet renderer, uSES bridge, application-level installation, and root mounting live in `packages/client/ui-renderer`.

## Services and scope addressing

A service is a plugin's only API toward other plugins (UI components and injection faces are not APIs; a plugin nobody calls mounts no service — ui-trajectory is the minimal-plugin exemplar: no ctx service, only view-slot registrations). The roster: `ctx.connection` (RPC transport + generation state), `ctx.slots` (registry wrapper emitting `slots/changed`, render entry, renderer installation contract), `ctx.sessions` (list store, current-session state, scope tree), `ctx.loader`, `ctx.theme`, `ctx.i18n`, `ctx.layout` (cross-plugin view navigation), `ctx.conversation` (send/cancel/startSession). Viewing state that used to live in service stores (panel widths, selection, drafts) now lives in entry-declared stores per the [slot system standard](2026-07-22-slot-type-chain-implementation.md).

There is no component registration model besides slots — the former view and tool rings both dissolved into it. Conversation views are entries of the `'conversation.view'` list slot ui-conversation declares, tab metadata rides the registration options (`id`/`order`/`label`), and per-view chrome lives inside the view components themselves. Final Chat business Nodes dispatch through the keyed/session `'conversation.chat.node'` slot; ui-tool owns its `tool-call` entry, recursively renders the supplied `subCalls`, and declares the keyed/session `'tool.call.toolview'` child slot. The key space stays runtime-open (SlotMap declares slots, never keys), and roots and descendants dispatch by `entryKey: toolName` with `GenericToolCard` as the fallback. Business packages register atomic views through `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: '<tool>' }, Row))`; the declaration is the load and reload dependency ([decision](../../archived/architecture/2026-08-05-slot-declaration-injection.md)). The right column is the `rightbar` seat ui-sidebar-right fills with one docking surface per session; the former details column and its `'conversation.details.tool'` seat are gone ([decision](../feature/2026-09-04-right-sidebar-docking-infrastructure.md)). The target-neutral event and view registries are data assembly seams rather than parallel component registries ([decision](2026-08-09-client-conversation-node-assembly.md)).

**Scope addressing** mirrors the host's agent-scope idiom: services are root singletons whose methods take no sessionId — they read the caller's scope mark (`scopeOf(ctx)`). Inside a session scope, `ctx.conversation.send('hi', 'queue')` targets that session; cross-session calls re-target by switching ctx (`ctx.sessions.scope(id)!.conversation.send(...)`); calling a scoped method from root ctx throws. Client session scopes are minted like host agent scopes (a no-op plugin fiber + a scope-key extend), built lazily on first viewing and torn down only when the session is removed and unwatched — host-session death alone does not tear a scope (it freezes into a read-only viewport).

## The data object layer (`packages/api/session-controller/src/client/`)

Frames enter, snapshots exit, the Conversation assembler sits between — React-free (zero React imports, grep-assertable):

```
$events frames (ConnectionController pump, injected sinks)
        │
        ▼
SessionManager.handleMuxEnvelope / handleHostEnvelope
        │ session frames target existing instances (requested waits buffer)
        ▼
Session.handleMuxEnvelope ──► contiguous Event window
        │                        │ replace / prepend / append
        │                        ▼
        │                ConversationNodeAssembler
        │                  Definitions -> Contexts -> view builders
        ▼
Notifier 微任务合批 ──► ConversationSnapshot 缓存 ──uSES──► 组件
```

- **Session** (session.ts): lazily built, resident — once created it keeps eating frames in the background, so switching away and back renders instantly. Operations: `prompt`/`cancel` (RPC passthrough; failures land in the snapshot's `promptError`), `open` (pull the tail history page, idempotent), `loadOlder` (upward paging, reentry-guarded), `resync` (reconnect = clear the window and rerun open). Subscription: `subscribe`/`getSnapshot` (always the cached reference) — `implements ObservableSnapshot<ConversationSnapshot>`, with `useSelector = bindSnapshotSelector(this)` attached at construction, so a Session is directly a uSES source. Frame dispatch is one switch: `session/event` frames dedup by seq (the only dedup key), buffer while open is in flight, otherwise append + incremental projection; open/stitch merges the live buffer by seq and backfills once if `subscribed.lastSeq` outruns the window tail.
- **ConversationSnapshot** (conversation.ts): the top-level immutable snapshot contract. `chat` contains structural `order`, an identity-stable keyed Node reader, Turn/Step indexes, and the timeline; `nodes`, `partial`, `runningCalls`, `turnTimings`, and `turnEnds` are the compatibility slice for unmigrated Trajectory consumers. Pending interactions, queue, running, removal, open state, paging, and prompt errors remain Session facts. **Reference discipline** (the premise of memo and uSES): unchanged substructures and Node values keep their references; one business update replaces only the corresponding key's value unless its order or Location changes. React still subscribes to the Session as the sole observable source, while the framework-provided `useSession(selector)` isolates Node and Location aggregate updates.
- **SessionManager** (manager.ts): instance cluster + frame entry + the session list. sessionId-bearing frames go only to existing instances (a mux broadcast must not instantiate every session); approval/question `requested` frames are the exception — they never land in history, so they buffer in `pendingBuffers` and replay on instantiation.
- **Notifier** (notifier.ts): two channels chosen by change source. `markDirty()` (default; frame-driven changes always) batches per microtask — N changes, one notification, one re-render; the flush rebuilds the snapshot cache before notifying. `notifyNow()` (only direct echoes of user gestures) rebuilds and notifies in the same tick — controlled inputs roll the DOM back and jump the caret if their echo defers to a microtask. Frame-driven code using notifyNow collapses batching back to per-frame renders; banned.
- **ConversationNodeAssembler** (`runtime/src/client/conversation/`): the Session-owned incremental engine runs independently registered Definitions over raw events. `match(event)` selects `(kind, id)` without Context scans; start/update build Definition state; engine-computed Locations carry Turn/Step closure; backward Context reads record dependencies repaired by later prepends; `buildViewNode(target)` materializes only dirty Contexts. The Chat builder preserves structural order and per-key value identity, `useSession` selectors isolate consumption, and Assistant token publication coalesces to one animation frame. The [Conversation Node decision](2026-08-09-client-conversation-node-assembly.md) owns assembly, while [Tool presentation ownership](../../archived/architecture/2026-08-08-client-tool-presentation-ownership.md) owns recursive Tool rendering.
- **ConnectionController** (in `packages/client/connection`): opens the `$events` Remote stream, pumps with for-await, and reconnects with exponential backoff (500ms doubling to 10s, jitter, unlimited) behind a generation fence; sinks are injected one-way (the Controller does not know Session). Reconnect = rebuild: `onConnected` → list refresh + per-open-session resync. The object layer calls generated namespaces through `ctx.remote`; Web carriage uses HTTP POST for unary Remote calls and API Gateway's WebSocket mux for logical streams, while Connection owns request transport and generations.

## The React face (`packages/client/ui-renderer`)

The dynamic ui-renderer plugin owns the ctx↔React adapter, application-level installation, root mount, and title projection. Business components receive bound hooks through slot props and do not value-import the renderer.

- The snapshot store engine **lives in the runtime package** (zustand vanilla with draft-based updates, `flush: 'sync'` by default with opt-in `'raf'` batching, opt-in whole-value localStorage persistence, dev-mode deep freeze — all exported from `runtime`'s `./client` main entry, no subpath): store products are bare observable sources with no hook members. Plugins reach the engine only through `defineStore` declarations per the [slot system standard](2026-07-22-slot-type-chain-implementation.md). ui-renderer composes every hook at the binding site (`bindSnapshotSelector`, per-source cached) from the one data contract React consumes: `ObservableSnapshot<T>` (`getSnapshot`/`subscribe`) — a Session object and a snapshot store both satisfy it.
- `bindSnapshotSelector(source)`: binds a source into a typed selector hook over uSES-with-selector. The four uSES contract clauses hold by construction: getSnapshot returns the cached reference; subscribe is a bind-time closure (reference-stable forever); pure CSR passes no server snapshot; equality defaults to `Object.is` with `shallowEqual` opt-in per call.
- Equality protocol, whole chain: producers use structural sharing; consumers short-circuit with `Object.is` or `shallowEqual`; `React.memo` shallow. Deep comparison is banned everywhere.

## Directory shape

Client packages live under `packages/client/*`, with `apps/web` as the thin Vite application over the shell's boot export. Plugin packages keep their browser half under `src/client/`; **every build artifact lands in `lib/`** — the node half as `lib/index.js`/`lib/invariant.js`, the browser bundle as `lib/client.js` (the shared tsdown client preset emits both; there is no `dist/` directory, and `exports["./client"]` points at `./lib/client.js`). `ui-slots`, runtime, and ui-renderer form the infrastructure direction; feature plugins cooperate through services and slots rather than importing presentation implementations.

A multi-domain plugin package additionally splits its client half by future package boundaries — ui-conversation is the exemplar:

```
src/client/
  contract/    shared slot and cross-domain types
  service.ts   cross-domain orchestration
  skeleton/    conversation shell and details host
  conversation-nodes/ independently registered business Definitions and Chat builder
  chat/        ordered conversation view
  input/       composer state machine
  queue/       queued-message presentation
  settings/    conversation settings rows
  apply.ts     cross-domain assembly point
  index.ts     public contract surface
```

Domain implementation files never import a sibling domain; shared surfaces route through `contract/`. `scripts/verify-client-domain-graph.ts` enforces the layering (contract=0, domains=1, apply/index=2; imports may only point at levels ≤ own; sibling-domain edges fail). Tool presentation is already a separate `ui-tool` package and reaches chat and details only through the slots ui-conversation declares.

## How to develop

- **A new UI feature** = a new plugin package: declare `dsh.client` (+ `inject` topology) in package.json, write the browser half under `src/client/` (apply mounts services/stores and registers slots), keep the node half an empty apply unless there is host logic, build with the shared preset. Add the plugin to the host config; the manifest and loading follow automatically.
- **A new slot**: see the [slot system standard note](2026-07-22-slot-type-chain-implementation.md) — merge the contract into `SlotMap`, declare it in the parent entry's `children`, render through the auto-injected `renderSlot` prop. Never export components globally.
- **Consuming a new frame type**: transport-only session frames → Session's dispatch switch; host-level frames → the Manager routing table; logged conversation business events → a Definition plus a keyed view renderer, without a Session business branch.
- **Where does this state live**: business data (events, streaming, pending) → always the object layer; what the parent knows → owner props at the renderSlot site; private to one component (scroll, search text, expansion) → component state; shared across entries or surviving remounts (selection, drafts, panel widths) → an entry-declared store ([slot system standard](2026-07-22-slot-type-chain-implementation.md)).
- **Notification channel**: frame-driven/async = `markDirty` batching; direct user-gesture echo whose controlled input needs the same tick = `notifyNow`.

## Consequences

Token streams no longer shake the render tree: Assistant chunks update one business Context and publish its keyed Node at most once per animation frame; unrelated rows' selector results retain their references, so those rows do not re-render. UI features load, fail, and get disabled as independent plugins — one crashing slot entry blacks out one card, one failed bundle fails loud before the UI flips in. The accepted costs: the loader/module-table machinery is bespoke infrastructure the team owns end to end; the one-flip boot (no progressive rendering) trades first-paint granularity for assembly simplicity; and the dual type programs make "which aggregate sees this file" a question developers occasionally have to answer.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| One statically-linked SPA bundle | Plugins must be host-composable at runtime (config-driven); a monolith re-couples every UI feature to one build |
| window globals / import maps for shared deps | The DI require table keeps sharing explicit, fail-loud, and swappable; globals leak identity and version silently |
| Business data in zustand slices | The event window/accumulator is a behavioral state machine, not a flat slice; the object layer keeps snapshot granularity and batching controllable |
| Parallel string-keyed component registry for Tool rows | ui-tool's keyed child slot carries the runtime-open Tool-name set through the one slot registration model ([toolview dissolution](../../archived/architecture/2026-07-23-toolview-dissolution.md)) |
| Progressive/Suspense boot in the initial web client delivery | One-flip boot is strictly simpler; the loader's per-plugin status face is kept so progressive lighting can land later without re-architecture |
