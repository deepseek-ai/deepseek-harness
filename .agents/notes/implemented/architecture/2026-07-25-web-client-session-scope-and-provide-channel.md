# Agent Note: Web client Agent-scope parity model and the provisioning channel (agents/scope / blank reuse / provide)

Status: implemented

English | [中文](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)

> Scope: the client Agent scope (actx) and targeted events, the client/host materialization parity model, the blank-session bit and reuse (`connectWorkspace`), the per-session provisioning channel (`sessions.provide`), and the host wire smalls that carry these capabilities (the summary `blank` column, the `host/session-added` frame field, and the `host/commands-changed` frame). The input state machine and the slash pipeline live in the [input machine note](2026-07-25-web-input-machine-and-slash-pipeline.md); the command business surfaces live in the [command surfaces note](2026-07-25-web-command-surfaces-and-assembly.md).

## Problem

The web client had a single global session surface: slots all rendered from the root context, so plugins had no notion of "which agent/session is current"; the draft's true copy was buried inside the Session object, leaving any plugin that wanted to participate in input with nowhere to hook in. To support a command/input system, the platform layer first had to answer:

- Who owns session interaction state (menus, popups, drafts, in-flight requests), and how two sessions are structurally isolated;
- What a "new session" is before the host entity exists — whether the client must forge an independent life for it;
- How session-scope components fetch their own session data, instead of props passed down layer by layer;
- What a user-abandoned new session leaves behind on the host side, and who collects it.

Hard constraints: the host is the single source of truth; every registration goes through a `ctx.effect` disposer; the scope mechanism matches the host's Agent scope architecture; model-visible ⟺ already in the session log.

## Decision

### The parity model: client and host share one root state axis

Host-side `session.create(workspaceId)` produces Session + Agent + cwd in one piece (an atomic bundle, never split); the client side is the mirror of that birth — the instant a session row enters the list mirror, the client mints its Agent scope (actx + provide + the full input surface mounted):

- Session identity is the host's true form from birth: the sessionId arrives via the `session.create` response / the `host/session-added` frame, and every client-side address (the scope tag, slot store keys, RPC addressing) uses that same id.
- The materialization moment = the instant the user picks a Workspace (cwd settled): the client calls `session.create({workspaceId})` on the spot and receives the complete entity.
- "New Session with no workspace picked" is a **pure view state** (a navigation position) corresponding to no session/scope entity; until the pick, the composer is locked whole (no slash, no plain text).
- A "blank session" is just an ordinary materialized session whose log is still empty; to every Agent-scope plugin on the host (goal/plan/skill/…) it is indistinguishable from any session, so slash/plan are all naturally live.

### Agent scope: the actx is the sole session carrier in the client-side cordis world

The runtime's `agents/scope.ts` matches the host's `dsh-scope` at the mechanism layer (fiber + tag + filter; no value import: the host package carries the scoped-events `Events` merge, which would collide with the Context merge inside the client program):

- `createScope(ctx, key)`: a no-op plugin fiber plus `extend({[kScope]: key, [Context.filter]: …})` — the filter lives directly on the actx: untagged listeners receive globally, tagged ones receive only their own scope.
- Dispatch is the cordis primitives with thisArg = the actx itself: `actx.bail(actx, event, req)` / `actx.emit(actx, event, payload)`.
- `Session.bindScope(actx)`: paired exactly once when resolve mints the scope (rebinding throws; dropScope unbinds), mirroring the host's `Agent.loopCtx` — the Session uses it to dispatch its own scoped events. The reverse actx→Session direction is one hop through `sessions.sessionOf(actx)` (mirroring host plugins' `agent.session` usage).

Three deliberate divergences from the host dsh-scope:

- The filter lives on the actx itself rather than a separate carrier: the host wrapper layer guards the business Agent subject against drifting from the scope key (host events inject the Agent itself as the first argument), while client event payloads carry only an id — there is no subject to protect.
- Keys compare by branded `SessionId` value rather than object identity: on the host, agent.id === session id (1:1 on the same axis), agent identity directly reuses the `SessionId` brand, and a client scope's identity is its wire id.
- The client scope is an **Agent identity** scope, not a live-object scope: during a cold session the host Agent object is already disposed while the client actx stays alive (in view) — the identity axis is in strict parity while object hot/cold is deliberately unsynchronized.

id→ctx handoff is allowed in only three kinds of places (business providers never hand off):

- Slot inject factories: the ctx never enters the render layer; the identity the slot framework hands a component is the sessionId, exchanged back into objects/controllers through service maps.
- Root coordination services self-addressing: from a projection's sessionId back to the actx via `sessions.scope(id)`.
- Root untagged listeners: looking up their own store by the payload's sessionId.

### Scope lifecycle: anchored to the list mirror — birth is entering view, death is prune

Session instances share the scope's lifecycle; liveness eligibility = host-listed (one criterion, shared by mint and prune):

- Birth = a session row entering client view (the list baseline pull / the local `create()` echo / the `host/session-added` frame); a lazy first resolve mints the scope (resolution is a pure function, render-safe).
- One prune tears down three things together: the Session instance, the scope fiber (cascading through every consumer hung on the actx), and the session-keyed slot store. The staged session (= `list.current`) is the exception: removed while still on stage, it keeps a frozen read-only view, torn down only once the stage moves away.
- Reopening = lazily rebuilding the instance + `open()` pulling history (the host session log is the durable truth).
- Remaining TODO: approval/question frames never enter history and cannot be recovered across a prune (the manager-level pendingBuffers cover only the never-instantiated window).

### The blank bit: the empty session's visible projection, conversion, and reuse

A session "materialized but with no first prompt" is governed by the summary-derived bit `blank` (a derived column, not a header field; SessionHeader stays immutable):

- The host criterion: `session.seq === 0` (zero log events = no user message yet). A live session reads `summarize()` straight from memory; a cold session is always `false` — the JSONL provider's lazy-create contract guarantees a never-appended session never enters `persistence.list()`, so blank never touches disk.
- The wire carries it in two places: the required `SessionSummary.blank` column, and the required `blank` field on the `host/session-added` frame (always true at creation, letting other tabs enter the same blank-session state into their mirrors).
- The client mirror only lowers, never raises (monotonic), flipped from three sources, all reusing existing wire signals:
  - The sender's own tab: the **successful response** to the first `prompt()` flips false (acceptance proves the user/message is already in the host log — this flip is confirmation, not optimism; `onEngaged` synchronously updates the list mirror, converting the current `New Session` row in place to an ordinary title, adding no list row). A rejected first prompt keeps the session blank: aligned with host authority, still shown as `New Session`, keeping its connectWorkspace reuse eligibility while it remains a Workspace member.
  - Other tabs: the `host/session-status (running:true)` frame flips it — a blank session never runs, so the first running necessarily means no longer blank;
  - Reconnect alignment: `session.list`'s summary.blank is authoritative, so a tab that missed frames aligns naturally on its next pull; a stale blank:true can never mark a converted session back to blank.
- List discipline: the store retains every row; the Workspace browser's grouping, flat view, search, and counts share one visible projection — every non-blank session shows, while blank sessions show only the one with `session.id === sessions.current`, its title forced to `New Session`. After a Workspace switch, the old blank entity stays in the mirror but is hidden from the list while the target Workspace's current blank shows; the user-visible surface therefore holds at most one blank row globally.
- The residue ledger takes zero GC: after a refresh, blank sessions come back with the bit intact and are reused on the next same-workspace connect while they remain members, so the ordinary single-tab path keeps at most one per workspace; after a host restart, blanks leave no disk trace and simply evaporate; the extra empty shells from multi-tab races only become non-current hidden rows, digested by later reuse, with no coordination.

### connectWorkspace: the sole entry point of New Session

`workspaces.connectWorkspace(workspaceId): Promise<SessionId>` (owned by WorkspaceRuntime — it holds both the workspace canonical path and the sessions reference):

- The reuse arm: the list mirror is searched for `blank && cwd == workspace.path && sessionIds.includes(id)` — the host's own membership rule, never cwd alone. A cwd match without the account slot (a CLI/TUI session birthed at the host cwd, or a deleted/recreated registration) would open a session no grouping surface can show under this Workspace, so it falls through to the create arm instead (see the [membership reuse fix](../bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md)); a hit returns that id directly, creating nothing.
- The create arm: on a miss, `session.create({workspaceId})` returns the new id.
- An unknown workspaceId fails loud (never silently creating somewhere else).
- The resolution guarantee (one contract for both arms): when the promise resolves, the returned id is already in the list store and `sessions.binding(id)` resolves synchronously — `SessionRuntime.create` projects the list synchronously after RPC success before resolving, so a draft mover can write text into the new scope's machine before open, without waiting for a notifier flush.
- The caller takes the id and does its own `sessions.open`; sending the first prompt is an ordinary `session.prompt` — the session already exists, a failure is an ordinary prompt failure, the draft text is still in the machine, and a retry is simply sending again.
- The global New Session button defaults to `recentWorkspaceId`: first comparing each Workspace's newest Session `updatedAt`, falling back to the Workspace `createdAt` when it has no Sessions, and keeping host order on ties; only with no Workspace at all does it `sessions.clear()` into the no-session view. Create actions inside a Workspace group still hit that Workspace explicitly.
- At startup the runtime subscribes to the first complete baseline: a successfully restored current session is kept in place; otherwise it automatically calls `connectWorkspace(recentWorkspaceId)` and opens the returned blank session. The policy settles only once; a later user-initiated clear is never overridden by auto-selection again, and a connect failure waits for the next baseline projection to retry.
- Re-picking the Workspace in the blank Hero also goes through `connectWorkspace`; when the target id differs from the current one, the current input machine's non-empty draft moves to the target scope first, then `sessions.open(nextId)`. The old blank entity is not deleted — it merely leaves the list by no longer being current.

### Per-session provisioning: the `sessions.provide` standard-kit channel

The sole provisioning path by which session slot components fetch their own session data. Plugins declare a fixed key map through the static descriptor `sessions.provide({hooks, props, resolve})` (a duplicate key throws at registration); `resolve(binding)` materializes values for a specific session and tears them down with the scope. ui-renderer's `standardKit` single loop binds the hooks compartment into `use<Name>` selector hooks (`observableHook`→uSES, anti-tearing) and passes the props compartment through as-is.

Slot scope is the closed set `root | session-maybe | session`:

- `root` receives only the global standard kit, with no session identity or provisioning.
- `session-maybe` follows the current session with ADOPTION identity (the only behavior — there is no hold-identity-forever mode): an incarnation born session-less keeps its React instance across the arrival of the FIRST session (the blank shell adopts it — no remount, the DOM survives), and from then on behaves exactly like a strict session entry — switching to a different session remounts, and dropping back to no-session remounts into a fresh blank incarnation that will adopt again. Component-local per-session state therefore clears by construction; state that must survive a switch belongs in session-bound sources (machine, store, hooks). With no session, `sessionId`, the results of `useSession`/`useInput`, and `inputActions` may all be absent. The unkeyed root `SessionMaybeProvider` drives these updates by subscribing to the runtime's atomic `currentProvide` projection — selection moves and provider-roster changes publish through the same source, so a roster change under a stable current id republishes the mounted bundle instead of stranding entries on an obsolete hook/prop schema — while `SessionMaybeProvideInfo` uses the static key map to retain the complete hook/prop shape even with no session; the per-entry adoption bookkeeping (incarnation-counter key) lives in the renderer's `SessionMaybeEntry`.
- `session` guarantees that `sessionId`, every hook source, and every prop exist; each strict entry's error boundary is keyed by `sessionId`, so switching sessions recreates that entry and its session store.

`conversation` is the resident `session-maybe` shell: `ConversationRoot`, HeroShell, the Workspace picker, the root-owned scrollport and composer stack, and the overlay chain's fallback frame retain their React instances across the no-session → blank-session switch. Two strict entries fill fixed regions without reparenting that tree: `conversation.session.header` carries breadcrumb/tabs/actions above the scrollport, while `conversation.session` carries the view ring and draft mirror inside it; both share the same session-scoped chat store. The composer bar (`conversation.composer.bar`) is itself `session-maybe`: with no session its machine faces and message actions are inert, while the whole dashed card opens the existing Workspace picker by pointer and its read-only textarea does the same through Enter or Space. The same instance — textarea included — goes live when a session appears; the remaining input slots stay strict `session` and dispatch nothing until then. The blank → engaging/active transition never rebuilds the InputBar on a phase flip.

- The runtime's first built-in entry: the `'session'` hook — `useSession` itself rides the same mechanism, no special-casing.
- Concurrent discipline: the render plane reads only from the hooks compartment (uSES consistency guarantee); props-compartment callbacks are used only in event-handler space; descriptor resolution is render-safe (idempotent caching, with prune reaping residue from abandoned renders).
- Third-party components take zero value dependencies; types are a one-line type-only import (declaration merging into `SessionStandardProps` / `SessionMaybeStandardProps`).

### The read-only queue mirror

- Queue semantics: running does not lock input; ordinary messages queue through `session.prompt {mode:'queue'}`, and commands never queue.

### Host wire smalls

- The summary `blank` column and the `host/session-added` frame's `blank` field (see the blank bit above).
- The SSE frame `host/commands-changed` (a pure invalidation signal); the client routes it into the typed events `commands/changed` and `connection/reset` (broadcast after each connection generation is established; wire-derived caches uniformly treat prior state as stale). The commands frame and its typed client event were later replaced by verbatim forwarding of `commands/change` through `ctx.remote.$on` ([forwarded Remote events](2026-08-10-remote-event-delivery.md)); `connection/reset` is unchanged, and the invalidation-not-diffing contract this bullet states still holds.
- `command.list/execute` and `skills/list` are uniformly single-addressed by `sessionId` (a session always has an Agent; `agentFor`'s resume semantics come ready-made); the command-surface narrative lives in the [command surfaces note](2026-07-25-web-command-surfaces-and-assembly.md).
- The `session.create` request shape: workspaceId/cwd as either-or, plus an optional caller-preallocated sessionId (a same-id same-cwd retry is idempotent; a different cwd reports `session-conflict`).

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| A client-local Intent + materialize (published CAS / the pendingPrompt attach transaction / the before-create chain) | The client is forced to simulate the first half-life the host lacks, breeding a pile of state machinery — published CAS, the attach transaction, partial publication |
| Host-reserved IDs (a draft Map) | The host merely acknowledges a number; the state machine stays on the client untouched |
| A host draft Session (a Session without an Agent) | Every host surface that looks up the Agent must fork for drafts; core would need an `attachAgent` API plus late-written header cwd |
| Binding an Agent before cwd (ungrouped) | Overturns the readonly header.cwd "created in" invariant, plus the launch-dir side-effect product trap |
| Passing session context down through React Context | Plugins should hold one mental model across host and client; the scope mechanism is isomorphic to the host dsh-scope |
| A `scopeTarget` carrier + fused dispatcher (mirroring the host `agentEvents`) | The host wrapper layer guards the business Agent subject against drifting from the scope key; client events have no subject to guard — the filter on the actx plus cordis primitives covers every need |
| Sessions not holding a ctx (a cordis-free object layer) | A red line born only so the filtering unit tests avoid importing cordis, at the cost of two-hop contribute callbacks plus mutable public fields; the host Agent already holds loopCtx |
| Resident Session instances (resident-instance) | The host session log is the durable truth; residency is mere identity convenience, and its misalignment with the scope lifecycle is a source of complexity |
| Components receiving wiring-callback bundles (two-layer inject→props pass-down) | The standard-kit channel lets components fetch their own; the public API converges to hooks + stable props |
| Swapping the no-session Hero view for the entire session Conversation | Even with the outer layout unchanged, the Hero, picker, and composer subtrees would remount together, making the whole UI region jump |
| Making InputBar itself `session-maybe` | The input state machine, keyboard command surface, and actions would all have to accept absent values; replacing only the disabled input body keeps optionality at the shell boundary |
| A dedicated conversion frame | `session-status(running:true)` semantically implies conversion (a blank session never runs); adding a frame buys zero information for one more wire type |

## Consequences

- Plugins gain session context isomorphic to the host's: per-session state hangs on the actx and mounts/tears down in one piece with the scope fiber, making leaks structurally impossible; two-session isolation is structurally guaranteed by the scope filter.
- The client object layer converges to a wire mirror: session identity, lifecycle, and capability adjudication all defer to the host entity — the input system (the next layer) always faces a session with a real Agent, and providers like slash/skill uniformly address by sessionId directly.
- Blank-session governance takes zero dedicated mechanisms: state rides one derived bit, visibility rides the unified list projection (only the current blank shows, as `New Session`), reclamation rides lazy persistence's existing contract (evaporation on restart), and the ordinary ceiling rides same-Workspace reuse.
- The cost: the id→ctx handoff discipline and provide's Concurrent discipline are conventions rather than type-enforced, pinned by review and tests. The single state axis still withholds machine faces until a Session exists; the [resident conversation shell](../../../../packages/client/ui-conversation/README.md) routes activation to the Workspace picker during that interval.
- Known gaps: approval/question recovery across prune (TODO); model selection returns in live-mutation shape (the host `selectModel` trio is ready-made, its client consumer not yet built).
