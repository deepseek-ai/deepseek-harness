# Agent Note: Session projections and command lifecycle logging

Status: proposed

English | [中文](2026-07-27-session-projection-and-command-log.zh.md)

## Problem

Three in-flight web features — todo (#497), goal (#527), and plan mode (#587) — each derive per-session state from the session log and surface it in the browser client, and each invented its own copy of the same machinery:

- **The client core class absorbs every domain.** All three add private fields, fetch choreography, and event switches to the client runtime's `Session` class and project their values through `ConversationSnapshot`. Plan alone adds seven private fields and a three-layer fence (request version, event version, latest-live cache); goal adds a write-revision fence plus a coalesced refetch loop; todo adds a projection field and an event case. A fourth domain means editing the core class a fourth time.
- **Three baseline channels.** Todo rides a `todos` field on the history tail page — computed by `backscanTodos` **inside api-proxy**, business folding living in the carrier; plan adds a dedicated `session.planMode` unary; goal adds `goals.get`. Same problem, three wire shapes.
- **Command results are unrecoverable.** `/goal`, `/plan`, and every other slash command return their outcome only in the `command.execute` RPC response, surfaced as a transient composer notice on the issuing tab. Nothing reaches the session log: a refresh, another tab, resume, or fork loses the record that the command ever ran. The domain *state* changes are durable (goal commits `goal/change` metadata, plan commits `plan/mode`), but the command invocation and its verdict are not.

The underlying gap is architectural: the client has no seam for a plugin to observe session events in a session's scope and keep its own derived state, and the host has no uniform way to hand a client the current value of log-derived state whose history may have been paged out of the client's window.

## Proposal

Four infrastructure pieces, then the domains become pure contributors.

### Whole-value event rule

A state-carrying log event MUST carry the complete post-change state, never a bare delta. All three domains already comply: `todo/write` is a whole-list snapshot, `plan/mode` a whole boolean, `goal/change` metadata a full `GoalSnapshot` (or a whole-value clear tombstone). The rule keeps every domain's transition trivially cheap (the framework drives it per event), keeps values self-describing on the wire, and lets any consumer treat the latest pushed value as final — out-of-order immunity by seq comparison, self-healing because a missed update is corrected by the next one.

### Host projection registry (`dsh-session-projection`, new package)

A light Service Definition package: merge-extensible host-state and client-view type maps, the registry service, and zod validation for persisted state and client values. Capability-seam roles: domain host plugins provide projection units, carriers consume them, and neither knows the other.

What a domain registers is a **state-driven computation unit** — a pure fold plus declarations and an optional client view — never an opaque getter. The framework owns driving it (subscription, watermark, caching, and later checkpointing); the domain owns only the computation. Projections serve every business domain (session title, plan, goal, permission, todos); commands are merely one trigger path and hold no special position in this contract.

```ts ignore-check
export interface SessionProjectionStateMap {} // host fold states
export interface SessionProjectionMap {}      // client-visible whole values

export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S> {
  key: K
  stateSchema: ZodType<S>
  persist?: boolean // host-only units opt in; client-visible units always persist
  /** State for the empty log. */
  init(): S
  /** Pure transition: previous state + one event → next state. The framework drives it; domains hold no subscriptions. */
  apply(state: S, event: SessionEvent): S
  /** Client view; omitted for host-only units. */
  wire?: K extends keyof SessionProjectionMap ? {
    viewSchema: ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  } : never
  /** State must be plain JSON (persisted-cache precondition); bump to invalidate persisted rows. */
  stateVersion: number
}

declare module 'cordis' {
  interface Context { sessionProjections: SessionProjectionRegistry }
}
```

- `SessionProjectionStateMap` types host fold states; `SessionProjectionMap` remains the one client DTO table shared by the wire block and React hook via `import type`. A unit may remain host-only by omitting `wire`. How a client value is *rendered* is the slot system's business, never the projection layer's. The state/view split is specified by the [implemented state and client-view note](../../archived/architecture/2026-08-19-session-projection-state-and-client-views.md).
- **The host is the only place a projection is computed.** The framework drives every registered unit forward eagerly: each committed session event passes through `apply`; a unit uninterested in an event returns the same state reference, and an unchanged reference (`Object.is`) produces no downstream work. Clients never fold domain events — they receive finished values (baseline block + push frame below). This removes the double-implementation trap (plan's two-event fold written once, on the host) and any client-side domain code.
- **State is always computed, never logged.** The log holds events only; the unit's state lives in the framework's per-session watermark cache (`{state, observedSeq}` per unit) and, in a later phase, in a **persisted projection cache** on the domain-KV storage seam: rows of `(sessionId, key, ver, seq, val)` (`ver` = the unit's `stateVersion`, `seq` = the watermark, `val` = the state JSON). A row is never wrong, only possibly stale — its `seq` says exactly how stale. The one read recipe, cold and live alike: take the cached state (or `init()`), forward-apply only the events past its watermark, `view` the result. Cold listings (every session's title across all workspaces) become an index read plus, at worst, a short tail replay; the session-persistence seam grows a read-from-seq primitive for that tail in the same later phase. Write policy: throttled (count/interval, configurable) plus two mandatory points — `turn/end` and detach (the live-to-cold moment). A crash between writes costs a longer tail replay, never a wrong value.
- A domain's input event set is its own choice: todos folds `todo/write` alone; plan folds `plan/mode` plus its own `/plan` `command/run` records (see the plan section); goal folds `goal/change` metadata; session title folds its title events (retiring the bespoke `session/title` frame and the client's title-snapshot map — the fourth hand-rolled projection this seam absorbs).
- Registration is an effect (disposer with the fiber): an unloaded plugin's key disappears from subsequent responses and the client reads it as capability absence — HMR semantics for free. Duplicate keys throw. Domain plugins register under `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry stay unaffected.
- The package owns `./invariant` (every served key has a live registration).

### Shipped consumer: the subagent identity unit

The registry's two read faces already serve a shipped consumer beyond this RFC's wire plan: [subagent list identity via the projection unit](../../archived/architecture/2026-08-06-subagent-list-identity-projection.md) registers a `subagent` unit — the durable mode/label identity folded last-wins from `subagent/descriptor` — and `SubagentRuntime.listChildren` reads it through `snapshot()` for a live child (the watermark cache, zero log reads) and `restore({}, events, 0)` over one persistence inspection for a cold one. The registry contract is unchanged: no failure channel and no new read face — a unit never throws, an absent value is the signal, and how absence renders is that consumer's decision.

### Wire: projections block on the history tail page

```ts ignore-check
// session.history response, tail page only (beforeSeq absent):
{ events, hasMore,
  projections?: { asOfSeq: number, values: Partial<SessionProjectionMap> } }
```

The api-proxy history handler, after slicing the tail page, synchronously walks the registry — no `await` anywhere, so every key's value and `asOfSeq` form one consistent cut. `asOfSeq` is the **last event's seq** (`session.seq - 1`; `-1` for an empty log, the same vocabulary as `session/subscribed.lastSeq`), so a push frame carrying the first post-baseline change always compares strictly greater. Api-proxy holds zero domain knowledge (the same carrier/contributor relationship as `viewFor` against `ctx.tools`).

No new RPC method. The timing coincidence is exact: every moment the client needs a fresh baseline (open, reconnect resync, gap repair) already pulls the tail page, and the only path that never needs one (loadOlder) is the only path that passes `beforeSeq`. The client therefore has **no** independent "refetch the baseline" decision at all. Window content is never a signal: "no domain event in the window" is unanswerable there by construction, and only the baseline answers it.

Retired by this block: `session.planMode` and `setPlanMode` (both sides — plan selection goes through the standard command channel, see the plan section), `goals.get` (read side; the six mutation RPCs stay, their responses no longer feed state — the mux event arrives anyway), the `todos` rider field, and `backscanTodos` in api-proxy (moves into the todo domain's unit, in `tool-todo`).

### Push frame and the client value store (domains write zero client code)

Because the host is the only computation site, finished values reach clients over one new mux frame:

```ts ignore-check
// MuxFrame union + schema branch:
{ type: 'session/projection', sessionId, key: string, value: unknown, seq: number }
```

The framework emits it whenever a unit's state reference changes (`Object.is` gate above); `seq` is the unit's watermark at emission. This is live push state, never logged — the same posture as the tool-view `view` slot: replay recomputes on the host.

The client object layer keeps one **generic value store** per session: `key → { value, seq }`, seeded by the tail page's projections block and updated by the frame, under the single rule **higher seq wins**. Replayed baselines cannot roll a newer frame back; a lost frame costs staleness until the next frame or baseline, never wrongness. No `fromEvent`, no per-domain cell registration, no client-side domain folding — a domain ships projection support with **zero client code** (the `SessionProjectionMap` merge serves both sides through the `/types` outlet). The bespoke `session/title` frame and the manager's title-snapshot map retire into this generic pair. All the per-domain fences (#587's three layers, #527's write revision) dissolve into the one seq rule.

### Plan through the standard command channel (worked example)

Plan mode demonstrates the full pattern — trigger path, run plane, and replay plane, cleanly separated:

- **Trigger path**: the web plan toggle sends `/plan` / `/plan off` through `command.execute` like any other command; the dedicated `setPlanMode`/`planMode` RPCs are retired. The user's *request* is durably recorded as that command's `command/run { name: 'plan', args: 'off' | '' }` — structured fields, no line parsing.
- **Run plane** (unchanged): the plan-mode service keeps its in-memory pending intent and flushes `plan/mode` at the next turn boundary. On cold start the service rebuilds its intent queue from the replay plane ("empty run state means the replay state").
- **Replay plane**: plan's projection unit folds **two** event types — its own `command/run` records set `wanted`; `plan/mode` sets `active` and clears `wanted`; `view` derives `{ active, pending: wanted !== null && wanted !== active }`. Pending is thereby a pure replay quantity: host restarts recover it, other tabs fold the same events (cross-tab pending for free), and a cold read answering `{ active: false, pending: true }` is accurate ("an unfulfilled selection awaits resume").

A domain's input event set is its own choice — that is the general rule this example instantiates. Whether "the user asked for X" appears in a projection (plan folds its command records) or only in the flow (the command node renders anyway) is per-domain semantics, never a framework concern.

### React: `useProjection`, the fifth framework hook seat

The existing four seats cannot host this state (store discipline bans business objects; inject bans hooks; `ConversationSnapshot` is being evacuated). `useProjection` becomes a framework seat, minted in ui-renderer (the one hook constructor), delivered through the same standard-kit channel as `useSession` (`provideInfo` → SessionProvider → props):

```ts ignore-check
type UseProjection = {
  <K extends keyof SessionProjectionMap>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap, S>(
    key: K, selector: (v: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean): S
}
```

`undefined` uniformly means capability absent (host plugin unmounted, or no baseline/frame has carried the key). The value store exposes bare per-key `{subscribe, getSnapshot}` faces; `bindSnapshotSelector` with per-key caching does the rest — reference stability holds because a key's value reference changes only when a frame or baseline lands. Write paths are unchanged: mutation callbacks stay in the inject share (callbacks out of inject, live state out of `useProjection`).

The one existing violation of "no hooks through inject" — `DetailsInjected.useSelection` — is folded in with this change: selection is viewing state living in the chat store, so the details registration declares the shared store handle and the component reads `props.useStore(s => s.selection)`; `useSelection` leaves the inject contract.

### Command lifecycle in the log

Two log-only (non-surface, model-invisible) events, mirroring the `tool/call`/`tool/result` pairing:

```ts ignore-check
'command/run':  { commandId: string; name: string; args?: string; source: CommandSource }
'command/done': { commandId: string; kind: 'success' | 'error'; text?: string }
```

The host command executor (`packages/interaction/commands`) appends `command/run` before invoking the handler and `command/done` at settlement — direct standalone appends on the receiving agent's session, in the same shape as every other plugin-owned log-only event after the [synthetic-turn removal](../../implemented/simplification/2026-07-28-remove-synthetic-log-only-turns.md): no turn wraps them (turns describe model-loop executions only), persistence drains them at ordinary checkpoints, and the commands package's own invariant companion enforces the run/done pairing. The payload is structured — `name` and, by default, `args` are the parser's own split (`parseCommand`'s name and rawInput), so a consumer (a projection unit folding its own command records, a rich command card) never re-parses a line. A definition sets `recordInput: false` when its authoritative domain event owns the payload; `command/run` then omits `args` rather than duplicating it. `text` is the handler's verbatim outcome — factual data of the same nature as `tool/result.content`, not presentation (how it is laid out remains client-computed at render time, satisfying the "presentation never enters the log" red line). Domains that want the model to know the outcome keep their existing behavior (plan's narration, goal's inject) — that is a domain decision, unchanged.

Because committed events broadcast on the mux stream, refresh persistence, multi-tab sync, and fork/resume recovery all come for free. The `command.execute` RPC degrades to admission — `{ matched, commandId? }`: whether the line resolved, and the minted pairing id when it did, so the issuing client can correlate its request with the flow node the lifecycle events produce. The one-shot notice channel (`runDetached` → `noticeFor`) is retired.

The client flow builder gains one generic command node (run/done paired by `commandId`; cross-window cuts soft-fall like tool pairs). Rendering goes through a new keyed slot `'conversation.chat.commandview'`, key = command name, **fallback = a generic command card** (zero registration required — the former notice text now renders durably in the flow). A domain upgrades by registering one row component, drawing on `command/run`'s structured fields and its own projection value (`useProjection`) — the same shape as tool rows after the toolview dissolution.

## Delivery plan

Infrastructure first; the three in-flight PRs are left untouched and re-target after the base lands (their migration mapping is the guide):

1. **Host base**: `dsh-session-projection` (unit contract, eager drive, watermark cache) + api-proxy projections block + the `session/projection` push frame. Mergeable with zero domains registered (block and frames simply absent).
2. **Client base**: the generic value store + `useProjection` seat; retire the per-domain cell machinery and, with title's unit registered, the `session/title` frame and title-snapshot map. Depends on 1 for the frame shape (fixtures feed synthetic frames meanwhile).
3. **Command channel**: the two events, executor logging, generic node + keyed slot, notice retirement, `{matched, commandId?}` admission. Parallel with 1.
4. **Domain re-targets** (after 1+2): todo (unit in `tool-todo`, drop the rider field), then plan (two-event unit, RPCs retired, toggle → `/plan`), then goal (`goal/change` unit, drop `goals.get`, move the six `Session` methods into the domain plugin's inject).
5. **Persisted projection cache** (later phase, after the domain-KV storage seam): the `(sessionId, key, ver, seq, val)` rows, throttled writes with turn/end + detach mandatory points, and the persistence read-from-seq primitive for cold tail replay.

## Alternatives considered

**A dedicated `session.projections` RPC** — rejected: baseline-refresh moments coincide exactly with tail-page pulls, so a separate unary buys a second round-trip, a second seq to reconcile, and a client-side "when to refetch" decision that the rider design deletes outright.

**An opaque `get(agent)` provider contract** — rejected: with the computation model hidden inside the domain, the framework can never checkpoint the state, serve cold sessions (no agent, no loaded log — `get` has nothing to run against), or resume from a mid-log position. Registering the `(init, apply, view)` unit hands the framework the drive and keeps the domain to pure mathematics; a domain with host-side behavioral needs still keeps its own service subscriptions independently of the projection unit.

**A live-only overlay hook (`live?(agent, base)`) for plan's pending intent** — rejected: it existed solely because the user's plan *selection* was not in the log. Routing the selection through the standard command channel puts `command/run` on the account, pending becomes a pure replay quantity, and the projection remains a pure fold with an optional client view.

**Naming the registration API `registerFold`** — superseded by the unit contract: the registered object now genuinely is a fold, but `fold*` in this repo names pure `(events) => state` helper functions while this registry accepts a keyed, schema'd, versioned unit. Projection remains the event-sourcing term for the read-model role, and both #587's note title and #497's comments already use it.

**Client-side folding (per-domain projection cells with a `fromEvent`)** — rejected: once plan's unit folds two event types, a client cell must duplicate the host's transition logic in the browser — the same fold written twice, evolving separately. Pushing finished values (the title-frame precedent, generalized) keeps one computation site and reduces the client to a generic seq-guarded value store; domains write zero client code.

**Bounded reverse scan over the log tail (absorber declarations).** Rejected: no implementation supports it, it serves only domains whose every event carries the full folded state, and the persisted projection cache covers the same cold-read need uniformly (cache row plus forward tail replay — the same recipe as the client's baseline and catch-up, and as paged loading). Revisit only if a real cold-read path emerges that checkpointing cannot serve.

**An `invalidate`-style cell (mark dirty, refetch on domain events)** — rejected: it exists only to serve delta events. The whole-value rule makes every domain last-wins; goal's refetch loop, its coalescing, and its stale-read fence all disappear.

**Hanging the registry off `ctx.apiProxy`** — rejected: session projections are not web-specific (TUI, ACP, headless are future consumers), and domain packages must not depend on the apiproxy package. The independent seam also deletes #587's type-only import edge from api-proxy into the plan package.

**A second client DTO table** — rejected: `SessionProjectionMap` remains the single client vocabulary shared by wire and UI. `SessionProjectionStateMap` is not another client view table; it types host fold state so internal state may differ from the value sent to clients.

**Event-broadcast collection instead of a registry walk** — rejected: async listeners cannot yield the single synchronous cut that makes `asOfSeq` one consistent snapshot across all keys; registries are this repo's shape for contributions (`ctx.tools`, prompt sections, slots).

**A dedicated `plan/select` selection event (structured domain event instead of folding command records)** — rejected in favor of the command channel: `command/run`'s structured `{name, args}` already records the selection, the `/plan` grammar and its fold live in the same plugin (domain-internal coupling, not cross-domain), and one less event type. The handler must call `set()` before any failable path so the logged request and the run plane cannot diverge — a domain-internal ordering constraint, documented at the handler.

**Keeping `setPlanMode` as a dedicated RPC** — rejected: plan selection is a user command like any other; the command channel gives it durable recording, flow rendering, multi-tab visibility, and admission semantics without a bespoke wire method. Web UI affordances (a toggle) compose the command line internally.

**Making mutation RPC responses feed cell state** — rejected: the committed mux event arrives immediately and carries the same whole value with a seq; responses feeding state is what required #527's write-revision fence.

## Acceptance criteria

- A domain plugin ships per-session log-derived state to React by writing only: the whole-value event declaration, one host unit `register`, its `SessionProjectionMap` merge, and inject callbacks — zero client-side code, no edits to the client `Session` class, `ConversationSnapshot`, api-proxy, or the wire schema files.
- The history tail page carries `projections` with `asOfSeq` equal to the window tail seq; loadOlder pages never carry it; a deployment without the registry serves histories without the block and clients treat every key as absent.
- A stale baseline cannot overwrite a newer `session/projection` frame, and a replayed frame cannot regress the value store (higher-seq-wins tests on both paths).
- A slash command executed on one tab renders a durable node in the flow on refresh, on a second tab, and after resume; unregistered commands render the generic card; the composer notice path for command outcomes is gone.
- `useProjection` reaches components through the standard props kit; no hook crosses an inject contract (including `useSelection`).
- Session titles ride the generic pair (baseline block + projection frame); the bespoke `session/title` frame and the client title-snapshot map are gone.

## Risks

- **Whole-value rule is load-bearing**: a future domain logging bare deltas cannot serve consumers from its latest event and complicates its own unit. Mitigation: the rule is stated here and in the projection package README; the unit contract makes the full state explicit at every transition.
- **Synchronous unit discipline**: `init`/`apply`/`view` that await would tear the consistency cut. The registry documents and the invariant companion asserts synchronicity as far as practical; review owns the rest.
- **Live registry churn is not pushed**: loading or unloading a domain plugin mid-session changes the key set, but no session event fires and no frame is pushed; open clients hold the stale key until the next tail pull (reconnect, gap repair, open). Accepted as a dev-only (HMR) staleness window — a registry-change push can be added to the change feed later without contract impact.
- **Eager drive costs on busy sessions**: every committed event passes every registered unit's `apply`. Units are cheap per-event by construction (whole-value rule), non-matching events return the same reference, and the count of registered domains is small; if a hot path ever shows, per-unit event-type prefilters can be added without contract change.
- **Projection payload growth**: every tail page carries every registered key. Payloads are whole values of UI-scale state (a todo list, a goal snapshot); if a future domain's value is large, per-key opt-out or lazy keys can be added to the request without changing the model.
- **Command log volume**: two log-only events per slash command; bounded by human command frequency, negligible against chunk volume.
- **Re-target churn**: three open PRs rebase onto a moved foundation. Accepted cost of infrastructure-first.
