# Agent Note: Client resource model

Status: implemented

English | [中文](2026-09-05-client-resource-model.zh.md)

## Problem

A right-Sidebar tab body, a chat card, or any other slot component often needs live data it knows only by address: the file an agent just wrote, later a chat node or a terminal. Before the resource model each consumer fetched for itself — the text preview owned its own Remote call and refresh loop — so every mount re-read, two components showing one file held two copies, switching tabs unmounted the body and lost its content, and each new kind of content meant a new bespoke hook.

The tab record set the constraint. A tab must survive undo, redo, body remount, and hot module replacement without the code that opened it, so the record can hold only serializable data: an address and navigation parameters. Browser-page reload resets the memory-only Sidebar state. The opener therefore cannot hand a body its data, and injection is the wrong tool — injection is a registration-time relation between a domain and a seat, while opening is a runtime event. A component has to find its data from the address alone, through something registered once by whoever owns that kind of data.

## Decision

[`packages/client/resources`](../../../../packages/client/resources/README.md) (`@deepseek-ai/dsh-client-resources`) provides `ctx.resources` and the `useResource` global standard hook. Anything a consumer reads live is a **resource**, a resource is identified by its **address** and nothing else, and the address's protocol names the one **provider** that turns it into a frame stream.

### Addresses

A resource address is a `dsh-resource://<type>/…` URL. The host is the protocol key — the key of `ResourceProtocolMap` — and the path belongs to the protocol's owner. `RESOURCE_SCHEME = 'dsh-resource'` is the one scheme constant; `protocolOf(address)` parses the string with `new URL`, requires `protocol === 'dsh-resource:'`, and returns the lower-cased host, or `undefined` for a string the parser rejects, another scheme, or an empty host. `dsh-resource` is not one of the URL specification's special schemes, so the parser keeps the host's case and treats the path as opaque; the lower-casing is explicit, and each path segment is percent-encoded by the protocol that defines it. A protocol that needs a scope encodes it in the path: `dsh-resource://file/session/<sessionId>/<path>`, with `session/<sessionId>` naming the Session whose Host workspace resolves the relative or absolute path ([grammar](../../../../packages/util/workspace-path/README.md)). Any other scheme — `sidebar://guide` — is a navigation address: it names a tab, not data, and the model answers `none` for it ([tab types and navigation](2026-09-05-sidebar-tab-types-and-navigation.md)).

### The service

```ts ignore-check
interface Resources {
  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void
  pin(address: string, signal: AbortSignal): void
  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>>
}

interface ResourceProvider<P extends ResourceProtocol> {
  readonly protocol: P
  open(address: string, ctx: { readonly signal: AbortSignal }): AsyncIterable<RemoteResult<ResourceProtocolMap[P]>>
}

interface ResourceSnapshot<Value> {
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  readonly value: Value | undefined
  readonly failure: RemoteFailure | undefined
}

type UseResource = <P extends ResourceProtocol>(address: string) => ResourceSnapshot<ResourceProtocolMap[P]>
```

`register` owns exactly one provider per protocol: a second registration for the same protocol throws, and the registration is an effect on the registering plugin's fiber, so a protocol leaves with its plugin and may be registered again afterwards. `pin` holds a resource open without subscribing until the signal aborts; an already-aborted signal pins nothing. `source` is the bare observable behind the hook, reference-stable per address, for callers outside React. The value type is looked up in `ResourceProtocolMap`, declared as an empty interface in `ui-slots` beside `SlotMap` — a module augmentation cannot introduce an export the target module lacks, and every consumer already depends on `ui-slots` — and each protocol's owner declaration-merges its member (`file: WorkspaceFileStat`); the resources package re-exports the type.

### The hook

`useResource` is declared on `GlobalStandardProps` in `ui-slots`, so every slot component has it whatever its scope, and the plugin provides it through `ctx.slots.provideRoot({ keyedHooks: { resource: address => resources.source(address) } })`, the same root keyed-hook path `useSessions` uses. It is not a session standard prop: a resource carries its own scope in its address, and components outside any session scope read resources too. `useResource<P>(address)` returns the snapshot: `none` when the address's protocol has no provider or the address is not a resource address, `loading` between the stream opening and its first frame, `live` with the latest `ok` value, `failed` with the latest frame's failure beside the last value.

### Frames

A provider yields `RemoteResult` frames: the current state first, one frame per later change. An `ok` frame makes the resource `live`, replaces the value, and clears the failure; an `ok: false` frame makes it `failed`, records the failure, and keeps the last value. Failure is data, not an exception: the Remote face already folds failures into `ok: false` and never rejects, providers pass those frames on, and the model neither catches nor wraps — a throw inside a provider's stream is a programming error left to surface. A stream that ends on its own keeps its last state; frames a provider yields after the release that aborted it are dropped and the iterator is returned. Streams carry metadata, not payload: the `file` value is `{ absolutePath, version, bytes? }`, and a consumer reads content itself through the [Workspace Files service](2026-09-05-workspace-files-service.md).

### Lifecycle

One record exists per address. Holds start and stop observation, not the underlying file or Session. Its holders are the hook's subscribers plus pins; the first holder opens the provider's stream under an `AbortController`, later holders share it and read the latest value at once, and the last release aborts the stream and resets the snapshot to idle — `loading` while a provider is registered, `none` otherwise. A provider that arrives while an address is already held opens that address's stream; one that leaves aborts it and the address reads `none`. Records are kept for the page lifetime so `source(address)` stays reference-stable across React's render-then-subscribe window and a StrictMode remount, where a recreated record would resubscribe and restart the stream on every render.

The right Sidebar's Tab domain pins every open tab record's address for the record's life, so switching tabs unmounts a body without closing its stream and switching back reads the latest value; a record restored by undo is a new pin, and a resource the model already let go is read again ([tab types and navigation](2026-09-05-sidebar-tab-types-and-navigation.md)). `openResource(address)` accepts resource addresses only; pages such as the guide and the file tree are opened by kind and never enter the resource model.

## Alternatives considered

**Session-bound resources: `useResource` on the session kit and a `(session, address)` identity.** The first form. Rejected because a file is not a session concern — the session is only who authorizes the path — and because the model must serve protocols and components outside any session scope. Identity became the address alone, the scope moved into the address grammar, and the hook moved to the global kit.

**Content in the resource stream.** Rejected: content can be arbitrarily large, and a stream is for pushing change, not payload. The stream carries metadata and the consumer chooses how much content to read and retain.

**Failure as a thrown error, wrapping a non-`RemoteFailure` throw as `gateway/internal`.** Rejected: the Remote face never rejects, so anything a provider throws is a bug, and wrapping it would be a fallback that hides the bug from the developer who caused it. A failure is an `ok: false` frame; a throw surfaces.

**`file:/<scope>/<id>/<path>`, then `file://<scope>/<id>/<path>` with the scope in the authority.** Two earlier grammars. The single-slash form was not a URL the platform parser accepted, so every consumer hand-parsed it. Moving the scope into the authority made it a URL but gave each resource protocol its own scheme — `file://`, later `chat://`, `terminal://` — so the set of schemes grew with the set of protocols, a `file://` address no longer meant what it means everywhere else, and telling a resource address from a navigation address needed a list. The single `dsh-resource://<type>/…` scheme makes that test one comparison, leaves the host free to name the protocol, and keeps every other scheme available to navigation.

**A hand-parsed scheme prefix instead of the URL parser.** The first `protocolOf` matched a regular expression for the scheme. Rejected once addresses were URLs: the parser already decides validity and case, and a string it rejects should read as "no protocol" rather than be half-parsed.

**A per-tab stream hook, or a framework-managed `useTabResource(fetch)`.** Rejected in turn: a stream hook on the tab domain asks the wrong owner — `file` data must come from the workspace file service, chat data from the chat domain — and a framework-owned fetch has no good cache key. What remains is the framework-bound `useTabInfo` on the tab plus one client-wide `useResource` keyed by address.

## Consequences

Any slot component reads live data by address and nothing else, so an opener passes data only and a body reconstructs itself from its record after undo, body remount, or hot replacement. Two components showing one address share one stream, and a pinned address survives its body's unmount. A protocol's transport lives in exactly one provider, and adding a protocol is one declaration-merged type plus one registration.

The costs are recorded here so they are not rediscovered. Records are never reclaimed: memory grows with the number of distinct addresses ever read, not with reads. Abort compliance rests with the provider; the model drops what a released stream still yields but cannot stop a provider that ignores the signal before its next frame. The failure type is the Remote face's `RemoteFailure`, so a provider whose source is not a Remote call has to mint one. A navigation address or a malformed string reads as `none` rather than an error, which keeps mixed address lists cheap to render but gives a misspelled protocol no diagnostic beyond the missing value.

## Testing

`packages/client/resources/tests/resources.client.spec.ts` drives the registry with scripted feeds: protocol ownership and disposal, `none` for a protocol without a provider and for a navigation address, a provider arriving after a held address and leaving while it is held, registrations dropped with their fiber, open-on-first-holder and close-on-last, one source per address, pins including an already-aborted signal, a remount reading the latest value without reopening, reopening as a fresh stream, frames after abort dropped with the iterator returned, a stream ending on its own, and failure frames beside the last value. `tests/apply.client.spec.ts` mounts the plugin in `SlotTestRuntime` and checks, through a root-scope probe component, that `useResource` reaches props, that rendering it opens the provider's stream, and that disposing the plugin withdraws both the service and the hook.

## Deferred

Reclaiming idle records, a resource-owned failure type decoupled from the Remote face, and the `chat` and `terminal` protocols are open; each waits for a consumer. The developer-facing reference is [docs/subsystems/client-resources.md](../../../../docs/subsystems/client-resources.md); the Sidebar that consumes the model is described in [docs/subsystems/sidebar-right.md](../../../../docs/subsystems/sidebar-right.md).
