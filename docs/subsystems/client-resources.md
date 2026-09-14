# Client Resources

English | [中文](client-resources.zh.md)

The client resource model turns an address into live data for any Web Client component. [`dsh-client-resources`](../../packages/client/resources/README.md) provides the `ctx.resources` service and the `useResource` global standard hook; a package that owns a kind of content registers one **provider** for its **protocol**, and a component reads the content's current state by **address** without importing the owner's runtime. The right Sidebar's tabs are the model's first consumer ([Right Sidebar](sidebar-right.md)); the decision record is the [client resource model Agent Note](../../.agents/notes/implemented/architecture/2026-09-05-client-resource-model.md).

This page is the developer reference: how to write an address, how to register a provider, how to read a resource, what the states and failures mean, and how the model holds and releases a resource.

## Addresses

A resource address is a `dsh-resource://<type>/…` URL. The host names the protocol and must be a key of `ResourceProtocolMap`; the path is the protocol's own, and its owner percent-encodes each segment. A protocol that needs a scope puts it in the path: the `file` protocol's addresses read `dsh-resource://file/session/<sessionId>/<path>`, where path is workspace-relative or absolute with its leading slashes preserved, built with `fileAddressFor(sessionId, cwd, path)` and read back with `parseFileAddress(address)` from [`dsh-util-workspace-path`](../../packages/util/workspace-path/README.md). The model itself reads only the scheme and the host: `protocolOf(address)` returns the lower-cased host of a `dsh-resource://` URL and `undefined` for anything else. Addresses under any other scheme — the Sidebar's `sidebar://guide` — name no resource and read as `none`.

| Address | Protocol key | Reads as |
|---|---|---|
| `dsh-resource://file/session/s1/notes/a.md` | `file` | the metadata of `notes/a.md` under session `s1`'s workspace root, when the `file` provider is registered |
| `dsh-resource://file/absolute/home/me/notes.md` | `file` | parseable but fails with `workspace-file/unknown-workspace`: no authorizing Session, and neither current nor Tab Session is borrowed |
| `DSH-RESOURCE://File/session/s1/a` | `file` | a distinct record: addresses compare as strings, and `openResource` accepts only the canonical lower-case spelling that `fileAddressFor` emits |
| `sidebar://guide` | — | `none`: a navigation address |
| `/home/me/notes.md` | — | `none`: not a URL |

## Registering a provider

The owner of a protocol declares its value type on `ResourceProtocolMap` and registers one provider inside its own `ctx.effect`, so the protocol lives exactly as long as the plugin ([provide a protocol](../../packages/client/resources/README.md#provide-a-protocol)). `open(address, { signal })` returns a stream of `RemoteResult` frames — the current state first, then one frame per change — and must stop when `signal` aborts. A failure is an `ok: false` frame carrying a `RemoteFailure`; a throw inside the stream is a programming error and is not caught.

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-resources/client'

interface NoteView { readonly title: string; readonly updatedAt: string }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { note: NoteView }
}

export const inject = ['resources', 'remote']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.resources.register<'note'>({
    protocol: 'note',
    async *open(address, { signal }): AsyncIterable<RemoteResult<NoteView>> {
      const id = new URL(address).pathname.slice(1)
      yield await ctx.remote.notes.read(id, signal)
      for await (const change of ctx.remote.notes.follow(id, signal)) yield change
    },
  }), 'my-notes: note resource provider')
}
```

A protocol has exactly one provider; a second registration throws. Registering while addresses of the protocol are already held opens their streams at once; disposing the provider ends those streams and the addresses read `none` until a provider returns.

## Reading a resource

Every slot component receives `useResource` in its props, whatever its scope ([Slots](slots.md)). `useResource<P>(address)` names the protocol as the type argument and returns the address's current snapshot; subscribing is what holds the resource open, and a component that mounts while another holder keeps the resource alive reads the latest value at once without reopening the stream ([read a resource](../../packages/client/resources/README.md#read-a-resource)).

| `status` | Meaning | `value` | `failure` |
|---|---|---|---|
| `none` | No provider is registered for the address's protocol, or the address is not a resource address | `undefined` | `undefined` |
| `loading` | The provider's stream is open and has not yielded yet | `undefined` | `undefined` |
| `live` | The latest frame succeeded | the latest `ok` value | `undefined` |
| `failed` | The latest frame reported a failure | the last `ok` value, kept | the frame's `RemoteFailure` |

```tsx ignore-check
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'

type Props = PropsRuntime<'sidebar.right.pane.tab'>

export function FileHeader({ useTabInfo, useResource, t }: Props) {
  const { tab } = useTabInfo()
  const meta = useResource<'file'>(tab.contentId)
  if (meta.status === 'failed') return <p role="alert">{t('failed', { code: meta.failure.code })}</p>
  return (
    <header>
      {tab.title}
    </header>
  )
}
```

A consumer presents `failed` itself: the model keeps the last value beside the failure so a body can show stale content with a notice rather than a blank, and the next `ok` frame clears the failure. Nothing in the model produces user-visible text.

## Holding and releasing

A resource is alive while it has a holder: a subscribed `useResource`, or a pin. `ctx.resources.pin(address, signal)` keeps a resource open without subscribing until `signal` aborts, and an already-aborted signal pins nothing; the right Sidebar pins every open tab record's address for the record's life, so switching tabs unmounts a body without closing its stream. The first holder opens the provider's stream; the last release aborts it, discards the value, and returns the snapshot to `loading` (provider present) or `none` (absent). A frame the provider yields after that release is dropped, and the iterator is returned. `ctx.resources.source(address)` is the bare observable behind the hook, reference-stable per address, for callers outside React; reading its snapshot does not hold the resource ([lifecycle](../../packages/client/resources/README.md#lifecycle)).

Streams carry metadata, not content. The `file` provider's value is `WorkspaceFileStat { absolutePath, version, bytes? }`: the first frame comes from Host `stat`, and later observations update the version. A consumer reads content through the Workspace Files Remote namespace; Preview owns refresh independently per tab ([`dsh-api-workspace-files`](../../packages/api/workspace-files/README.md)).

## Limits

Records live for the page lifetime: an address's record stays after its last holder leaves, holding no stream and no value, so memory grows with the number of distinct addresses ever read. A provider that ignores `signal` keeps running until its next frame. The failure type is the Remote face's `RemoteFailure`, so a provider whose source is not a Remote call mints one. A misspelled protocol or a malformed address reads as `none` with no other diagnostic.
