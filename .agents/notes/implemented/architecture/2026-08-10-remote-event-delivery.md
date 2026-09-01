# Agent Note: Remote event delivery (`ctx.remote.$on`)

Status: implemented

English | [中文](2026-08-10-remote-event-delivery.zh.md)

## Problem

[Typert Remote method calls](../../implemented/architecture/2026-08-02-typert-remote-method-calls.md) initially cover targeted calls with one result per request and deliberately leave Session streams and stateful interactions elsewhere. Host-to-consumer events need a delivery mechanism that is not owned by the API Proxy domain.

The Host owns one-way events such as `agent-preset/selected`, `commands/change`, `credentials/reference-updated`, `llm/adapters-updated`, and `settings/document-updated`. They do not depend on AgentScope, and their payloads are already JSON. Requiring every event to cross a handwritten API Proxy frame, a handwritten Client Runtime bridge, and a Client event alias adds no fact beyond the owner event declaration.

That duplicate declaration is also lossy: the Client side restates an event as `settings/changed(ns: string)`, flattening a branded type to bare `string`, contrary to the Remote-method rule that consumer types point to the business package's one canonical symbol.

## Decision

The consumer Remote surface has one event-subscription verb, `ctx.remote.$on(event, listener)`, with allowlist-driven, verbatim forwarding:

- `packages/api/remotes/src/remote-events.ts` owns one list of forwardable Host events with explicit `emit`/`waterfall` modes. It is also the sole control point for what consumers may subscribe to. Adjacent `src/types.ts` derives the type projection and fills the selection seat while remaining type-only. Both files appear in the `files` of the package's Host and Client faces, so both read one declaration.
- The event name on the wire is the original Host Cordis name (`settings/document-updated`) without a `host/` prefix. The payload is the Host argument list, element for element through JSON, without projection, redaction, or renaming.
- `api/remotes` registers the Host source with API Gateway. Gateway reserves internal logical endpoint `$events` on the existing `/api/remote.mux`, adding no physical connection and giving API Proxy no event interpretation. Waterfall results return through HTTP unary endpoint `$events/result`.
- Event signatures have no second table. Owner packages place their Cordis `Events` declarations in Client-safe, type-only `./types` exports so both faces read the same declaration. `$on` listener parameters, result, and `next()` derive from `Events[Event]`; verbatim correspondence holds by construction.
- Only Cordis's type declarations are shared. Delivery semantics, registration, and failure handling belong to Typert.

When an `Events` member reaches a Host-only symbol such as a Service, `Agent`, or Context, the code is split until the declaration can live cleanly in `./types`. A declaration is never split between `index.ts` and `types.ts`, and `types.ts` does not invent a structurally equivalent shadow type. Every current owner exposes its selected event declaration from a Client-safe type export.

All allowlisted events use this path, and dedicated frames and Client aliases are removed. Model consumers subscribe directly to `llm/adapters-updated` and `settings/document-updated`; preset consumers subscribe to `agent-preset/selected`; stateless Session and dynamic-Cordis notifications use `emit`; Approval and Question use Agent-scoped `waterfall`. Data that needs a baseline, projection, or deduplication retains a dedicated Remote stream.

`skills/change`, `tools/change`, and `system-prompt/change` have the same pure invalidation form but no shipped consumer. The rule that every abstraction needs a current owner and need keeps them outside the allowlist; they remain only an extension point recorded here.

### Consumer contract (`dsh-typert-protocol`)

Type metadata adds event-form predicates, mode entries, a selection seat, and one member of `TypertClientRemote`, with no runtime code:

```ts ignore-check
import type { Events } from '@deepseek-ai/cordis'

type TypertForwardingMode<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? TypertEventResult<Event> extends void ? 'emit' : never
    : TypertWaterfallEvent<Event> extends never ? never : 'waterfall'

/** Cordis event names that can cross the Remote Event carrier without a second signature. */
export type TypertForwardableEvent = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends never ? never : Event
}[keyof Events]

/** Event and dispatch mode accepted by the Remote Event source. */
export type TypertForwardableEventEntry = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends infer Mode
    ? Mode extends 'emit' | 'waterfall'
      ? { readonly event: Event; readonly mode: Mode }
      : never
    : never
}[keyof Events]

/** The Host assembly's forwarding selection; api/remotes' allowlist fills it, no other package does. */
export interface TypertRemoteEventSelection {}

/** `$on`'s legal keys: selected, and present in the current compilation face. */
export type TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>
```

```ts ignore-check
/** Subscribe to one forwarded Host event; the returned disposer belongs to the calling fiber. */
$on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void
```

`Events` resolves per program: the complete Host event vocabulary in a Host program and only declarations visible to the Client compilation face in a Client program. The same predicate therefore holds on both sides without bringing Host declarations into the Client.

**The contract exposes only the consumer verb.** `ClientRemoteService` registers the one internal `$events` pump as a Connection generation source when it activates, independently of whether any `$on` subscription exists. Browsers open `$events` through the shared Remote mux; in-process compositions open the same logical stream through `connection.rpc.open`. Decoding, exact item validation, and Cordis dispatch are private Gateway Client implementation. `TypertClientRemote` exposes no producer operation, so a business plugin cannot synthesize a Host event.

Each time the Host opens `$events`, the API Remotes source factory installs every allowlist listener synchronously. Gateway then yields the opening `{ type: 'ready', clientId, host: { home } }` before iterating the event source. `ConnectionController` publishes `connected` only after that item arrives, so baseline reads cannot race ahead of incremental listeners.

A physical mux disconnect ends the logical stream with `RemoteStreamCarrierError`. A Host Remote stream error, unexpected normal completion, non-ready opening item, or malformed event item also ends the current generation. Connection withdraws that generation and reopens `$events` after backoff; Gateway mux only rebuilds the physical WebSocket. Ordinary events are not replayed. State whose correctness requires recovery must provide a query, cursor, or opening baseline and cannot treat `$on` as a reliable journal.

The Client dispatches on a Cordis key private to each Remote instance. Ordinary `emit` uses `parallel()` and contains listener failures; Agent-scoped `waterfall` uses `waterfall()` on the resolved Agent Context and allows a result, rejection, or `next()` delegation. Both registration kinds belong to the calling fiber, and Host events do not trigger same-named Client-local events.

### The allowlist: one declaration read by both faces

`packages/api/remotes/src/remote-events.ts` appears in both `tsconfig.host.json` and `tsconfig.client.json` and is the allowlist's sole home. `src/types.ts` derives the type face:

```ts ignore-check
// remote-events.ts — the value
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  ...SESSION_CONTROLLER_REMOTE_EVENTS.map(event => ({ event, mode: 'emit' as const })),
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]

// types.ts — the type face, derived
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
```

Adding an event is therefore one array entry: type projection, the `$on` key set, Host dispatch mode, and the forwarding loop all derive from it. `ctx.remote.$on('slots/changed', …)` for a Client-local event and `$on('skills/change', …)` for a declared but unselected event are compile errors.

The declaration's trailing `satisfies` applies Host event-vocabulary and mode constraints to the same allowlist:

```ts ignore-check
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypertForwardableEventEntry[]
```

It enforces three properties: the name exists because the predicate is keyed by `keyof Events`; the selected mode matches the signature; and the signature is either an unscoped `void` notification or a waterfall with top-level Agent scope, a same-result `next()`, and a Promise return. Other Scope, bail, parallel, and serial forms are excluded.

Verbatim correspondence is not proved separately because it holds by construction. `$on`'s listener type and Host forwarding both read the owner package's one Cordis `Events` declaration, so no second declaration can drift.

JSON safety remains a runtime concern. Before queueing, the API Remotes Host source checks every argument with `dsh-session`'s `isJsonValue` and fails loudly when one is invalid, because this is an allowlist composition error rather than untrusted input.

### Wire protocol (API Gateway Remote mux)

```ts ignore-check
ready     { type, clientId }
emit      { type, event, args }
waterfall { type, event, eventId, agentId, request }
cancel    { type, eventId }
```

The Client opens internal logical stream `$events` with payload `{ args: {} }`. Gateway rejects extra parameters, a missing Host source, and duplicate source registration. Withdrawing a source aborts every stream opened by that registration. Each Client stream owns an independent queue and allowlist listener set in `api/remotes`, so disconnecting one Client neither consumes nor withdraws another Client's events.

The Client requires an opening `ready` item with a non-empty `clientId` and `host.home`; every later item is checked for exact fields by discriminant. The ready item establishes the Connection generation and supplies the stable Host path-display fact. An ordinary `emit` with an unknown but structurally valid event name is dropped when there is no subscriber. Waterfalls use `eventId` to correlate `$events/result` and `agentId` to select a Client Agent Context. The Client returns only values representable as lossless JSON; transport does not reinterpret business fields.

`$events` is an internal Gateway endpoint. It does not enter a generated Typert Remote descriptor or become `ctx.remote.<namespace>`. Application selection exists only in the API Remotes allowlist and Host source; Gateway owns registration, payload validation, and physical transport only.

### The `apps/web` browser e2e belongs to the Host face

The `apps/web/tests/**` e2e files typecheck in root `tsconfig.host.json`: they boot a real harness in process and directly access `ctx.connection`, Host `SessionStore.get/create/flush`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not place a file in the Client TypeScript program. Moving these tests to the Client aggregate produces errors because one program cannot hold both faces' merges for the same Context key.

This implies one build rule needed by the design: importing a value or type from a Client package in those tests brings that package's whole project and all its project references into the Host build graph. Four consumers (`ui-settings-general`, `ui-settings-models`, `ui-permission`, and `ui-commands`) reference API Remotes' Client face, which cannot compile until Host tsdown generates `@deepseek-ai/dsh-goal/remote`. That forms a build-order cycle: Host tsc needs API Remotes Client, which needs generated `goal/remote`, which Host tsdown emits after Host tsc.

The few required Client symbols are mirrored on the test side: `scaffold.ts` exports the mirrored welcome-notice constants, while the two chat e2e files import `dsh-client-runtime/client` directly because the Runtime project already belongs to the Host graph. This removes those four consumers from the Host graph, and the 15 Client project references in `apps/cli/tsconfig.json` no longer serve an owner-map role. Each mirror is byte-identical to its source; drift produces a selector mismatch or an unsuppressed notice and fails loudly.

### Change inventory

| Location | Change |
|---|---|
| `dsh-typert-protocol` | `src/types.ts` provides forwardable-mode derivation, selection, and Client-listener projection; `TypertClientRemote` exposes only `$on`. Types only, no runtime |
| `api/gateway` | Host provides one Remote event source, `$events`, pending-waterfall coordination, and `$events/result`; Client registers the private pump as the Connection generation source and owns frame validation and Cordis dispatch |
| `api/remotes` | `src/remote-events.ts` (mode-bearing allowlist value) and `src/types.ts` (key projection and selection) belong to both faces; Host registers each Client source and validates JSON before queueing; Client continues to compose generated Remote contributions |
| Root `tsconfig.base.json` | Adds source-plane `paths` entries for `dsh-settings/types`, `dsh-credentials/types`, and `dsh-api-remotes/types` |
| `dsh-commands` / `dsh-settings` / `dsh-credentials` | Moves each `interface Events` member to the owner's Client-safe `./types`; settings and credentials add that export, move brands and pure types with it, retain constructors in index, and include `lib/types/**/*.js` in published files |
| `dsh-session` | Exposes `isJsonValue` for validation of every event argument by the API Remotes Host source |
| `client/runtime` | Removes the bridge from Host frames to the Remote subscription table; it only publishes `connection/reset` after a Connection generation is established |
| Consumers | Client plugins subscribe directly through `ctx.remote.$on(...)`, import owner event declarations type-only, and inject `'remote'` |
| `client/connection` | Provides the one generation-source registration point; `ConnectionController` publishes the Host facts from `$events` ready, and the fixture emits events from the same source |
| `apps/web/tests` + `apps/cli` | Mirrors Client symbols on the test side as described above and removes 15 Client project references from `apps/cli/tsconfig.json` |

## Alternatives considered

**Continue using API Proxy's Host downlink.** This reuses Connection generation and `connection/reset` but leaves the Remote event allowlist, queue, schema, and Client Runtime bridge in API Proxy and prevents domain transports from sharing the lifecycle of other Remote streams. With API Gateway's resident `/api/remote.mux`, `$events` adds only one internal logical stream and belongs naturally in Gateway.

**Open a third physical WebSocket or duplex stream for Remote events.** An independent channel could own connection state but would duplicate authenticated upgrade, multiplexing, cancellation, error mapping, and reconnect backoff already provided by Gateway mux. Internal `$events` retains an independent logical stream, while waterfall results reuse HTTP unary calls.

**Declare a separate `TypertRemoteEventMap` in type metadata and let owner packages declaration-merge into it.** The consumer key set would exactly equal remotely deliverable events, but every signature would be written again outside Cordis `Events`, requiring a bidirectional equivalence proof and new type-metadata dependencies for owner packages. Sharing one `Events` declaration makes equivalence structural, so the second map is not created.

**Have the Typert generator project Host `Events` declarations.** The generator already analyzes Host events, but it cannot infer projection or redaction intent and would expand the generator and build surface. Verbatim forwarding needs no projection.

**Give forwardable events a payload projection function.** A `{ event, project, zod }` table could combine model-directory inputs and derive Workspace views, but would manually align projection logic with payload types and recreate the central table removed from Remote methods.

**Move the `apps/web` browser e2e into the Client aggregate.** The intuition that browser tests belong to the Client face fails with 21 errors because the tests use Host services while the Client program's `ctx.sessions` is `ISessions`.

**Split `directory-picker-browse`/`-native` into Host and Client faces.** This would remove Client packages from the Host graph, but changes another owner's packages for only a cleaner build graph. Mirroring the required Client symbols on the test side removes the need for that split.

## Verification

- A real Host-source composition test proves that two Client streams each receive `{ event, args }`, disconnecting one does not affect the other, and non-JSON arguments fail loudly without poisoning later valid delivery.
- Type negatives reject unselected events, non-`void` unscoped events, non-Agent-scoped waterfalls, and allowlist modes that disagree with signatures. `$on('slots/changed', …)` and `$on('skills/change', …)` both fail to compile, so `$on`'s key set equals the allowlist.
- Consumer `$on('settings/document-updated', …)` resolves `ns` as `SettingsNamespace`, preserving the brand across the wire.
- A `$on` disposer belongs to the calling fiber, and registering the same function object twice produces independently removable registrations; subscriptions are addressed by registration rather than listener identity.
- Ordinary notifications contain both a throwing listener and a listener returning a rejected Promise. Waterfall tests pin Client result, `next()`, rejection, cancellation, first claim across multiple Clients, and reconnect replay of a pending request.
- Gateway tests cover missing, duplicate, and withdrawn sources; payload rejection; ready-before-event ordering; and browser and in-process carriers. Client tests cover generation-source registration, description/increment readiness order, reopen after physical failure, Host errors and unexpected completion, non-ready opening items, malformed event items, `$events/result` failure, and disposal quiescence.
- `host/remote-event`, public `$dispatch`, the Client Runtime bridge, and API Proxy's allowlist dependency are absent; consumers observe owner events directly.

## Consequences

- **Gateway has one non-generated endpoint.** `$events` has no business namespace and does not enter the Typert descriptor. It is the internal connection point between Gateway and API Remotes and defines the Client Connection generation lifetime. Strict empty-payload validation, opening-ready validation, and single-source registration prevent it from becoming another handwritten business API.
- **Two files break API Remotes' face-disjointness rule.** `src/remote-events.ts` and `src/types.ts` belong to both projects and emit identical declarations into shared `lib/types`. Their content is byte-identical and `.tsbuildinfo` files remain separate, so this is safe in practice; the README records why source-plane `paths` require the exception.
- **Producer operations remain private.** Business plugins can call only `$on`. Host-source registration and Client dispatch are absent from `TypertClientRemote`; test doubles drive subscriptions through their own `emit` operations rather than impersonating a production API.
- **Malformed arguments fail at emit.** An API Remotes listener throws before queueing, so Host `ctx.emit` immediately observes an allowlist composition error and the queue can still deliver subsequent valid events.
- **Test-side mirrors can drift.** No mechanism compares mirrored Client constants under `apps/web/tests` with their source. Drift instead produces a selector mismatch. `apps/web/tests/README.md` records the review rule; a grep-level gate is deliberately omitted.
- **Capabilities deliberately omitted.** Payload projection and redaction are unsupported, scopes other than Agent are unsupported, and ordinary notifications are not replayed. Recoverable state needs a query, cursor, or opening baseline; a waterfall is replayed only while its original Host invocation remains pending.
- **Some Client packages remain in the Host graph.** Twelve projects, including `connection`, `runtime`, and `ui-slots`, remain reachable through unsplit `directory-picker-browse`/`-native` and `api/gateway → client/connection`. They compile and no longer pull in API Remotes' Client face, so this change does not split them. Direct `dsh-client-runtime/client` imports in two chat e2e files rely on Runtime's current presence in that graph rather than a general guarantee.
- **The package intentionally publishes no invariant companion.** A prior revision asserted delivery form on the live event bus, coupling diagnostics to the allowlist and causing Rolldown to emit a third bundle chunk omitted by the mechanically derived publication list. The Host-face `TypertForwardableEventEntry` assertion already rejects those mismatches at compile time, and the package README records why no independent runtime relation remains.
