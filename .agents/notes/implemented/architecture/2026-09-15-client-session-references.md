# Agent Note: Client Session references, reference sources, and UI status

Status: implemented

English | [中文](2026-09-15-client-session-references.zh.md)

## Problem

The Session catalog, live Client objects, views, and asynchronous operations have different lifetimes. Catalog membership does not establish ongoing use. A borrowed binding cannot protect asynchronous work or distinguish successive Client generations with the same Session id. A global current Session makes independently bound components act on another view's Session.

A reference count identifies ongoing use but not its consumers. Main-area highlighting, Sidebar ownership, and background operations need consumer-source information. Pending interactions and completion reminders also need one UI read interface so Workspace and Conversation do not independently combine the same status.

Client history access and Host Agent execution have independent lifetimes. History opening can fail; local Context acquisition need not read history. Explicit ownership must preserve navigation, loading, error handling, and recovery behavior without adding unrelated UI policy.

## Decision

### Scope and ownership

Client Session objects, Agent-scoped Client Contexts, references, consumer-source metadata, UI status, and explicit Provider composition use the ownership rules below. Host Session and Agent lifetimes, SlotFactory, activity dashboards, durable Session formats, and both SDKs' Host protocols remain independent.

| Owner | Responsibility |
| --- | --- |
| Client Session Controller | Catalog, live generations, references, source counts, bindings, history windows, and existing Session control state |
| `ui-session` | Explicit Session Provider integration and the unified UI status source |
| View or operation | Its own reference, target, source identifier, and release point |
| Workspace UI | Main-area target and reference, navigation, persisted target, and creation flow |
| UI composition boundary | Supplies an owner-provided reference to one explicit `SessionProvider` |
| Conversation and Sidebar subtrees | Consume only their Provider's Session, never a main-area reference or global selection |
| Client Gateway | Invocation-lifetime Context ownership while handling a Host event |

The [Client layering design](../../implemented/architecture/2026-08-20-client-session-conversation-ownership.md) defines one-way data, adapter, renderer, and presentation dependencies. Reference-source bookkeeping does not give the Controller a dependency on UI packages.

This decision partially supersedes the list-selected scope lifecycle in the [Web Client Session scope and provide-channel decision](2026-07-25-web-client-session-scope-and-provide-channel.md); that note retains the blank-Session and adoption rationale under explicit Provider ownership.

### Addresses, bindings, and references

`SessionTarget` is a known `SessionId` or a durable direct-parent `SubagentAddress`. It identifies what to acquire; it owns nothing. The Controller resolves an explicit address without requiring a preloaded parent catalog, while the Host validates its parent, child, and mode when history opens. Child discovery and an already known child address remain distinct from retaining the child. Navigation uses the same target representation rather than adding a separate navigation address.

`SessionBinding` is the shared Client generation: `sessionId`, Session face, event source, and scoped Context. Multiple references to the same live generation share this binding. A new generation with the same id has a different binding and Context.

`SessionReference` owns one use of one exact generation. It exposes read-only `sessionId` and `binding`, a `ready` Promise for the shared initial history opening, plus idempotent `release()` and `Symbol.dispose`. `ready` resolves to the exact binding when the corresponding `Session.open()` attempt resolves, including its stateful Remote-failure result. Reading `binding` after release or generation disposal fails. Retaining, releasing, or inspecting a reference does not create durable Sessions or start, stop, or retain a Host Agent.

`SessionBinding` is a borrowed value and owns no lifetime. Only unreleased `SessionReference` objects contribute to source and total reference counts. Synchronous code may borrow a binding within its owner's reference lifetime; work that outlives that owner must acquire its own reference.

| API | Result and caller obligation |
| --- | --- |
| `sessions.retain(target, options)` | `SessionReference`; returns immediately, and the caller owns the reference until release |
| `sessions.using<T>(target, options, operation)` | `Promise<T>`; awaits `reference.ready`, awaits `operation(reference)`, releases its reference, and returns the operation's result |
| `sessions.retainInfo(id)` | Stable read-only observable of local reference counts; no acquisition, scope creation, or history I/O |
| `sessions.scope(id)` / `sessions.binding(id)` | Borrow an existing live generation or return `undefined`; neither opens nor extends its lifetime |
| `sessions.sessionOf(ctx)` | Returns the matching live Session face or `undefined`; an ended Context cannot resolve to a same-id replacement |
| `sessions.create(...)` / `sessions.fork(...)` | Existing Host operations returning a Session identity; retaining and displaying it remain explicit |

`SessionRetainOptions` contains required `source: SessionReferenceSource` and optional `signal: AbortSignal`. Both acquisition methods accept `target: SessionTarget` and these options. Source keys are consumer-defined and declaration-merge extensible; there is no runtime source-registration protocol or default main-view source. A source is a usage label, not another Session address or a permission to act on it.

### Acquisition, failure, and release

Acquisition synchronously resolves the target, creates or retains the local Session, Context, fiber, and binding, records one reference and its source contribution, starts the generation's shared initial history opening, and returns the reference. Concurrent acquisitions share that opening but receive independent references and readiness waits. `reference.ready` resolves to the still-live exact binding when the shared `Session.open()` attempt resolves.

Unknown Session-id addressing fails before a reference is returned; an explicit subagent address is validated by the Host during opening. A thrown opening failure, caller cancellation, reference release, or generation retirement rejects that reference's `ready`; one cancelled waiter does not cancel another owner's shared opening. A Remote failure represented by `openState: 'error'` follows `Session.open()` and resolves readiness, leaving the error renderable through the binding. The caller still owns a returned reference until release, while `sessions.using` releases its reference when readiness or its operation fails.

`using reference = sessions.retain(target, options)` releases on exit from the enclosing scope; code that requires settlement of the initial history attempt awaits `reference.ready`. `sessions.using` is the callback helper: it waits for that settlement before invoking an operation, waits for its returned value or Promise, and then releases. Returned values must not rely on the helper's released reference remaining usable; a longer-lived consumer acquires its own reference. The helper propagates rejected readiness and operation failures without a fallback result, retry, or error presentation. Model-selection generation checks and error-state updates remain in ModelSelection.

A fulfilled `ready` Promise means the initial `Session.open()` attempt settled; it does not assert `openState: 'open'` or promise an uninterrupted connection. Stateful opening failures and later stream failures remain observable through existing Session state. Callers retain their existing handling and presentation of those errors.

Release removes only that reference and its source contribution. Final release withdraws the generation's admission and id mappings before disposing the Session and fiber. A later retain can create a fresh generation immediately; cleanup of the old generation cannot remove the replacement. `release()` initiates local cleanup synchronously, while root disposal awaits outstanding asynchronous teardown.

The owning Client root invalidates all references during shutdown. It refuses new acquisitions, withdraws live mappings, and joins scoped cleanup and Session stream teardown. References cannot keep a disposed Client root alive. Catalog removal alone does not dispose a referenced generation.

### Reference sources and Session list records

The Controller owns source counts alongside each live generation's references. For every source, the count equals that generation's unreleased references bearing the source. A Session can have several sources, and a source can hold several references. Sources have no special lifecycle behavior in the allocator.

Each available Session list row exposes a read-only `retainedBy` record from source key to positive reference count. An unretained row has an empty record; zero-count keys are absent. Acquisition failure and release update that projection, including removal of the final key. The source counts remain local facts when Host metadata is refreshed; Host responses cannot overwrite them.

The generation owns the counts even if its Session has not reached the Host catalog or its catalog metadata has been removed. `byId` contains Host summaries, projected child-catalog rows, and fallback rows for retained subagents with a known direct-parent address. Acquisition publishes a missing subagent row synchronously so Provider discovery does not depend on parent-catalog arrival; title projections and reference-source counts continue to update that row. Ordinary retained Sessions do not synthesize fallback rows. `ids` remains the Host-list membership and ordering. Consumers of an unlisted generation use its binding and `retainInfo` directly. Every row's `retainedBy` projection uses the live generation's counts. Neither the reference objects nor the counts are persisted or sent to the Host.

For example, `retainedBy = { mainView: 1, gateway: 2 }` means that the main view and two Host invocations own three references. Releasing the main-view reference removes only `mainView`; the Gateway invocations continue to own the generation. Source names in this example are consumer keys, not a closed Controller enum.

`current` means main-view occupancy: a row has that marker exactly when its `mainView` source count is positive. It is one use of the general source record, not a separate `sessions.current` value or Session-selection service. Other consumers can derive their own markers from their source keys. The reference system does not impose a globally unique consumer or select one Session from multiple sources.

The main-area owner manages its own target and reference transitions. The list does not infer selection from how many Providers happen to be mounted. Source records report actual ownership, including temporary overlap during acquisition; UI navigation remains responsible for its target, without assigning selection authority to the allocator.

Window-level consumers may inspect source markers. Session business operations still use their supplied scope or explicit reference; they cannot find `mainView` in the catalog to recover a missing operation target. A background reference is ownership evidence, not evidence that a user viewed the Session.

`SessionRetainInfo` contains `referenceCount` and the read-only `retainedBy` record. `sessions.retainInfo(id)` observes that local ownership independently of catalog membership and remains stable across same-id generation replacement. An identity without a live generation has zero references and an empty source record; reading this value does not assert that the identity exists on the Host.

`ui-session` exposes `useSessionRetainInfo(sessionId, selector)` for an explicit identity and `useSessionRetainInfo(selector)` for the Session bound by the surrounding Provider. An unbound scope supplies absence to the latter form, never the main area's Session. The renderer constructs both forms from the same bare retain-info source. Consumers test the `mainView` source count to recognize the former current-Session role; other source keys remain equally queryable. Reading or subscribing does not retain the Session.

### Unified UI Session status

`ui-session` owns a React-free `sessionStatus` source and exposes it through the standard `useSessionStatus` hook. The snapshot is indexed by Session identity and supplies one UI status record per known Session. It combines these independent facts rather than reducing them to one mutually exclusive phase:

| Field | Value | Meaning and owner |
| --- | --- | --- |
| `running` | `boolean` or `undefined` | Latest known Session running fact; absence of a baseline is not confirmed idle |
| `pendingInteraction` | `SessionPendingInteraction` or `undefined` | Effective domain-owned request, or absence when no request is pending |
| `completionUnread` | `boolean` | UI reminder for an observed stop that has not been acknowledged |

Source counts remain authoritative in `SessionListState.byId[id].retainedBy`; UI status reads them for acknowledgement policy without owning another reference registry. Titles, Workspace associations, history, queues, and projection data remain with their existing owners.

Pending domains retain `SessionPendingInteractionMap`, request identities, precedence, publication disposers, and teardown delegation. The unified status includes the same effective request object; it does not copy requests or create a second pending registry. Workspace status indicators and Conversation composer selection read `useSessionStatus` instead of separate `useSessionPendingInteraction` and `useCompletedSessionIds` hooks.

Completion tracking subscribes to the existing `api-session/status` events so a running-to-idle transition is not lost in batched catalog snapshots. Host-list rows (`ids`) establish initial and reconnect running baselines; synthetic catalog and retained rows preserve independently observed status. A pending empty catalog is not evidence that Sessions disappeared. The update rules are:

- An initial idle baseline does not create a completion reminder.
- Observing running clears an earlier reminder and records the running baseline.
- A known running-to-idle transition sets `completionUnread` only when the Session lacks main-view ownership.
- Acquiring main-view ownership clears the reminder; retaining from an unrelated source does not.
- Releasing main-view ownership does not manufacture a reminder for an earlier stop.
- Removing a Session clears its completion reminder and running baseline; pending-request teardown stays with the request's domain.

The reminder denotes an observed stop, not successful task completion or completion of a particular queued message. Main-view ownership preserves selection-based acknowledgement even while a global panel temporarily hides the Conversation. The design has no `ui-session/view-presence` event, mounted-Provider index, or implicit acknowledgement from Provider mount.

The Session Controller publishes running and reference-source facts but owns no completion-reminder set, `consumeCompletion` method, or pending-interaction presentation. Reference acquisition does not execute completion-reminder business logic.

### Explicit Providers and consumer lifetimes

The single `SessionProvider` can inherit an outer binding or override its subtree with explicit `session={reference | undefined}`. It neither acquires nor releases ownership. The root Provider resolves its main binding from the `mainView` ownership marker without maintaining another current value; sibling and nested Providers affect only their own subtrees. Explicit absence stays absent instead of falling back to the main area.

The Provider injects the selected binding without keying its whole body. Strict `session` entries remount when the binding Context changes. A blank `session-maybe` entry adopts its first binding without remounting; after adoption, another binding Context or a return to absence starts a new component incarnation.

`uiWorkspace` owns the main-area reference with source `mainView`, and `ui-session` derives the root Provider from that reference's ownership marker on the Session record. Conversation, right Sidebar, preset, command, input, and model components beneath a Provider consume only its standard bound data. They do not read the main-area reference or a global selection, and they do not reinterpret an ID as a binding from another Provider.

Each Provider occurrence establishes an independent rendering scope from its supplied `SessionReference`. Two references may identify different Sessions or share one `SessionBinding`; different bindings isolate business and view data, while Providers for the same binding share Session, Conversation, input, and other Session-level data but retain separate component-local state. The main area and Sidebar can mount two Conversations concurrently without either Provider replacement or teardown redirecting the other subtree.

`ui-session` reuses one stable business observable per active `SessionBinding`. Generation caches for Conversation assembly, input shells, command popups, input-trigger controllers, and model directories use binding identity instead of Session IDs. Caches that must enumerate live values use `WeakMapWithValues<SessionBinding, Value>`, whose weak key table and strong value set provide identity lookup and value iteration. The container performs no cleanup; subscriptions, controllers, URLs, and other resources still release deterministically through `binding.ctx.effect()`. Provider-occurrence view state ends with that rendering scope, while final generation cleanup belongs to the binding Context.

Descriptor changes assemble replacement sources before publication without recreating Session generations. A Provider validates its reference while reading it; a released reference, a reference from another Controller, or a reference that no longer matches an active binding cannot establish a scope.

| Consumer | Acquisition and release |
| --- | --- |
| Main Conversation | `uiWorkspace` acquires the navigation target; `ui-session` establishes the root Provider from the `mainView` marker, and the Conversation subtree consumes only its Provider binding |
| Associated right Sidebar | `RightbarRoot` inherits the root Provider without reading the main-area reference |
| Independent Session view | Its owner retains the target and establishes a Provider from its own reference alongside the main area |
| Host event handler in the Client | Holds a local Context reference through handler and reply settlement |

Conversation references belong to their view owners, not Chat, Trajectory, or an individual action. Chat, Trajectory, commands, input, uploads, image reads, and model selection borrow the same binding during the Provider lifetime rather than acquiring a reference per action. Switching or closing that Conversation can end its in-flight local work. Sidebar-tab layout and resource ownership remain separate; only a Sidebar view that hosts a Conversation needs its own Session reference. Empty layouts and guide placeholders retain nothing.

Scoped business objects capture their binding before awaiting work. They do not reinterpret an old Context or directory as a new generation with the same id. ModelSelection borrows its Provider binding while retaining its own selection-generation and error rules. Editor-detach callbacks may overlap scope teardown; optional trigger and popup resolution returns absence for that retired Context rather than resolving another generation.

### Main-area navigation and presentation

`uiWorkspace.openSession`, `openWorkspace`, and `startSession` are the navigation entry points. They accept or resolve explicit targets, change the main view, and return the main area to Conversation according to existing navigation policy. Sidebar `forkSession` creates and renames the child without retaining it or changing selection. `retain` itself never navigates. There is no `registerNavigation` receiver protocol or second navigation service introduced by reference ownership.

The existing `uiWorkspace` implementation directly owns the main-area reference and target. Its navigation methods update that owner rather than calling a receiver registered by Conversation. `ui-session` derives the root Provider binding from the source marker; the main Conversation and associated right Sidebar only inherit the Provider and neither depend on `uiWorkspace` nor see the main reference. An independent Sidebar Conversation establishes a nested Provider from its own reference and overrides only that subtree's binding. The main reference is not a global standard prop, subtree Hook, or default value for ID-based lookup.

The main view privately persists its target identity and subagent address under `dsh.sessions.current`, never a reference. Startup restoration, initial Workspace selection, and clearing an archived main target remain UI responsibilities. Archiving or removing catalog metadata does not revoke independent references held by other consumers.

| UI behavior | Final rule |
| --- | --- |
| Session-list highlight and blank-row treatment | Derive main-area occupancy from `retainedBy.mainView`, not the number of mounted Session Providers |
| New Session Workspace | Explicit Workspace first, then the main Session's Workspace under the existing lookup rule, then the existing recent-Workspace policy |
| Onboarding | Evaluate absence or blankness of the main-area Session, not all historical Sessions |
| Browser document title | Conversation shows Session title plus product title; a global panel shows product title |
| Chat/Trajectory restoration | Restore the view for the explicitly selected main target; independently bound views keep their own state |
| Cordis inventory panel | One list without current/other grouping; no public runner getter for main-area selection |

Source metadata does not change when DOM focus moves or when a global panel hides a retained view. The [global main-panel design](../../implemented/architecture/2026-09-08-global-main-panels.md) owns panel selection and layout; Session reference ownership does not replace it.

Conversation retains its `hero`, `settling`, and `active` composition and existing history-loading and `openError` handling. Acquisition adds no outer loading/error phase presentation, extra composer-hiding condition, Retry button, or replacement Sidebar recovery panel. Existing error handlers continue to handle their errors; call sites without error presentation gain none. Promise rejection and correct reference release do not imply an additional UI handler.

Workspace connection preserves its navigation guards and panel-switch invalidation. Sidebar fork does not supersede an in-flight navigation. Direct Session opening gains no additional global-navigation cancellation policy. Agent Team refresh preserves its originating-selection validity condition instead of starting a global navigation token before refresh. Reference acquisition does not broaden cancellation to unrelated navigation or running operations, and local cancellation does not roll back Host effects.

### Presets and creation flows

Preset directories and deployment defaults may be shared. A bound Session's preset is read or changed through its Provider binding; preset controllers are cached by `SessionBinding` rather than managed by one root current-Session follower. The hero preset seat uses the `session-maybe` Provider: it shows the creation-flow choice without a Session and operates on the exact bound blank Session after one arrives. Header labels read the same Provider-bound Session projection.

A preset chosen before Session creation remains in the main Conversation's `session-maybe` preset surface. After Workspace creation or reuse establishes the main Provider over a blank Session, that surface applies the choice to its Provider-bound Session. When Settings changes the default preset, the preset service selects the blank Session whose established Provider binding carries `mainView` ownership and updates that Session. Non-blank main Sessions, independent Sidebar Providers, and other background references remain unchanged; preset subtrees do not read the main reference or use a global current follower to find their target.

### Host-event Context ownership and Typert

A validated Host waterfall identity can arrive before catalog discovery. The Client Context resolver must remain synchronous. It acquires a local generation reference with the Gateway's source and returns `TypertOwnedValue<Context>` without opening history or refreshing child catalogs. A handler that needs history separately acquires a public reference and awaits its `ready` Promise, or uses `sessions.using`.

Gateway owns the local reference until both handler use and reply settlement end. Context acquisition failures retain the existing report-and-delegate behavior, while handler failures produce rejected replies. Cancellation reaches the handler through its existing signal and suppresses late replies without releasing a Context still in use. Plugin shutdown joins the active connection generation's outstanding handlers; Connection starts no replacement generation until that source settles.

`TypertOwnedValue` carries a value and its disposer through the generic Gateway. It has no additional reference count and does not teach Gateway about Session-specific ownership. Independently bundled Client modules share the owned-value marker. Client outgoing `identity(ctx)` remains synchronous; Host Context resolution and Host lifecycle are unchanged.

## Alternatives considered

**Catalog membership as ownership.** Discovery data cannot establish ongoing view or operation use, and some Context identities arrive before catalog membership.

**Implicit main Session plus an explicit alternative.** Two target-resolution rules make reusable components depend on where they render. Explicit Providers supply the target, while generic source records serve window-level observation.

**Provider subtrees reading `mainSession`.** A component would then have both a Provider target and a window-level target, so an independent Sidebar Conversation could be redirected by a main-area change. The main reference participates only in Provider assembly; subtrees consume their Provider.

**Session ID as a generation-cache key.** Final release allows a replacement generation with the same ID to appear before old cleanup ends. An ID key can reuse the old object or let old cleanup remove the replacement. Business caches use weak binding identity, and the binding Context still owns resource cleanup.

**Asynchronous `retain` that resolves only after history opens.** It delays Provider installation and main-view navigation until history arrives, so the existing loading state cannot render immediately. A synchronous reference separates ownership from its explicit `ready` result.

**History I/O in synchronous Context resolution.** Host-event dispatch needs a scoped lifetime, not necessarily a history window; coupling them delays or blocks handlers before catalog discovery.

**A dedicated current flag.** One consumer-specific flag cannot describe Sidebar and background ownership. A main-view marker is derivable from the general per-source counts.

**Completion state in Session Controller, or separate pending and completion hooks.** Completion acknowledgement is UI policy. One UI status source composes independent facts while retaining domain-owned pending objects and Controller-owned running facts.

**Provider presence as acknowledgement or release.** Mounting is neither an owner's lifetime nor selection-based acknowledgement. It cannot decide which background or temporarily hidden uses remain alive or count as viewed.

**Bare ids in Providers or a global binding revision.** An id does not express generation ownership, and global refresh invalidates unrelated Session consumers.

**A reference for every action.** The Provider already defines the Conversation's usage lifetime. Reacquiring for every click fragments view ownership into fine-grained sources. Only work that must outlive the Provider acquires another reference.

**Navigation registration, new cancellation policies, and acquisition-specific recovery UI.** Reference ownership requires explicit targets, release, and failure propagation, not additional navigation or recovery behavior.

**Client references retaining Host Agents.** History access and Host execution are independent uses; a long-lived Client view cannot define Host business-operation lifetime.

## Verification

- Acquisition tests cover shared initial opening, ordinary and unexpected open failures, independent waiter cancellation, exact-generation replacement, and root teardown reaching quiescence.
- Source tests cover multiple sources, several references from one source, failed acquisition rollback, idempotent release, catalog refresh/removal, and late release of an ended generation without changing its replacement.
- Retain-info hook tests cover explicit identities, Provider-bound defaults, unbound and nested scopes, source updates across generations, and reads that create neither references nor history requests.
- Scope and Gateway tests cover synchronous Context acquisition before catalog discovery without history I/O, reported acquisition delegation, rejected handler replies, ownership through cancellation and settlement, and shared owned-value markers across bundles.
- UI status tests cover pending precedence and teardown, event transitions lost by snapshot batching, initial and reconnect baselines, main-source acknowledgement, unrelated-source retention, and no Provider-presence event.
- View tests cover explicit Providers for two different Sessions and for repeated uses of one Session, scoped presets, descriptor updates, and Sidebar occurrence/adoption lifetimes without new recovery controls.
- Assembled browser scenarios preserve main-area highlighting, blank rows, onboarding, Workspace defaults, titles, and the defined navigation/error behavior. Existing recorded model turns remain the behavioral input when only Client ownership changes.
- The public `retain` and `using` consumers, generated API catalogs, package contracts, and type checks agree on options and ownership. The helper keeps references through callback settlement and propagates both acquisition and operation failures.

## Consequences

Consumers must keep references until their real completion point; an unreleased reference still leaks within a live Client root. Retaining after final release creates a new generation and can reopen history. Source counts describe ownership, not visibility, task success, or authority; using the main marker as a business fallback would recreate implicit current-Session coupling.

Final release discards non-persisted binding-owned state, including loaded history pages, Chat scroll anchors, preview wrapping, Files expansion, composer attachments, and undo history. Only persisted Session-keyed Store values or a generation kept alive by another reference survive a view switch; the runtime does not clear those persisted values.

Every public `retain`, including the temporary reference used by ordinary Session rename, starts the generation's shared initial history opening. Fork-title assignment instead sends rename directly and applies its returned projection without a Client reference or history I/O. A metadata-only fork operation therefore cannot create a temporary list row or switch the main view.

The catalog, UI status, and view target have separate owners and can publish independently. Their consumers must not infer a lifecycle transition solely from notification order. The main view remains an ordinary reference owner, while its navigation and presentation rules stay in UI rather than the reference allocator.
