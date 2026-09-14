# Agent Note: Right Sidebar tab types and navigation

Status: implemented

English | [中文](2026-09-05-sidebar-tab-types-and-navigation.zh.md)

## Problem

The [docking surface](../feature/2026-09-04-right-sidebar-docking-infrastructure.md) gives the right Sidebar panes, tabs, and floating panels, but a pane full of tabs is only useful if other plugins can put content into them. That needs three contracts the surface itself does not define: how a plugin declares a kind of tab and the addresses it can show, how any caller — a produced-file chip in the conversation, a row in a file tree, a plugin's own button — asks the Sidebar to show something, and what a tab's body may rely on at runtime. Each contract is a public face that plugins shipped from outside this repository will write against, so each has to be settled before those plugins exist: a renamed field, a changed enum value, or a different address grammar afterwards breaks every one of them.

Two constraints shaped the answers. Dynamic client plugins may not import runtime values from one another — a function, a constant, a class — only types, so nothing in these contracts may require a helper function or an exported constant from the Sidebar package. And the Web client already has one component model, the Slot system; a second one for tabs would be a parallel framework to learn and maintain.

## Decision

A tab type is a static registration into `ctx.sidebarRightTabs`; a tab's body and title are ordinary keyed Slot registrations; `ctx.sidebarRight` opens content in exactly two ways — a resource by address, or a page by kind — and otherwise only operates the layout; and bodies read occurrence information through the framework-injected `useTabInfo()`. The four faces are described below in the order a plugin author meets them.

### The type registry: `ctx.sidebarRightTabs`

`register(definition): () => void` records one tab type and returns the disposer the caller holds in its own `ctx.effect`, so a type lives exactly as long as the plugin that contributed it. The definition is static:

```ts ignore-check
interface SidebarRightTabDefinition {
  readonly id: string                                   // this implementation's identity in the tab system
  readonly kind: string                                 // what the tabs of this type are; what openTab names
  readonly patterns?: readonly string[]                 // resource-address globs; omitted by a page type
  readonly priority?: 'extension' | 'builtin' | 'fallback'   // defaults to extension
  readonly canOpen?: (address: string) => boolean       // veto after a glob matched
  readonly title: (address: string) => string           // chip text, captured at open time
  readonly guide?: readonly SidebarRightGuideEntry[]    // entry boxes on the guide page
}
```

`id` and `kind` are different things. `kind` is the type discriminator — what a tab *is*, what `openTab` names, what tab identity is built from. `id` is the identity of one *implementation* of a kind, unique across every registration; a package name is the natural value. The two are separate because a kind is not unique: an `extension` may register the kind a `builtin` already holds, and the two implementations then coexist in the registry with the extension in force. The registry rejects a second registration of an `id`, a second registration in the same band of a kind, and any registration meeting a `fallback` of the same kind; it accepts exactly the extension-over-builtin pair, and the builtin resumes when the extension unregisters.

`patterns` are globs over resource addresses, matched with `picomatch` under VS Code's editor-resolver rule with one local change: a pattern containing `:` is matched against the whole address (`dsh-resource://file/**`), one without is matched against the URI's path at any depth (`*.md`), matching ignores case and does not hide dotfiles, and an address that is not a URI matches no path pattern. A page type — the guide, the file tree — recognizes no address and omits `patterns`; it is opened by kind.

`priority` is one of three literal bands, spelled as strings so that a type from another package needs no runtime import: `extension` is the band of a type from outside the product and the highest, so a type that declares nothing outranks every viewer shipped here; `builtin` is the ordinary band for shipped types; `fallback` is the plain-content position that anything more specific should beat, which VS Code's text editor holds implicitly and our text preview holds explicitly. `candidates(address)` returns every type whose globs match and whose `canOpen` does not veto, ranked by band, then by the length of the longest pattern that matched, then by registration order. `claim(address, kind?)` takes the best candidate, or the named kind's type in force when the caller overrides (its globs are not consulted; naming the type is the decision), and throws for an address nothing will open — a wiring mistake, not a user error. `get(kind)` returns the type in force; `entries()` and `guide()` list the types and their guide boxes in force; `subscribe` observes changes.

`title(address)`, `guide[].title()`, and optional `guide[].description()` are thunks read on every use, so a language change needs no re-registration. [Guide start page and stat pill refinements](../feature/2026-09-10-guide-start-page-and-stat-pill-refinements.md) owns the current description visibility and fallback-glyph rules. The registry itself is a plain object provided at `apply`'s top level **without** `Service.tracker`: a tracker would rebind `this.ctx` to the caller's context, and a cross-package `register()` would then add its effect to the caller's fiber while that fiber is the active scope, stalling the browser boot with no error.

### Bodies and titles: keyed Slot seats under the definition's `id`

The type registry says what a type is; the Slot system says what it looks like. A type registers its body into the keyed, session-scoped seat `sidebar.right.pane.tab` under its own `id`, and may register a title component into `sidebar.right.pane.tab.title` under the same key. The seat that draws a tab resolves the tab's `kind` to the type in force through the registry and dispatches to that type's `id`, so an extension taking over a builtin's kind is rendered without either package knowing about the other, and without any priority number crossing a package boundary. A kind with no type in force renders the owner's "nothing can view this" notice; a type with no title registration gets the `title(address)` text the registry captured when the tab opened.

Two further seats extend the guide and the menu: `sidebar.right.tab.guide` is a chain whose first non-declining entry replaces the shipped guide body without replacing the tab, and `sidebar.right.tab.menu.item` is a list appended after the kit's own layout actions, for actions that mean something about a tab's content. A type's controls — a reload, a wrap toggle — live inside its own body; the strip belongs to the panel and carries only the panel's controls. A type's own state is an ordinary Slot store and inject face on the body registration; the framework adds nothing to the component model.

### Tab occurrence information

[Responsive Sidebar and tab information](2026-09-07-sidebar-responsive-tab-info.md) supersedes this note's choice of flat owner props for occurrence information. Bodies, titles and guide replacements receive the framework-injected `useTabInfo()` to read `{ sidebar, panel, tab }`. The record, navigation, visibility, signal and bound actions live inside `tab`; exact fields belong to the [Sidebar reference](../../../../docs/subsystems/sidebar-right.md).

The Tab domain still owns one occurrence per committed record, with an `AbortController`, navigation snapshot and actions bound to its Session. It pins the address in the [resource model](2026-09-05-client-resource-model.md) for the record's lifetime; hiding and switching Sessions do not end it, while closing the record aborts and releases it. Existing framework store and navigation hooks provide live reads, without subscriptions in tab implementations.

### Navigation: `ctx.sidebarRight`

The face opens content in two ways and does nothing else with content:

```ts ignore-check
openResource(address: string, options?: { kind?: string; params?: SidebarRightResourceParams; paneId?; replaceTab?: TabId; revealIfOpened?: boolean }): void
openTab<K extends string>(kind: K, options?: { params?: SidebarRightTabParamsFor<K>; paneId?; replaceTab?: TabId; revealIfOpened?: boolean }): void
```

`openResource` takes a resource address — a `dsh-resource://<type>/…` URI, the only scheme the resource model has — and asks the registry who shows it: without `kind`, every type is consulted and the ranking decides; with `kind`, that type's implementation in force opens it. An address with any other scheme fails on the same path as an address nothing claims. `openTab` opens a page type by kind and never sees an address: the Sidebar records the tab under `sidebar://<kind>`, composed in one place inside the package, so that a page tab has a `contentId` for identity and history like any other tab. The scheme is bookkeeping: no caller composes it, no business package contains the literal, and the file tree and the guide are opened as `openTab('files')` and `openTab('guide')`.

Both opens run the same four steps: resolve the type (by ranking or by kind), locate an existing tab by `(kind, contentId)` unless `revealIfOpened` is `false`, place the tab — in `replaceTab`'s pane and strip slot, in `paneId`, or in the active pane — and record the expansion, the open-or-focus, and the `replaceTab` close as one history entry before handing `{ address, params }` to the tab domain. Placement is the caller's business, never a type-level trait: the file tree opens into its own pane because it says so, as VS Code's Explorer passes `SIDE_GROUP` or `ACTIVE_GROUP` itself. `replaceTab` means one thing — open in that tab's place and close it in the same step — and exists for the guide's entry boxes, which hand their tab over to the page they name.

Parameters are typed by what is being opened, through two merge-extensible maps declared in the Sidebar package and augmented by the owners of the keys:

```ts
interface SidebarRightResourceParamsMap {}   // key: resource type — the text preview declares { line?: number }
interface SidebarRightTabParamsMap {}        // key: kind — a page type declares its own shape, or nothing
```

`openResource` accepts the union of every declared resource shape and `openTab<K>` the shape declared for `K`; a body narrows `navigation.params` by the protocol or kind it knows it serves. Parameters belong to the resource type rather than to the viewer because a line number is a fact about a file location, not about the text preview, and any type that claims `file` addresses receives the same shape. Values must be JSON-serializable, and a record must be rebuildable from address and parameters alone, because undo, redo, reload, and HMR rebuild tabs after the opener is gone.

Beside the two opens, the face carries `close(tabId)`, `active()`, `isExpanded()`, `toggleExpanded()`, and four operational methods — `focus(tabId)`, `split(paneId?)` (returning the new pane, or `undefined` when the pane budget or the width rule forbids the split, recording nothing), `float(tabId, rect?)`, and `dock(paneId)` — each recording one history entry and a no-op on a missing target or one already in the requested state. There is no layout snapshot, no subscription, and no lookup by address: the face grants control over the layout, not a view of it. The seat publishes its binding — its session, its store's actions, and its surface — while mounted; a command on the public face acts on the mounted session and throws with no mounted session surface. A tab's own actions reach their session's own store instead: the slot runtime mints one store per session, the plugin adopts each as it is minted, and the controller routes by session id, so an action fired after the user switched sessions still lands, and does nothing for a session whose store was never minted.

### Addresses

Addresses come in two families that never mix. Resource addresses are the resource model's `dsh-resource://<type>/…` URIs (a workspace file is `dsh-resource://file/session/<sessionId>/<path relative to that session's workspace root>`, an arbitrary file `dsh-resource://file/absolute/<absolute path>`, both built and parsed by `dsh-util-workspace-path`); they are what `openResource` takes, what `patterns` match, and what `useResource` reads. Navigation addresses name pages rather than data; today the only one is the internal `sidebar://<kind>` a page tab is recorded under. Only the resource family is a contract: the navigation family is composed and consumed inside the Sidebar, and a fuller navigation protocol is a later decision that this one leaves room for by keeping every navigation literal in one place.

### Entry points

The conversation's `openFile(path, { line? })` — tool-row path links, produced-file chips, closing-message mentions — encodes the path as a file resource address for the Session, and calls `openResource` with `params.line` when the caller knows one; the `read` tool row passes the line its `offset` argument started from. The strip's `+` calls `openTab('guide', { paneId, revealIfOpened: false })` for the pane it sits in; a guide entry box calls `tab.actions.openTab(entry.kind, { replaceTab: true })`; a file-tree row calls `tab.actions.openResource(address)`, which lands in the tree's own pane.

## Alternatives considered

**A chain slot for tab dispatch, or a keyed slot alone.** A chain's `select` is not enumerable, and the guide page and the navigation face must enumerate types; a keyed slot carries a body and nothing else, so a type's title and address recognition had nowhere to live. Two stages — a definition registry plus keyed component seats — is the repository's existing pattern (`ConversationViewRegistry`).

**Runtime hooks or an instance object per tab.** Several forms were tried on paper — a Cordis fiber per tab, an abstract base class, an `initial`/`create` pair returning an instance with `dispose`, a set of `useTab*` hooks, a framework-managed `useTabResource(fetch)`, a `useTabStream`. Rejected in turn: a fiber per tab is far too heavy; dynamic packages cannot share a base class or an exported constant; an instance layer duplicates what a Slot store and inject face already are; per-tab hooks restate owner props; a framework-owned fetch has no good cache key; and a stream hook on the tab domain asks the wrong owner — chat data must come from the chat domain, file data from the workspace file service. What remains is owner props plus one client-wide `useResource`. `visible` was later added as a prop rather than a hook for the same reason: it is one more fact about the occurrence, and the props already carry the occurrence. The rejection of occurrence-reading hooks is superseded by the [tab information decision](2026-09-07-sidebar-responsive-tab-info.md); the independent instance, fiber and data-stream ownership rationale still applies.

**A per-pane tools seat for the active tab's controls (`sidebar.right.pane.tab.tools`).** Shipped for one review round, then removed: it put type-private buttons on the panel's strip beside the split and collapse controls, where they read as panel chrome. A type's controls belong in its own body.

**Type-level placement (`opensInto`) and a hidden sibling heuristic.** Rejected: where a tab lands is the opener's business, exactly as VS Code's Explorer decides `sideBySide` itself.

**Extension lists and numeric priorities.** `claims.extensions` cannot express `.d.ts`, `Dockerfile`, a directory constraint, or a whole scheme — it is a degenerate glob; numeric priorities need an exported constant that dynamic packages cannot import. Literal bands over globs. VS Code's own bands were reduced from five to three: an `option` band (listed, never chosen automatically) has no consumer until an "open with…" affordance exists, and a `default` band was renamed `extension` because the name read as the lowest tier while it is the highest.

**One `open(address)` for everything, with a helper that builds page addresses.** The first design opened pages by address too, so a business package needed a `sidebar://<kind>` literal or a `sidebarAddress(kind)` helper from the Sidebar package. Both are forbidden by the value-import rule and both leak a navigation scheme that is not yet designed. Splitting the face into `openResource` and `openTab` puts the only literal inside the package and lets each mode type its parameters.

**Naming a specific implementation when opening (`?impl=`), `find(address)`, `mode()`/`setMode()`, a layout snapshot, a `features` list.** All considered and left out. Naming an implementation belongs to a navigation protocol that does not exist yet; `find` and a snapshot would make the face a view of the layout when it is meant to be control over it; presentation mode is a UI toggle, not a plugin concern; a capability list is premature while the face is settling.

**Slot priorities to express an extension taking over a builtin, then registry-minted slot keys.** The first attempt had the overriding type register its body at a lower slot priority through an exported constant — a value import across dynamic plugins, and a second rule system (slot priority) standing in for the registry's. The second attempt had the registry mint a key per registration and return it from `register()`, which made registration a two-step dance whose ordering mattered. Letting the implementation declare its own `id` — required, unique, the same string it registers its seats under — needs no constant, no minting, and no ordering, and gives the registry the identity it needs to reject duplicates.

## Consequences

- A type is one static object plus one or two keyed seat registrations; its occurrence information is read through injected `useTabInfo()`. The framework grows no per-type API surface, and a type shipped from outside this repository imports only types from the Sidebar package.
- Two opens with two parameter maps mean a caller cannot open a page by address or a resource by kind alone, and the compiler tells it so; the cost is that every new resource type or page kind that wants typed parameters augments a map.
- `id` and `kind` being distinct lets an extension replace a shipped type in place, per kind, with the builtin resuming when the extension unregisters; the cost is one more required field on every definition.
- The navigation face is control-only. A plugin that needs to know the layout cannot ask for it, which keeps the layout's shape out of every plugin's contract until a navigation protocol decides what to expose.
- The `sidebar://<kind>` literal lives in one file. Changing the navigation grammar later touches the Sidebar package and nothing else.
- These faces are the part of the Sidebar that is fixed: addresses, registration fields and bands, the two opens and their parameter maps, seat names and injected tab information. Everything a user sees as behaviour — where a float snaps, when a split control greys out, the copy, the tree's ordering — is a product rule outside every contract here and changes without notice to any plugin.

## Testing

`ui-sidebar-right` specs cover the registry (bands, extension-over-builtin with resumption, `id` and same-band collisions, glob and path matching, `canOpen`, ranking and tiebreaks), both opens (normal, edge, and failure paths including the wrong scheme and an unregistered kind), `replaceTab` as one history entry, the seat resolving a kind to the implementation in force and back, `useTabInfo()` including `tab.visible` under collapse and floating, and the operational methods with their no-op and throw cases. The Web e2e suite drives the guide, the file tree, and a file open through the real plugin graph in Chromium. Both suites are keyless.

## Deferred

- A navigation protocol beyond `sidebar://<kind>`: sub-routes within a page, naming an implementation, and the ecosystem-facing rules for other navigation schemes.
- Parameters for the shipped page types, which today declare none.
- Opening into a session other than the one on screen from the public face, which acts on the mounted session only; a tab's own actions already act on their tab's session.
- A localized message when an open fails from the conversation; the failure is currently the thrown error's text.
