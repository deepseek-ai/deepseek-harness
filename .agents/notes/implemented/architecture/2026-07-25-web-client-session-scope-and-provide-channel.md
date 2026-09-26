# Agent Note: Web client Agent-scope parity model and the provisioning channel (agents/scope / blank reuse / provide)

Status: implemented

English | [中文](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)

> Scope: the client Agent scope (actx) and targeted events, the client/host materialization parity model, the blank-session bit and reuse (`connectWorkspace`), the per-session provisioning channel (`sessions.provide`), and the host wire smalls that carry these capabilities (the summary `blank` column, the `host/session-added` frame field, and the `host/commands-changed` frame). The input state machine and the slash pipeline live in the [input machine note](../../archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md); the command business surfaces live in the [command surfaces note](../../archived/architecture/2026-07-25-web-command-surfaces-and-assembly.md).

## Problem

The web client had a single global session surface: slots all rendered from the root context, so plugins had no notion of "which agent/session is current"; the draft's true copy was buried inside the Session object, leaving any plugin that wanted to participate in input with nowhere to hook in. To support a command/input system, the platform layer first had to answer:

- Who owns session interaction state (menus, popups, drafts, in-flight requests), and how two sessions are structurally isolated;
- What a "new session" is before the host entity exists — whether the client must forge an independent life for it;
- How session-scope components fetch their own session data, instead of props passed down layer by layer;
- What a user-abandoned new session leaves behind on the host side, and who collects it.

Hard constraints: the host is the single source of truth; every registration goes through a `ctx.effect` disposer; the scope mechanism matches the host's Agent scope architecture; model-visible ⟺ already in the session log.

## Decision

The reference-owned lifetime and Provider targeting now follow [Client Session references](2026-09-15-client-session-references.md). This note retains the blank-Session and adoption rationale and describes their current realization.

### The parity model: client and host share one root state axis

Host-side `session.create(workspaceId)` produces Session + Agent + cwd in one piece (an atomic bundle, never split); the client side is the mirror of that birth — the instant a session row enters the list mirror, the client mints its Agent scope (actx + provide + the full input surface mounted):

- Session identity is the host's true form from birth: the sessionId arrives via the `session.create` response / the `host/session-added` frame, and every client-side address (the scope tag, slot store keys, RPC addressing) uses that same id.
- A manual Workspace pick or successful [first-use startup initialization](../feature/2026-09-20-default-workspace.md) establishes cwd before the client calls `session.create({workspaceId})` and receives the complete entity.
- "New Session with no workspace picked" is a **pure view state** (a navigation position) corresponding to no session/scope entity; until the pick, the composer is locked whole (no slash, no plain text).
- A "blank session" is an ordinary materialized session with no turn yet; to Agent-scope plugins on the host (goal/plan/skill/…) it remains an ordinary Session, so slash/plan are naturally live.

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

### Scope lifecycle: anchored to explicit references

Session instances share the scope's lifecycle, while the catalog reports discoverability without retaining a generation:

- Birth = the first explicit `sessions.retain(target, options)`; it synchronously returns a reference and mints the Session binding and scope before history is ready.
- Final release withdraws the exact generation before tearing down its Session instance, scope fiber (cascading through every consumer hung on the actx), and session-keyed slot store. Catalog removal does not end a generation while references remain.
- Reopening = a later retain lazily rebuilding the generation and exposing history readiness through `reference.ready` (the Host Session log is the durable truth).
- Remaining TODO: approval/question frames never enter history and cannot be recovered across a prune (the manager-level pendingBuffers cover only the never-instantiated window).

### The blank bit: the empty session's visible projection, conversion, and reuse

A session "materialized but with no first prompt" is governed by the summary-derived bit `blank` (a derived column, not a header field; SessionHeader stays immutable):

- The Host criterion is absence of `turn/start`: the `sessionListMetadata.blank` projection starts true and only that event clears it, so slash-command, configuration, and creation-checkpoint events leave it true even after they reach disk — blank does not mean unpersisted. Missing metadata falls back to `session.seq === 0` for live Sessions and false for cold ones; cold summaries otherwise read cached metadata, leaving cache misses visible as unknown. Reuse acquires the writer under [blank Session acquisition](2026-09-17-process-local-blank-sessions.md).
- The wire carries it in two places: the required `SessionSummary.blank` column, and the required `blank` field on the `host/session-added` frame (always true at creation, letting other tabs enter the same blank-session state into their mirrors).
- Client display also reflects accepted/running observations, whose retention the [blank rollback decision](../bug-fix/2026-09-15-client-session-blank-reconciliation.md) owns:
  - The sender's own tab: the **successful response** to the first `prompt()` converts the current `New Session` row in place, adding no list row — acceptance is display memory, not proof that a turn or user message reached durable history. A rejected first prompt keeps the session blank: aligned with host authority, still shown as `New Session`, keeping its connectWorkspace reuse eligibility while it remains a Workspace member.
  - Other tabs: the `host/session-status (running:true)` frame converts it — a blank session never runs, so the first running necessarily means no longer blank;
  - Reconnect alignment: a list pull updates Host summaries while the Manager keeps those observations, and a `sessionListMetadata` hint of existing history prevents re-blanking on top of that; an empty-history response cannot mark a converted session back to blank.
- List discipline: the store retains every row; the Workspace browser's grouping, flat view, search, and counts share one visible projection — every non-blank session shows, while blank sessions show only the row retained by the `mainView` source, with its title forced to `New Session`. After a Workspace switch, the old blank entity stays in the mirror but is hidden from the list while the target Workspace's main blank shows; the user-visible surface therefore holds at most one blank row globally.
- Blank Sessions can persist through creation checkpoints and command events, and have no automatic garbage collection: browser reloads, Host restarts, and Workspace connections reuse eligible blanks after acquiring their writer and skip occupied candidates, while list-loading and multi-tab races can still create additional blank Sessions, whose old logs remain on disk.

### connectWorkspace: the sole entry point of New Session

`workspaces.connectWorkspace(workspaceId): Promise<SessionId>` (owned by WorkspaceRuntime — it holds both the workspace canonical path and the sessions reference):

- The reuse arm: the list mirror is searched for `blank && cwd == workspace.path && sessionIds.includes(id)` — the host's own membership rule, never cwd alone. A cwd match without the account slot (a CLI/TUI session birthed at the host cwd, or a deleted/recreated registration) would open a session no grouping surface can show under this Workspace, so it falls through to the create arm instead (see the [membership reuse fix](../../archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md)); a hit is adopted with explicit-id `session.create`, which acquires and retains the writer before returning. Only writer contention skips a candidate.
- The create arm: when no candidate can be acquired, `session.create({workspaceId})` returns the new id.
- An unknown workspaceId fails loud (never silently creating somewhere else).
- The resolution guarantee (one contract for both arms): when the promise resolves, the returned id is already in the list store. The view owner then retains it synchronously, so a draft mover can write text through that binding before history readiness without waiting for a notifier flush.
- The caller takes the id and installs a `mainView` reference; sending the first prompt is an ordinary `session.prompt` — the Session already exists, a failure is an ordinary prompt failure, the draft text is still in the machine, and a retry is simply sending again.
- The global New Session button defaults to `recentWorkspaceId`: first comparing each Workspace's newest Session `updatedAt`, falling back to the Workspace `createdAt` when it has no Sessions, and keeping Host order on ties; only with no Workspace at all does it clear the main-view reference into the no-Session view. Create actions inside a Workspace group still hit that Workspace explicitly.
- At startup the runtime subscribes to the first complete baseline: a successfully restored current session is kept in place; otherwise it automatically calls `connectWorkspace(recentWorkspaceId)` and opens the returned blank session. The policy settles only once; a later user-initiated clear is never overridden by auto-selection again, and a connect failure waits for the next baseline projection to retry.
- Re-picking the Workspace in the blank Hero also goes through `connectWorkspace`; when the target id differs from the main one, `ui-workspace` retains the target, moves the current input machine's non-empty draft through the preparation callback, and then publishes the new main reference. The old blank entity is not deleted — it merely leaves the list when its `mainView` reference is released.

### Per-session provisioning: the `uiSession.provide` standard-kit channel

The sole provisioning path by which Session slot components fetch their own Session data. Plugins declare a fixed key map through the static descriptor `uiSession.provide({hooks, props, resolve})` (a duplicate key throws at registration); `resolve(binding)` materializes values for a specific binding and tears them down with its scope. ui-renderer's `standardKit` single loop binds the hooks compartment into `use<Name>` selector hooks (`observableHook`→uSES, anti-tearing) and passes the props compartment through as-is.

Slot scope is the closed set `root | session-maybe | session`:

- `root` receives only the global standard kit, with no session identity or provisioning.
- `session-maybe` inherits the nearest `SessionProvider` binding with ADOPTION identity: an incarnation born Session-less keeps its React instance when that Provider receives its first binding, then remounts when the Provider switches generation or returns to absence. Component-local per-Session state clears when the Provider switches generation. Across a switch, only persisted Store values survive generation retirement; binding-owned sources survive only when another reference keeps that generation alive. With no binding, `sessionId`, the results of `useSession`/`useInput`, and `inputActions` may all be absent. Provider-roster changes rematerialize the mounted binding without changing its identity, while the per-entry adoption bookkeeping lives in the renderer's `SessionMaybeEntry`.
- `session` guarantees that `sessionId`, every hook source, and every prop exist; each strict entry's error boundary is keyed by `sessionId`, so switching sessions recreates that entry and its session store.

`conversation` is the resident `session-maybe` shell under its owning `SessionProvider`: `ConversationRoot`, HeroShell, the Workspace picker, the scrollport and composer stack, and the overlay chain's fallback frame retain their React instances across the no-Session → blank-Session switch. Two strict entries fill fixed regions without reparenting that tree: `conversation.session.header` carries breadcrumb/tabs/actions above the scrollport, while `conversation.session` carries the view ring and draft mirror inside it; both share the same Session-scoped chat store. The composer bar (`conversation.composer.bar`) is itself `session-maybe`: with no Session its machine faces and message actions are inert, while the whole dashed card opens the existing Workspace picker by pointer and its read-only textarea does the same through Enter or Space. The same instance — textarea included — goes live when a binding appears; the remaining input slots stay strict `session` and dispatch nothing until then. The blank → engaging/active transition never rebuilds the InputBar on a phase flip.

Blank Sessions retain the header's leading and corner slots so navigation controls, including the right-sidebar opener, are available before the first message. Title, actions, utilities, and View tabs remain hidden in the blank phase. The header still requires a selected Session; the Files and Terminal entries use that Session's workspace and execution services without requiring a recorded Turn.

- The runtime's first built-in entry: the `'session'` hook — `useSession` itself rides the same mechanism, no special-casing.
- Concurrent discipline: the render plane reads only from the hooks compartment (uSES consistency guarantee); props-compartment callbacks are used only in event-handler space; descriptor resolution is render-safe (idempotent caching, with prune reaping residue from abandoned renders).
- Third-party components take zero value dependencies; types are a one-line type-only import (declaration merging into `SessionStandardProps` / `SessionMaybeStandardProps`).

### Input delivery

- Queue semantics: running does not lock input; ordinary messages queue through `session.prompt {mode:'queue'}`, and commands never queue.

### Host wire smalls

- The summary `blank` column and the `host/session-added` frame's `blank` field (see the blank bit above).
- The SSE frame `host/commands-changed` (a pure invalidation signal); the client routes it into the typed events `commands/changed` and `connection/reset` (broadcast after each connection generation is established; wire-derived caches uniformly treat prior state as stale). The commands frame and its typed client event were later replaced by verbatim forwarding of `commands/change` through `ctx.remote.$on` ([forwarded Remote events](2026-08-10-remote-event-delivery.md)); `connection/reset` is unchanged, and the invalidation-not-diffing contract this bullet states still holds.
- `command.list/execute` and `skills/list` are uniformly single-addressed by `sessionId` (a session always has an Agent; `agentFor`'s resume semantics come ready-made); the command-surface narrative lives in the [command surfaces note](../../archived/architecture/2026-07-25-web-command-surfaces-and-assembly.md).
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
| A dedicated conversion frame | Existing acceptance and running signals provide the observations used by the display rule; a new frame is unnecessary for that rule |

## Consequences

- Plugins gain session context isomorphic to the host's: per-session state hangs on the actx and mounts/tears down in one piece with the scope fiber, making leaks structurally impossible; two-session isolation is structurally guaranteed by the scope filter.
- The client object layer converges to a wire mirror: session identity, lifecycle, and capability adjudication all defer to the host entity — the input system (the next layer) always faces a session with a real Agent, and providers like slash/skill uniformly address by sessionId directly.
- Blank-session governance takes zero dedicated mechanisms: state rides one derived bit, visibility rides the unified list projection (only the current blank shows, as `New Session`), reuse acquires the persisted writer, and the ordinary ceiling rides same-Workspace reuse. The accepted/running display memory that guards the conversion is Client-local.

- The cost: the id→ctx handoff discipline and provide's Concurrent discipline are conventions rather than type-enforced, pinned by review and tests. The single state axis still withholds machine faces until a Session exists; the [resident conversation shell](../../../../packages/client/ui-conversation/README.md) routes activation to the Workspace picker during that interval.
- Known gaps: approval/question recovery across prune (TODO); model selection returns in live-mutation shape (the host `selectModel` trio is ready-made, its client consumer not yet built).
