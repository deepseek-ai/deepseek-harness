---
description: "Client resource model: protocol-registered providers turn URL addresses into live values that any slot component reads through the useResource standard hook."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-resources

English | [中文](README.zh.md)

## Summary

Use client resources when a component knows live data only by URL address, such as a tab record, link, or mention, while another client package owns the data. Resource addresses use `dsh-resource://<type>/…`; protocols that need a scope encode it in the path. Components receive the current value and later updates through the public `useResource` hook. Unsupported protocols and non-resource schemes, such as `sidebar://guide`, resolve to no resource.

## Table of Contents

- [Use this package](#use-this-package)
  - [Read a resource](#read-a-resource)
  - [Provide a protocol](#provide-a-protocol)
  - [Hold a resource open](#hold-a-resource-open)
- [Understand the implementation](#understand-the-implementation)
  - [Lifecycle](#lifecycle)
  - [Failures](#failures)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Nothing needs configuration to mount: the plugin provides `ctx.resources` and contributes the `resource` root keyed hook through `ctx.slots.provideRoot`, so every slot component receives it whatever its scope.

<a id="read-a-resource"></a>
### Read a resource

Every slot component receives `useResource` in its props. `useResource<P>(address)` names the protocol as the type argument and returns `{ status, value, failure }`: `none` when no provider is registered for the address's protocol (or the address is not a `dsh-resource://` URL), `loading` while the provider has not yielded, `live` with the latest `ok` frame's value, and `failed` when the latest frame reported a failure, with that failure beside the last value. Subscribing through the hook is what holds the resource open; a component that mounts while another holder keeps the resource alive reads the latest value at once.

<a id="provide-a-protocol"></a>
### Provide a protocol

The protocol's owning client package declares its value type in `ResourceProtocolMap` and registers one provider as an owned effect. `open` yields `RemoteResult` frames: the current content first and one frame per later change, with a failure as an `ok: false` frame rather than a throw; it must stop when `signal` aborts:

```ts ignore-check
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { note: NoteView }
}

export const inject = ['resources']

export function apply(ctx) {
  ctx.effect(() => ctx.resources.register<'note'>({
    protocol: 'note',
    async *open(address, { signal }) {
      yield await readNote(address, signal)
      for await (const change of followNote(address, signal)) yield change
    },
  }), 'my-notes: note resource provider')
}
```

A protocol has exactly one provider; a second registration throws. Registering a provider while addresses of its protocol are already held opens them; disposing it ends their streams and returns them to `none`.

<a id="hold-a-resource-open"></a>
### Hold a resource open

`ctx.resources.pin(address, signal)` keeps a resource open without subscribing, until `signal` aborts. The right Sidebar pins every open tab's address for the tab record's lifetime, so switching tabs unmounts the body without closing its stream and switching back reads the latest value. `ctx.resources.source(address)` is the bare observable behind the hook, for callers outside React.

<a id="understand-the-implementation"></a>
## Understand the implementation

<a id="lifecycle"></a>
### Lifecycle

One record per address holds a snapshot store, a holder count (hook subscribers plus pins), and the running stream's `AbortController`. The first holder opens the provider's stream; every later holder shares it; the last holder's release aborts the stream and resets the snapshot to idle (`loading` with a provider, `none` without). Records are kept for the page lifetime so `source()` stays reference-stable across React's render-then-subscribe window and a StrictMode remount.

<a id="failures"></a>
### Failures

A failure is a frame, not a throw: a provider yields `{ ok: false, error }` and the resource turns `failed` with that error beside the last value; the next `ok` frame clears it. A stream that ends on its own keeps its last state. Frames that arrive after the release that aborted the stream are dropped, and the iterator is returned. A throw inside a provider's stream is a programming error and is not caught.

<a id="model-experience"></a>
## Model Experience

None, as this package moves values between browser plugins and registers nothing model-facing.

#### KV Cache effect

None; resource streams do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Records live for the page lifetime** — an address's record stays in the registry after its last holder leaves; only its state is discarded. Memory grows with the number of distinct addresses ever read, not with reads.
- **Providers own abort compliance** — the registry drops what a released stream still yields, but a provider that ignores `signal` keeps working until its next frame.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Provider ownership and holder counts have one owner, the registry, with no independent runtime source to compare against; registration disposal and the open/close lifecycle are asserted by behavior specs.
