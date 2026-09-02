# Agent Note: Client Session, Conversation, and UI ownership layers

Status: implemented

English | [中文](2026-08-20-client-session-conversation-ownership.zh.md)

## Problem

The Web Client once placed Session and Workspace objects, event windows, Conversation assembly, React hooks, the Slot registry, and the Store engine in one general Runtime. Protocol state, business projections, React bindings, and page presentation shared one dependency hub, so a change in any layer could spread across the entire frontend.

Session snapshots could also accumulate data they did not own, including event arrays, Conversation Views, Chat Nodes, and pending interactions. Ordinary consumers then had to understand event replay and concrete views, while adding a Conversation target could require changes to Session, Runtime, and the renderer.

Without an explicit interface between React and Session lifetimes, binding release, Hook source replacement, and Slot store cleanup became dedicated callback protocols. Approval and Question both affect sidebar state and composer takeover; independently maintained state could make those surfaces select different pending requests.

The Client needs one-way dependencies between data owners, React adapters, generic rendering machinery, and concrete views while preserving application behavior.

## Decision

The Client uses the layering “Controller and domain object → UI adapter → renderer → Slot component.” Controllers and domain objects publish React-free observable sources; their `ui-*` packages declare standard props and register sources; `ui-renderer` creates selector hooks at Slot binding points; components read data and actions only from Slot props.

```text
[Remote / Controller / domain object]
                  |
                  | bare observable source
                  v
             [ui-* adapter]
                  |
                  | standard source registration
                  v
              [ui-renderer]
                  |
                  | selector hook binding
                  v
            [Slot component]
```

Client Session and Workspace objects belong to `api/session-controller/client` and `api/workspace-controller/client`, respectively. Target-neutral Conversation data structures and assembly belong to `client/ui-conversation`; Chat and Trajectory belong to `client/ui-chat` and `client/ui-trajectory`, respectively.

The React adapters for Session and Workspace belong to `client/ui-session` and `client/ui-workspace`. The Store engine belongs to `client/store`; the Slot registry, scope materialization, and observable-to-hook binding belong to `client/ui-renderer`.

The system has no aggregate `client/runtime` package and no replacement central facade. [Session history and event transport](2026-08-18-session-history-and-event-transport.md) defines Session history, Remote streams, pagination cursors, and reconnect continuity; this note starts from the Client objects and sources published by Controllers.

## Layering principles

### Controllers are React-free logic owners

A Controller may be installed as a Cordis service, but it does not own React Contexts, React hooks, Slot props, or components. A Controller snapshot contains only facts that it owns, and its commands change only Host or domain-object state.

The UI layer may read multiple Controllers for one navigation decision, but it does not write the combined result back into any Controller snapshot. A UI adapter does not duplicate a Controller command's business implementation.

### UI adapters own React integration

Each standard hook belongs to the `ui-*` package closest to its data semantics.

| Hook | Owner | Source |
| --- | --- | --- |
| `useSessions` | `client/ui-session` | Session Controller global list |
| `useSession` | `client/ui-session` | Current Session snapshot |
| `useProjection` | `client/ui-session` | Current Session keyed projection |
| `useSessionPendingInteraction` | `client/ui-session` | Aggregated pending domains |
| `useWorkspaces` | `client/ui-workspace` | Workspace Controller list |
| `useConversation` | `client/ui-conversation` | Conversation binding snapshot |
| `useChat` | `client/ui-chat` | `chat` target source |
| `useTrajectory` | `client/ui-trajectory` | `trajectory` target source |

`ui-renderer` implements only generic binding. It does not import Session, Workspace, Conversation, Chat, or Trajectory business types or values.

### Slot scopes and standard props are separate

`ui-slots` declares root, session, and session-maybe scopes plus declaration-merge-extensible standard prop types. It does not decide which hooks each scope installs.

`ui-renderer` implements generic scope adapters and source materialization. `ui-session` installs the Session scope and supplies its built-in sources; other domain packages register only their own sources and the Slot entries that consume them.

Adding a target does not add a branch to the renderer or Session Controller. The data owner handles state identity, updates, errors, and release; the UI adapter owns the hook; the presentation owner owns target-specific projections and interaction state.

## Package ownership

| Package | Owns | Explicitly does not own |
| --- | --- | --- |
| `api/session-controller/client` | Session objects, list, selection, commands, projections, queue, event windows, and Agent Contexts | Conversation targets, React, Slots, Workspace |
| `api/workspace-controller/client` | Workspace objects, ordering, archive state, commands, and snapshots | React, Session navigation policy, directory UI |
| `client/ui-session` | Session scope, standard sources, `SessionProvider`, and pending-interaction aggregation | Session transport, Conversation assembly, Approval/Question results |
| `client/ui-workspace` | Workspace hook, browser UI, and cross-Controller navigation policy | Workspace transport, copies of Session data |
| `client/ui-conversation` | Conversation core, registries, bindings, shell, input, composer, queue, and View navigation | Session transport, Chat/Trajectory snapshots |
| `client/ui-chat` | Chat target, Node definitions, renderers, selection, details, and locale | Session lifecycle, generic View navigation, Trajectory, historical-image cache |
| `client/ui-trajectory` | Trajectory target, event-record projection, and inspection view | Session snapshots, Chat snapshots |
| `client/ui-approval` | Pending Approval, Remote listener, composer, and approval UI | Session control, generic composer election |
| `client/ui-user-questions` | Pending Question, Remote listener, composer, and question UI | Session control, generic composer election |
| `client/store` | React-free Store contract and implementation | Domain objects, React hooks, Slot lifetimes |
| `client/ui-renderer` | SlotRegistry, scope binding, selector hooks, outlets, and React root | Session, Workspace, and Conversation business logic |

## Overall data flow

Session data reaches the UI through this path:

```text
[ctx.remote.session]
          |
          v
[api/session-controller/client]
  |-- SessionListState --------------------------> [ui-session] -> useSessions
  |-- SessionSnapshot ----------------------------> [ui-session] -> useSession
  |-- ProjectionValueSource ----------------------> [ui-session] -> useProjection
  `-- per-Session SessionEventSource
                    |
                    v
             [client/ui-conversation]
                    |
                    | assemble
                    v
             ConversationSnapshot ----------------> useConversation
                    |
          |---------+----------|
          v                    v
      [ui-chat]           [ui-trajectory]
          |                    |
       useChat            useTrajectory
```

Workspace data enters the Workspace Controller from `ctx.remote.workspace`, then `ui-workspace` exposes it as `useWorkspaces`. For cross-domain navigation, `ui-workspace` temporarily reads the Session Controller and issues a selection or command.

Approval and Question arrive from the Host waterfall through `ctx.remote.$on` at their respective UI owners. Each owner publishes a Pending object; `ui-session.pendingInteractions` then supplies that same object to Session navigation state and Conversation composer selection.

## Session Controller Client

### Scope of SessionSnapshot

`SessionSnapshot` represents control and lifecycle facts belonging to a Session. It may contain identity, running, removed, blank, subagent address, open phase, history phase, prompt error, agent error, and queue state.

It does not contain:

- a raw event array;
- Conversation Views;
- Chat Nodes;
- Trajectory rows;
- pending Approval or Question objects;
- presentation state that requires callers to traverse events.

Whether a field derives from an event, control frame, or local command does not automatically determine its owner; consumption semantics determine ownership. `composerPhase` depends on both Session lifecycle and Conversation target activity, so `ui-conversation` composes it instead of placing it in `SessionSnapshot`.

### Three read faces

The Session Controller exposes three distinct read faces:

1. The global Session list and current-selection source, used by navigation and `useSessions`.
2. A logical binding for each Session containing `sessionId`, a `SessionSnapshot` source, commands, and projection sources.
3. A Conversation-facing `SessionEventSource` used only by the Conversation assembly core.

Ordinary UI components do not read `SessionEventSource` directly. `ui-session` does not read private event windows, and the `ui-conversation` core receives neither React bindings nor Slot APIs.

### SessionEventSource

`SessionEventSource` exposes a materialized event window, not a transport.

The window carries ordered `entries`, `hasMore`, a monotonic `revision`, and a `replace | prepend | append` change description. Append links an immutable segment in constant time; a consumer that needs the complete `entries` array materializes and caches it for that snapshot.

Initial open, reconnect, gap repair, and updates whose continuity cannot be proven publish `replace`; history pagination publishes `prepend`; a continuous live event publishes `append`. The Conversation core selects incremental update or complete rebuild from the revision and change.

`MutableSessionEventSource` is the Session Controller's internal write face. Consumers depend only on the read-only `SessionEventSource`.

### Session binding lifecycle

Each Session binding owns a Cordis Context and Fiber. The Session Controller creates and releases the binding.

Objects that depend on a Session register cleanup through `binding.ctx.effect()`. Releasing a binding cleans up Conversation bindings, UI materializations, and scoped Slot stores without a dedicated `onBindingRelease` or `onRelease` callback protocol.

This cleanup does not require the Session Controller to know the roster of upper-layer consumers.

## UI Session

### Service responsibilities

`client/ui-session` is the sole Session adapter between the Session Controller and the React/Slot system. It provides `ctx.uiSession` and:

- observes the Session list, current selection, and per-Session bindings;
- installs the session and session-maybe scope adapters;
- supplies `SessionProvider` rendering semantics;
- supplies built-in Session snapshot, projection, and sessionId sources;
- accepts Session-scoped source contributions from other domain packages;
- aggregates pending interactions registered by business packages.

It does not own Session transport, event folding, Conversation targets, or concrete business results.

### Standard source registration

A domain package calls `ctx.uiSession.provide()` to register a bare source. The descriptor statically declares its hook, keyed-hook, and prop rosters; `resolve(binding)` returns exactly those values for one Session binding. For example, `ui-conversation` registers each binding's snapshot as the `conversation` hook source.

The renderer converts an ordinary source into `use<Name>`. Open key spaces such as projections use a keyed-hook resolver, while stable values use props.

The runtime rejects undeclared, missing, or duplicate standard props. `ui-session` materializes its own built-ins through the same mechanism, so the renderer has no Session-specific name branches.

### Scope binding

session and session-maybe use the same adapter with different binding semantics:

- a strict session scope refuses to render without a current binding;
- session-maybe uses a stable absent binding to preserve hook call order;
- changing the current Session rebuilds the strict Session subtree under the `sessionId` key;
- root and session-maybe entries may remain mounted across Session changes.

Each real materialized binding retains the Controller binding's Context. `ui-session` removes the cache entry and withdraws the current binding through `binding.ctx.effect()`.

Changing the contribution roster rematerializes existing bindings and publishes a new source set. Source identity remains stable within one binding lifetime, as required by `useSyncExternalStore` caching.

### SessionProvider

`SessionProvider` is a standard seat derived by `PropsRenderSlots` from a session-scoped child declaration, not a React Context imported directly by business components.

It accepts ordinary `ReactNode` children rather than a `(sessionId) => ReactNode` render function; callers wrap `renderSlot('details', {})` directly.

Session identity comes from the scope binding and standard `sessionId` prop. The Provider handles only the absent branch and subtree isolation by Session identity; components do not obtain Session data through a Provider callback.

### Pending interactions

Business packages extend `SessionPendingInteractionMap` through declaration merging. Every pending object carries at least a stable `key`, domain `kind`, and `sessionId`; `ui-session` does not import concrete Approval or Question types.

A business plugin calls `registerPendingInteraction(precedence)` in `apply()` to create a stable registration for its pending domain. The returned per-request publication function publishes one exact object together with its waterfall-delegation callback and returns an idempotent disposer for that object. Plugin teardown removes all published objects before invoking and awaiting their delegation callbacks, so active Host requests cannot remain suspended after their Client answerer unloads.

Concurrent objects with the same key are rejected; replacement requests use a new key. One Session may hold multiple domains or requests at once.

`ui-session` selects each Session's effective object using domain precedence. Higher precedence wins; at equal precedence, the later valid object in traversal order wins.

The aggregate is published as `pendingInteractions: ObservableSnapshot<ReadonlyMap<SessionId, SessionPendingInteraction>>`; `useSessionPendingInteraction` is its React read face.

Session navigation state and composer takeover read the same effective object. They do not maintain separate status maps or takeover rosters.

## Workspace Controller and UI Workspace

### Scope of WorkspaceSnapshot

`WorkspaceSnapshot` contains only Host-authoritative data owned by the Workspace Controller, including Workspace rows, order, archive set, follow phase, and errors. A Workspace row's `sessionIds` is an association field, not a copy of Session objects in the Workspace snapshot.

These combined facts do not enter `WorkspaceSnapshot`:

- whether the Workspace and Session baselines are both ready;
- the most recent Workspace derived from Session update times;
- whether the current Session is cleared because it was archived;
- which blank Session New Session should reuse;
- which Session initial startup should select.

### UI Workspace composition responsibilities

`client/ui-workspace` registers the Workspace list source as the root standard source `workspaces`, from which the renderer provides `useWorkspaces`.

Initial selection, blank-Session reuse, new-session navigation, concurrent-create coalescing, and navigation after archival are UI navigation policy. That policy may read both `ctx.workspaces` and `ctx.sessions` at decision time, but it issues only Controller commands and selection actions and does not publish a combined snapshot.

Directory pickers, directory browsing, and `openPath` are separate directory capabilities and do not enter the Workspace Controller.

## UI Conversation

### Assembly core

`client/ui-conversation` contains both the React-free Conversation assembly core and the React adapter for the same domain.

The core owns `ConversationSnapshot`, the Definition registry, the View registry, the event assembler, the location index, per-Session bindings, target sources, and target activity.

The core obtains `SessionEventSource` from a Session binding. Append and prepend changes with continuous revisions use incremental assembly; replace changes or revision gaps rebuild from the complete window.

Definition or View roster changes rebuild only the Conversation binding; they do not rebuild a Session or reopen a Remote stream. The core does not import React and can test event folding, incremental updates, and registry lifetimes independently.

`ConversationSnapshot` does not copy `SessionSnapshot` or expose raw events. It publishes only the target-neutral View roster, target activity, and target-source lookup.

`useSession` and `useConversation` come from separate sources and are not guaranteed to publish atomically in one React commit. Components that read both compute purely from their current snapshots and do not treat notification order as business causality.

### Definition and View registries

`UiConversation.events` is the sole registry for event Definitions, and `UiConversation.views` is the sole registry for target snapshot builders.

The registries reject duplicate keys, preserve registration order, and return idempotent disposers. Existing Conversation bindings rebuild from their current event windows when a roster changes; changes in one synchronous registration turn are coalesced into one microtask rebuild.

A target package extends snapshot and location-data maps through declaration merging, then registers its Definitions, builder, and View. Registrations follow Cordis effect disposal.

`ui-conversation` does not import concrete target packages.

### Conversation React adapter

The React adapter registers each Conversation binding snapshot as the Session standard source `conversation`, from which the renderer provides `useConversation`.

The package also owns the shell, input, composer chain, queue UI, drafts, View navigation, and phase composition. The core reads no React Context, Slot props, or component state.

View selection order is a valid persisted selection, registered `chat`, then no View. An invalid selection does not overwrite the persisted value, and the system does not fall back to the first registered View.

Without `ui-chat`, the shell can still activate and mount but does not implicitly select Trajectory or another target.

The shell phase is a pure composition of Session lifecycle and Conversation target activity. An active Session or any target reporting visible content produces active; a failed first prompt remains engaging.

### Input and composer

The composer chain belongs to `ui-conversation`; a concrete takeover belongs to its business package. `ConversationRoot` reads the current Session's effective object through `useSessionPendingInteraction` and supplies it to chain selectors as `ComposerChainProps.pendingInteraction`.

A selector is a pure function of owner currency. Its non-null result reaches the selected component as `matched`. A stable composer entry and the default composer remain mounted together, while the chain selects one effective presentation.

Draft and input state belong to Conversation UI and do not enter the Session snapshot. Queue commands use a Session-scoped service for addressing and do not write queue UI into the Conversation core.

## Chat and Trajectory targets

### Chat owner

`client/ui-chat` registers target id `chat` and owns the Chat snapshot builder, Conversation Node definitions, keyed node renderers, selection, details, statistics, locale, and Tool-inspection collaboration.

It registers the `chat` target source through `ctx.uiSession.provide()`. `ChatView` uses `useChat` for aggregate order, navigation, and timeline reads; each `ChatNodeSeat` receives identity-stable Node and Turn-process sources from that snapshot and does not subscribe to the aggregate source.

Only visible non-command Chat Nodes activate Chat. Ordinary command-only history keeps the Hero visible; the `/goal` `command-input` Node activates a fresh Conversation.

The historical-image cache moved to `ui-conversation` (`ctx.uiConversation.imageUrl`), so Chat and Trajectory share one authorized read and one browser URL per session attachment ([Trajectory durable image attachments](../feature/2026-08-24-trajectory-image-attachments.md)); draft images remain part of Conversation input.

### Trajectory owner

`client/ui-trajectory` registers `trajectory` through the same target protocol. It owns event-record projection, timelines, virtual rows, selection, and the inspection view, and exposes `useTrajectory` through a standard source.

Session lifecycle reads `useSession`, while Trajectory data reads `useTrajectory`. Trajectory does not obtain its own data through a Session or Chat snapshot.

Other targets use the same registration flow without modifying the renderer, Session Controller, or ui-session.

## Approval and Question

### Stable registration

Approval and Question plugin installation separates stable registrations from per-request handling. `apply()` registers locale data, calls `registerPendingInteraction()` once for its pending domain, and registers one stable entry in `conversation.composer`.

The stable Approval entry also declares its detail child Slot. Concurrent requests and Session count do not add composer entries or redeclare Slots, and every registration follows plugin-fiber disposal.

### One waterfall request

A Remote Event listener resolves the Session from its own Agent Context. Without a Session scope it calls `next()` to continue the waterfall; with a Session scope it creates a `PendingApproval` or `PendingQuestion`.

The listener publishes the object through the registered domain publication function, waits for user completion, cancellation, or request-signal abortion, and removes the exact object in `finally`.

One request does not register a Slot, create another lifecycle effect, or mutate the Session snapshot.

Approval exposes allow and reject; Question exposes answer and cancel. User cancellation of a Question returns `ASK_CANCELLED`; interruption of a pending request by `AbortSignal` returns `UserQuestionError(ASK_ABORTED)` rather than leaking the carrier's `AbortError` or an ordinary `Error`.

The Gateway requires only that Remote Event arguments and results are valid JSON transport values. It does not duplicate domain validation of Question options.

### One pending projection

The Sidebar and composer consume the same `pendingInteractions` snapshot. Navigation displays approval, plan-review, or question state from the effective object's `kind`; each composer entry selects its own panel by object identity.

The same request identity drives both UI surfaces. A request that replaces another request of the same type uses a new key, so selectors and subscribers observe the identity change.

`ui-session` implements only cross-domain precedence and does not interpret Approval or Question fields.

## UI Renderer and Store

### UI Renderer

`client/ui-renderer` owns the `SlotRegistry` service and React renderer. It is responsible for:

- `ctx.slots.register()`, `inject()`, `renderSlot()`, and declaration lifetimes;
- root, session, and session-maybe scope adapters;
- binding standard observable sources to selector hooks;
- Slot outlets, error isolation, root mount, and hydration;
- managing Slot store instance lifetimes by scope key.

The renderer may know generic scope names and binding protocols but does not read domain services. Rendering Session scope without an installed adapter is an assembly error that fails immediately.

### Store

`client/store` is a plain React-free library owning `ObservableSnapshot`, `SnapshotStore`, `defineStore`, `createSnapshotStore`, and `shallowEqual`.

`ui-slots` references the Store contract; `ui-renderer` manages Store instances and supplies `useStore`.

Stores hold viewing and interaction state such as drafts, View selection, Chat selection, inspection requests, and panel size. Session, Workspace, Conversation, Remote streams, and connection generations do not enter Stores.

### Registration and release order

When one plugin provides both a source and a Slot entry, it registers the source first and the entry second. Reverse Cordis disposal then removes the entry before the source, so a mounted entry never briefly loses a required hook.

Releasing a Session binding cleans up UI materialization and scoped Stores through `binding.ctx.effect()`. Releasing a plugin fiber cleans up sources, listeners, and Slot entries through registration disposers.

Every disposer is idempotent and depends on no implicit callback outside the Cordis lifecycle.

## Composition and dependency direction

The application bundle explicitly installs the required Controller, adapter, target, and renderer plugins. Each owner's `apply()` installs only its own service, listener, and contributions.

Runtime consumption flows as `session-controller → ui-session → ui-conversation → target UI`, `workspace-controller → ui-workspace`, and `store → ui-slots → ui-renderer`; Approval and Question depend only on the pending-registration point exposed by `ui-session`.

Arrows in this description represent runtime consumption and do not include type-only declaration-merge edges. Controllers do not depend back on UI adapters, the renderer does not depend back on domain packages, and the Conversation core does not depend on a concrete target.

UI components do not receive `ctx`. Cross-package collaboration uses Cordis services, standard sources, or Slot registrations without introducing an aggregate facade.

## Developer guidance

### Choose the data owner first

Before adding state, choose its sole owner from its consumption semantics: Host communication, commands, and entity lifecycle belong to an API Controller; data assembled from Session events but independent of a target belongs to the Conversation core; projections serving only one View belong to that target package; drafts, selections, and panel state belong to the UI package that owns the interaction.

The same fact must not be retained simultaneously in a Controller snapshot, Conversation snapshot, and Store. A cross-domain decision reads multiple sources and immediately issues a command; it does not create a joined snapshot or cache another domain's object.

These are signs of incorrect ownership: a Controller imports React; the renderer branches on business types; a component traverses Session events; a Store holds Session or Workspace entities; changing one target requires changing the Session Controller.

### Add Session-scoped data

1. Provide a React-free observable source in the domain owner.
2. Declaration-merge the standard prop type in the owning UI adapter.
3. Declare a fixed roster through `ctx.uiSession.provide()` and resolve its source from a Session binding.
4. Let the Slot component receive the generated hook through `PropsRuntime`; do not pass `ctx` to a component.
5. Attach each binding resource's cleanup to `binding.ctx.effect()` and leave registration cleanup to the plugin fiber.
6. Test missing values, duplicate names, roster replacement, Session changes, and binding disposal.

Only open key spaces use keyed hooks. Finite stable sources use ordinary hooks, and immutable identifiers use props. Do not hard-code business names in the renderer to save one registration.

### Add a Conversation target

1. Extend the Conversation snapshot or location-data map in the target package.
2. Register the required event Definitions with `UiConversation.events`.
3. Register the snapshot builder, target id, View, and activity rule with `UiConversation.views`.
4. Expose the target's standard selector hook through `ctx.uiSession.provide()`.
5. Register the renderer, locale, and target-specific Slot entries in the same package.
6. Verify that unloading the target rebuilds only the Conversation binding without changing the Session, other targets, or Remote stream.

A target must not use another target's snapshot as its data source. Optional collaboration uses a narrow port or Slot; when a target is absent, the shell remains bootable and does not guess a fallback.

### Add a pending-interaction domain

1. Define the Pending object and its completion, cancellation, and interruption semantics in the business package.
2. Add the object to `SessionPendingInteractionMap` through declaration merging.
3. Call `registerPendingInteraction()` once in `apply()` and register one stable composer entry.
4. Resolve the Session from the Agent Context in the Remote waterfall listener; call `next()` when the listener cannot handle the request.
5. When it can handle the request, create the Pending object, publish it through the publication function, await its result, and remove it in `finally`.
6. Test concurrent keys, precedence, user cancellation, transport abort, plugin disposal, and delegation without a Session.

A request does not register Slots, declare child Slots, mutate the Session snapshot, or create a separate state index. Sidebar and composer both read one effective object from `useSessionPendingInteraction`.

### Review checks

- Every new source, registry contribution, listener, and cache has an explicit Cordis-fiber or Session-binding owner.
- Every public hook traces to one React-free source; no selector is forwarded through layers only to pass arguments.
- Every component obtains data and actions from standard props or the owning Slot's inject face.
- Every target has defined behavior when absent, dynamically registered, and unloaded.
- Every cross-layer import advances in the one-way Controller, adapter, renderer, component direction.
- Each error is classified by the earliest owner that can explain its semantics; carrier errors do not leak directly as business errors.

## Verification

Tests owned by each layer pin Controller bindings and event sources, UI scopes and pending precedence, incremental Conversation assembly and View fallback, target projections, waterfall results, and renderer scope/Store lifetimes. Application-composition tests cover both the complete roster and startup without a concrete target; component tests do not replace object-layer, replay, and lifecycle tests.

## Alternatives considered

- **Keep a Runtime facade.** One entry point would retain the dependency hub and let new code bypass domain owners, so the system provides neither the facade nor a compatibility export.
- **Put all Client state in API Controllers.** Protocol objects would then own React, Views, and presentation policy, so Controllers retain only React-free domain state.
- **Let Controllers provide React hooks directly.** Non-React consumers could not reuse the same objects, and transport and renderer lifetimes would become interdependent.
- **Put Conversation in SessionSnapshot.** This would expand the Session API and force ordinary Session consumers to understand event folding and target rosters.
- **Let Chat and Trajectory replay Session events independently.** Ordering, locations, and registry rebuild would be duplicated, so the shared assembly core stays in `ui-conversation`.
- **Extract the Conversation core into another non-UI package.** The core and adapter currently evolve together and have no other non-UI package consumer; directory separation within one package keeps the core React-free.
- **Combine Workspace and Session into one snapshot.** This would create another cross-domain owner, so cross-domain logic remains an immediate decision in `ui-workspace`.
- **Build every standard hook into the renderer.** Generic infrastructure would need to know every domain, so standard-source registration keeps the renderer independent from business types.
- **Dynamically register a composer entry for every pending request.** This would redeclare child Slots and make concurrent requests compete through registration order, so stable entries are separate from request publication.
- **Write pending interactions into a Session projection.** An unanswered waterfall is not a committed durable Session fact; Remote Event replay restores it after refresh, so it remains in a business UI source.
- **Add a dedicated release callback to bindings.** This would duplicate the Cordis lifecycle; `binding.ctx.effect()` already attaches consumer cleanup to the same owner.
- **Pass the Session id from SessionProvider through a render function.** This would create another data-injection path; ordinary children and the standard `sessionId` prop retain one entry for scoped data.
- **Keep Store in the renderer.** The Store contract does not depend on React and is reused by objects and test infrastructure, so `client/store` keeps the engine separate from rendering lifetimes.

## Consequences

Session, Workspace, Conversation, and each concrete target own one authoritative state. Non-React consumers can reuse Controllers and the assembly core directly. A new Conversation target registers its Definition, builder, View, standard source, and Slot entries; a new pending-interaction domain declares its type, registers its domain, and provides one stable composer entry.

The renderer and Session Controller gain no branch for a new business domain, while Session bindings and plugin fibers provide two explicit, composable release paths. The UI can observe independent Session and Conversation source publications, and consumers cannot depend on their notification order.

Composition packages must explicitly load the required adapter and target plugins. The shell remains operational without a concrete target but neither creates nor guesses that target's View. More packages and explicit registrations add assembly work, while dependency direction, test scope, and failure ownership become locally identifiable.
