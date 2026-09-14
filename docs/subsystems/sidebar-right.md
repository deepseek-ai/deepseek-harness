# Right Sidebar

English | [中文](sidebar-right.zh.md)

The right Sidebar is the Web Client's per-Session docking surface: a column of panes and tabs beside the conversation in which addressed content — a workspace file, a directory tree, the product's own pages — opens, splits, floats, and closes. [`dsh-client-ui-sidebar-right`](../../packages/client/ui-sidebar-right/README.md) owns the surface, the tab-type registry, and the navigation service; [`dsh-client-ui-dockkit`](../../packages/client/ui-dockkit/README.md) is its internal layout engine; [`dsh-client-resources`](../../packages/client/resources/README.md) turns addresses into live values for any component; [`dsh-api-workspace-files`](../../packages/api/workspace-files/README.md) provides both the Host workspace service and the Client `file` resource provider.

This page is the reference for the subsystem's contracts: addresses, tab-type registration, the navigation service, the extension slots and their owner props, the resource model, the Workspace Files service, the shipped types, and what is deliberately not built. How the layout engine, the frame, and the surface fit together is in the [Agent Note](../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md); slot mechanics are in the [Slots reference](slots.md).

## Position and ownership

One docking surface exists per Session, held in a session-scoped slot store and drawn by `rightbar.session`. The root-scoped `rightbar` controller mounts that seat only while Conversation is selected; a reload returns every session to the collapsed default, and switching sessions keeps each surface where it was ([state](../../packages/client/ui-sidebar-right/README.md#state)). The surface's every change is one recorded history entry computed by the kit's pure planners; a docked pane never stays empty, and an empty root pane receives the default page selected from registered guide entries.

A tab type is two registrations that share the definition's `id`: a static definition in `ctx.sidebarRightTabs` saying which addresses its `kind` opens, and a keyed slot registration supplying its body. The framework injects `useTabInfo()` for live Sidebar, pane and tab information; each type keeps its own state in its slot store. Packages import each other's declarations only as types.

| Package | Role |
|---|---|
| [`client/ui-sidebar-right`](../../packages/client/ui-sidebar-right/README.md) | The panel and rail seats, the layout store, `ctx.sidebarRightTabs`, `ctx.sidebarRight`, the Tab domain, the guide type |
| [`client/ui-dockkit`](../../packages/client/ui-dockkit/README.md) | Pure layout engine and React surface; an internal dependency of `ui-sidebar-right`, not a stable interface |
| [`client/resources`](../../packages/client/resources/README.md) | `ctx.resources`, `useResource`, the protocol → value roster `ResourceProtocolMap` |
| [`api/workspace-files`](../../packages/api/workspace-files/README.md) | Host `ctx.workspaceFiles`, the `workspaceFiles` Remote namespace, and the Client `file` resource provider |
| [`util/workspace-path`](../../packages/util/workspace-path/README.md) | The file address grammar: `fileAddressFor`, `parseFileAddress` |
| [`client/ui-sidebar-documentpreview`](../../packages/client/ui-sidebar-documentpreview/README.md), [`client/ui-sidebar-files`](../../packages/client/ui-sidebar-files/README.md) | The shipped `text` and `files` types |

## Addresses

Every tab is opened by an address string, and the address is the tab's content identity. Two families exist.

A **resource address** is a `dsh-resource://<type>/…` URL. The host names the resource protocol — the key of `ResourceProtocolMap` — and everything after it is the protocol's own path; one scheme serves every protocol, so adding a protocol adds a host, never a scheme. The `file` protocol's path opens with its scope: `session/<sessionId>` followed by the path relative to that session's workspace root (`dsh-resource://file/session/abc/src/notes.txt`), or `absolute` followed by the absolute path with its leading `/` dropped (`dsh-resource://file/absolute/home/ys/notes.txt`, `dsh-resource://file/absolute/C:/x/y.txt` on Windows). Every id and path segment is component-encoded, with `:` kept literal for drive letters. `fileAddressFor(sessionId, cwd, path)` builds one — a relative path or an absolute path inside the workspace becomes `session`-relative, any other absolute path becomes `absolute` — and `parseFileAddress(address)` reads it back or returns `undefined` ([grammar](../../packages/util/workspace-path/README.md)).

A **page address** is what the Sidebar records for a tab opened by kind rather than by resource: `sidebar://<kind>`, written by the Sidebar itself when `openTab(kind)` runs. Callers never build one — the guide and the file tree are opened as `openTab('guide')` and `openTab('files')` — and no other navigation address exists ([not built](#not-built)).

Tab identity is the pair `(kind, address)`: the registry's claim uses the address verbatim as the record's `contentId`, so opening the same address through the same type finds the existing tab, and the same address through two types is two tabs.

## Tab-type registration

`ctx.sidebarRightTabs.register(definition)` registers one implementation of a type for the caller's lifetime and returns the disposer; the caller holds it inside its own `ctx.effect`, so an implementation lives exactly as long as the plugin that contributed it, and a second registration of the same `id` throws ([extension seats](../../packages/client/ui-sidebar-right/README.md#extension-seats)). The definition is static: no runtime hook, nothing per tab or per session.

| Field | Meaning |
|---|---|
| `id` | The implementation's identity, unique across every registration; a package name is the natural value (`@deepseek-ai/dsh-client-ui-sidebar-files`). It is the key the body and title register under. |
| `kind` | The type's discriminator: what its tabs are, and what `openTab` names. Not unique — an extension may take over a builtin's kind. The shipped kinds are `guide`, `text`, `files`. |
| `patterns` | Optional resource-address globs the type recognizes; a page type opened by kind omits them. A pattern containing `:` matches the whole address (`dsh-resource://file/**`); one without matches the URL's path at any depth (`*.md`), and an address that is not a URL matches no such pattern. Matching is case-insensitive and does not hide dotfiles; the syntax is picomatch's POSIX dialect. |
| `priority` | One of three literal bands: `extension` (the default and the highest: a type from outside the product outranks every shipped viewer), `builtin` (types shipped with the product), `fallback` (plain-content viewers anything more specific should beat). |
| `canOpen(address)` | Optional synchronous veto of a glob match; it runs on every routing decision. |
| `title(address)` | The chip's text, captured into the layout record when the tab opens and never rewritten. |
| `guide` | Optional entry boxes for the guide page: `{ order, title(), description?(), icon? }`. Picking a box opens the contributing type as a page; omit to stay off the page. |

Routing is a ranked claim. `candidates(address)` ranks the types whose patterns match and whose `canOpen` does not veto: by band, then by the length of the longest matched pattern, then by registration order. `claim(address, kind?)` picks the first candidate, or the named `kind` outright — its globs are skipped, its `canOpen` still applies — and returns `{ kind, contentId: address, title }`. An address no type claims throws: it is a wiring mistake, not a user error.

One `kind` may carry one `builtin` and one `extension` registration at the same time. The extension is the one in force for claims, `get(kind)`, `openTab(kind)`, and the guide page, and the seat finds a tab's body and title under the definition in force's `id`, so no slot priority is involved; when the extension unregisters, the builtin resumes. Every other collision on a kind, and every duplicate `id`, throws.

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const inject = ['sidebarRightTabs', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: '@acme/dsh-client-ui-image',
    kind: 'image',
    patterns: ['*.png', '*.jpg', '*.gif', '*.svg'],
    canOpen: address => address.startsWith('dsh-resource://file/'),
    title: address => address.slice(address.lastIndexOf('/') + 1),
  }), 'image type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: '@acme/dsh-client-ui-image' },
    ImageBody,
  )), 'image body')
}
```

## Navigation: `ctx.sidebarRight`

Two opens are the navigation controller, and every way into the column calls one of them: `openResource(address, options?)` for a `dsh-resource://` address — the conversation's file links, a tool row's line reference, a file tree's rows — and `openTab(kind, options?)` for a page — the strip's add control, a guide entry box. Both run four steps as one history entry — claim (the registry ranks the resource's types, or the named `kind`'s implementation in force answers); focus a tab already showing the same `(kind, address)`; otherwise seat a new tab; expand the column — and then record the navigation in the Tab domain ([service](../../packages/client/ui-sidebar-right/README.md#ctxsidebarright)). Content the user cannot see is not opened, so a collapsed column expands in the same step. `openResource` throws for an address outside `dsh-resource://` or one no type claims; `openTab` throws for a kind nothing registered: both are wiring mistakes, not user errors.

| Option | Meaning |
|---|---|
| `paneId` | Land a new tab in this pane; default is the active docked pane (the first docked pane while a floating pane is active). |
| `replaceTab` | Take this tab's pane and strip slot, closing it in the same step; a floating tab lends no place, so the new tab lands as if unplaced. |
| `revealIfOpened` | Default `true`: a tab already showing the same `(kind, address)` is focused and handed `params`. `false` opens another tab regardless. |
| `kind` (`openResource` only) | Name the opening type instead of ranking claims; its implementation in force opens the address, and its `canOpen` still applies. |
| `params` | Navigation parameters for the body, delivered as `navigation.params`. `openResource` types them by resource type through the merge-extensible `SidebarRightResourceParamsMap` (the text preview declares `{ line?: number }`); `openTab<K>` types them by kind through `SidebarRightTabParamsMap`, `undefined` for a kind that declares none; a body reads `SidebarRightNavigationParams`, the union of both. Values are JSON-shaped by convention and not validated at run time. |

Placement is the caller's option, never a type's property. The conversation calls `openResource(fileAddressFor(sessionId, cwd, path))` and, from a `read` tool row, adds `{ params: { line } }` from the call's 1-based `offset`; a guide entry box calls `tab.actions.openTab(entry.kind, { replaceTab: true })`; a file-tree row calls `tab.actions.openResource(address)`; the strip's add control calls `openTab('guide', { paneId, revealIfOpened: false })`.

`close(tabId)` closes a tab; `active()` returns the active pane's active tab; `isExpanded()` and `toggleExpanded()` read and flip the column, the flip recorded in the sequence. Reads answer for the no-Session case with `undefined` or `false`; writes need a mounted Session surface and throw without one rather than write into a surface nobody draws.

`focus(tabId)` makes a tab its pane's active tab; `split(paneId?)` splits the active docked pane, or the named one, and returns the new pane's id — or `undefined`, recording nothing, when the pane budget or the column's width forbids a split; `float(tabId, rect?)` lifts a tab into a floating pane; `dock(paneId)` returns a floating pane to the docked area. All four run the store's existing actions and record one history entry each; a target that does not exist or is already in the requested state is a no-op, and like `open` they throw without a mounted Session surface. `TabId`, `PaneId`, `TabRecord`, and `FloatRect` are re-exported from the package's `/client` entry so a caller needs no dockkit import.

## Slots and owner props

The Sidebar declares four extension slots; its document tab declares the additional keyed document body below ([hierarchy](slots.md)).

| Slot | Cardinality | Purpose |
|---|---|---|
| `sidebar.right.pane.tab` | keyed by the definition's `id`, Session scope | One tab's body. The seat dispatches a tab to the `id` of its kind's implementation in force, so the registrant receives every tab of its kind, docked or floating. A kind whose implementation registered no body renders the owner's "nothing can view this" notice. |
| `sidebar.right.pane.tab.title` | keyed by the definition's `id`, Session scope | The chip's title, with the same owner share as the body. Optional: without an entry the chip shows the `title(address)` text captured at open time; a type with a live title reads its own store here. |
| `sidebar.right.tab.guide` | chain, Session scope | Replaces the guide tab's contents without replacing the tab; the first non-declining entry takes the body, otherwise the shipped guide renders. |
| `sidebar.right.tab.menu.item` | list, Session scope | Content-level actions appended after the kit's own layout actions. An item that acts must call the owner's `dismiss()`. |
| `sidebar.right.tab.document` | keyed by the document implementation's `id`, Session scope | The selected file renderer inside the document tab; the parent owns shared loading and toolbar controls. |

A body, title and guide replacement receive the framework-injected `useTabInfo()`. It returns `{ sidebar, panel, tab }`: `sidebar` holds `expanded` and `fullscreen`, `panel.id` names the containing pane, and `tab` contains its record fields plus `visible`, `navigation`, `signal`, and `actions`. Docked bodies are visible only while expanded and active; docked titles need only expansion; floats stay visible. `signal` aborts when the record disappears or the plugin unloads, not on hiding or Session switching. `tab.actions` provides `openResource`, `openTab`, and `close`, bound to the tab's own Session. Open placement defaults to its current pane; `revealIfOpened` defaults to `true`, and `replaceTab: true` replaces this record in the same history entry. Menu entries retain plain `tab` and `dismiss` owner parameters.

`navigation.revision` increments on every navigation to the tab whether or not `params` changed, so a body can act on "navigated again" alone; it is `1` for a tab opened by address and `0` for a record nobody opened by address — a seeded guide, or a tab restored by undo. The Tab domain holds one occurrence per open record: a record that appears is pinned in the resource model, so switching tabs unmounts a body without dropping its content; a record that vanishes is aborted and dropped; a record restored by undo is a new occurrence ([Tab domain](../../packages/client/ui-sidebar-right/README.md#the-tab-domain)).

## Document renderers

The `text` tab is the shared Document Preview owner. Its [root registration](../../packages/client/ui-sidebar-documentpreview/src/client/index.ts) declares `sidebar.right.tab.document` and provides `ctx.documentPreviews`. A renderer registers `DocumentPreviewDefinition` metadata in its own effect, then waits through `ctx.slots.inject('sidebar.right.tab.document', ...)` and registers its component with `key: definition.id` and its locale namespace. Changing the renderer does not change the tab or resource address; the [extension decision](../../.agents/notes/implemented/architecture/2026-09-08-document-preview-operations.md) separates preview policy from resource ownership.

The [registry](../../packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts) records unique `id`, `extensions`, localized `title()`, `loading`, optional `priority`, and optional `wrap`. Case-insensitive suffix matching ranks `extension` (the default) before `builtin`, then longer suffixes before shorter ones, then registration order. Unlike tab-kind replacement, the registry keeps all implementations available; the toolbar lists matching alternatives and remembers the selection per tab. Unknown extensions use plain text. `loading` is `text-pages` or `bytes-complete`; `wrap` advertises support for the shared source-wrap control.

[`DocumentPreviewProps`](../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts) derives from `PropsRuntime<'sidebar.right.tab.document'>`. The owner supplies the original `resourceAddress`, `content`, and current `wrap`: text content is `{ kind: 'text', text, pages: [{ offset, text, lines }], eof }`, with cumulative `text`; complete bytes are `{ kind: 'bytes', data }`, with `Uint8Array<ArrayBuffer>` data. These transient buffers are borrowed read-only and must not enter durable layout or Session JSON. PDF copies the bytes before Worker transfer, preserving the owner's buffer. The child receives the same framework-bound `useTabInfo` and the global metadata-only `useResource`. The parent reads through ordinary inject callbacks to `remote.workspaceFiles.read`/`readAll` and owns page appends, per-tab refresh, and loading status. HTML's own inject callback uses `readRelated`; Host code resolves paths. Markdown and code retain one incremental renderer across appends and settle at EOF; HTML and PDF receive complete bytes.

Preview records its loaded version and the version observed when a read starts. Refresh rereads only that tab, without changing shared metadata or another tab's content. Reads are non-transactional; versions are opaque equality tokens, not ordered timestamps ([resource observation and Preview RPC](../../.agents/notes/implemented/architecture/2026-09-08-document-preview-operations.md)).

## Resource model

The model is documented in [Client Resources](client-resources.md); this section states what the Sidebar relies on. A resource is one address, and a resource address is a `dsh-resource://<type>/…` URL whose lower-cased host is the protocol key. The protocol's owning client package registers one provider with `ctx.resources.register(provider)` for its own lifetime; a second provider for the same protocol throws ([provide a protocol](../../packages/client/resources/README.md#provide-a-protocol)). A provider is `{ protocol, open(address, { signal }) }`: `open` yields `RemoteResult` frames — the current state first, one frame per later change — and stops when `signal` aborts; a failure is an `{ ok: false, error }` frame, never a throw, and a throw inside the stream is a programming error the model does not catch.

`useResource<P>(address)` is a global standard prop on every slot component, whatever its scope. It returns `{ status, value, failure }`: `none` when the address's protocol has no provider or the address is not a resource address (`sidebar://guide` names no resource), `loading` until the first frame, `live` with the latest `ok` value, `failed` with the latest frame's failure beside the last value. ([read a resource](../../packages/client/resources/README.md#read-a-resource)).

A resource stays open while it has a holder — a subscribed `useResource` or a `ctx.resources.pin(address, signal)`; the first holder opens the provider's stream, later holders share it and read the latest value at once, and the last release aborts the stream and discards the value. Streams carry metadata, not content: the `file` value is `{ absolutePath, version, bytes? }`, and a consumer reads file text itself, by page, through the Workspace Files service ([lifecycle](../../packages/client/resources/README.md#lifecycle)).

## Workspace Files

The Host `ctx.workspaceFiles` service and generated `workspaceFiles` Remote namespace read files allowed by the Session filesystem backend: `stat(path)` returns `{ absolutePath, version, bytes? }`; `read(path, { offset?, limit? })` returns one page of lines (`offset` 1-based, `limit` capped by the configured page size) as `{ …stat, offset, text, eof }`; `readBytes(path, { offset?, length? })` returns one raw byte window (`offset` 0-based, `length` capped by the configured byte limit) as base64 `{ …stat, offset, data, eof }` with no text decoding. `list(path)` remains inside the workspace root and returns a directory's direct children (`name`, `type: 'file' | 'directory' | 'other'`, `size?`) cut to the configured cap with `truncated` set. `changes()` likewise remains workspace-scoped and yields `{ kind: 'ready' }` once subscribed, then `{ kind: 'change', change }` frames whose payload is `{ absolutePath, version }` or `{ absolutePath, absent: true }` ([README](../../packages/api/workspace-files/README.md#use-this-package)). File operations reject final symlinks and enforce transfer caps; `read` additionally requires UTF-8 text. Failures use `workspace-file/*` codes ([failures](../../packages/api/workspace-files/README.md)).

[`dsh-api-workspace-files`](../../packages/api/workspace-files/README.md) registers the `file` provider, with `ResourceProtocolMap.file` directly naming `WorkspaceFileStat`. A Session address carries the authorizing Session and a relative or absolute path, passed unchanged to the Host for resolution. The provider waits for Host `ready` before stat and filters changes by `stat.absolutePath`. Bare `absolute` addresses have no authorizing Session and fail with `workspace-file/unknown-workspace`, without borrowing current or Tab Session. Any UI, including Global components, shares the observation for the same complete address. Preview's ordinary Remote callbacks use the Session in that address; Host `readAll` and `readRelated` remain, and Preview's `rpc.ts` decodes byte results.

## Shipped types

- **`guide`** — `builtin`, opened as `openTab('guide')`. A muted compass sits above one capsule per contributed `guide` entry, in `order`; short lists show registered descriptions, and every missing icon uses the shipped placeholder. Picking a capsule opens the contributing type as a page in the guide tab's place. A pane holds at most one guide tab, and the strip's add control appears only while its pane has none. A new pane receives the registered default page: the sole guide entry directly, or the guide when the entry count is not one ([guide](../../packages/client/ui-sidebar-right/README.md#the-guide)).
- **`text`** — `fallback`, `dsh-resource://file/**`, claiming Session addresses only. Document Preview observes metadata through `useResource<'file'>`, loads content through Remote callbacks, and owns renderer selection, the toolbar, per-tab refresh, scroll, and source navigation; unknown extensions render as plain text ([README](../../packages/client/ui-sidebar-documentpreview/README.md)).
- **`files`** — `builtin`, opened as `openTab('files')`. The workspace directory tree, listed lazily through `list`, opening a file with `tab.actions.openResource(fileAddressFor(sessionId, root, path))` into its own pane ([README](../../packages/client/ui-sidebar-files/README.md)).

<a id="not-built"></a>
## Not built

- Persistence: layout state is memory-only; a reload starts every session collapsed, and no session's tabs are visible from another.
- A read-only layout snapshot or subscription on `ctx.sidebarRight`: the service exposes operations only, and dockkit's `LayoutState`/`LayoutOp` are internal.
- A capability-discovery array (`features`) on the service.
- An `option` priority band for tab types: nothing lists a tab type without letting it claim.
- Retitling a record: `title(address)` is captured once; a live chip comes from the title slot, not from the record.
- Naming a tab implementation when opening: `openResource` names a kind at most; document-renderer selection belongs to the file tab's toolbar.
- An address lookup on the service (`find`): a caller opens with `revealIfOpened` and lets the surface de-duplicate.
- Navigation addresses beyond the Sidebar's own `sidebar://<kind>` bookkeeping; their grammar waits for the navigation controller as a whole.
- A user-facing undo, a content navigation stack, and tab icons ([deferred](../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md#deferred)).
