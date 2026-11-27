# Web Client Slots

English | [中文](slots.zh.md)

Slots are the Web Client's typed React composition system. [`dsh-client-ui-slots`](../../packages/client/ui-slots/README.md) defines the React-free registry and type algebra; [`dsh-client-ui-renderer`](../../packages/client/ui-renderer/README.md) binds observable sources to hooks, renders the tree, and owns React contexts internally. A feature plugin contributes UI through `ctx.slots.register()` and never imports another feature plugin's component.

This page documents slot ownership, component inputs, extension APIs, and the shipped hierarchy. The surrounding boot, Remote, Client model, and Conversation paths are in [Web Client architecture](web-client.md).

`plugins.bundle.config` supplies bundle detail configuration, keyed by npm package name. `plugins.bundle.activation` renders optional guidance after user-requested enablement, with owner callbacks to dismiss or open that bundle’s details. `conversation.input.activity` supplies one action between the model selector and Send, with toolbar expansion released on unmount.

The plugin catalog declares `plugins.add.actions`, a root-scoped list for `MenuItemButton` rows after installation in the Add plugin menu. Its owner supplies `onDismiss()` to close the menu before starting an action. The slot follows the owning Plugins page declaration lifetime.

The root-scoped lists `sidebar.panellist.actions`, `conversation.session.header.views.actions`, and `sidebar.right.tab.guide.actions` supply the rows of the More menus after the panel rows, the View tabs, and the right-sidebar guide cards. A region draws its More button and menu only while its list has registrations, and passes the customizable entries with their pin state, `onOpen`, `onPinnedChange`, and `onDismiss`. Panel and View entries also carry optional `active` state for the current selection, independently of pin state. The `sidebar.panel.icon` root-scoped factory owns the `sidebar.panellist` list and renders its registered icon by `id`, `size`, and `active` for both sidebar rows and More entries. Each region keeps its own unpinned entry ids in memory; [`ui-entry-customization`](../../packages/client/ui-entry-customization/README.md) registers the shipped rows.

[ui-workspace](../../packages/client/ui-workspace/README.md#understand-the-implementation) documents Session-row extension positions, visibility, and keyboard behavior.

[ui-settings](../../packages/client/ui-settings/README.md#filling-the-settings-slots) documents the settings page and navigation-icon extension points.

[ui-session-panel](../../packages/client/ui-session-panel/README.md#contribute-a-section) documents the Session panel's section, title-control, row, and toggle-indicator extension positions.

General Settings declares the root-scoped list `settings.general.group`; each group entry owns its child item-list declaration. The settings base declares the six built-in grouped item keys and exports their union as `SettingsGeneralGroupItemSlot`; custom groups declaration-merge their exact `settings.general.group.<id>.item` key into `SlotMap`. The default Preferences group owns the compatible `settings.general.item` key. [ui-settings-general](../../packages/client/ui-settings-general/README.md#the-general-section) documents group labels, ordering, shared cards, and registration examples.

## Declaration and lifecycle

`SlotMap` is the compile-time registry. A package declaration-merges the key, cardinality, scope, owner props, keyed props, and optional slot-level inject face. The runtime declaration is the matching `children` entry on the component that owns the render location.

Declaring a child has three effects: it makes the child key live, authorizes that parent entry's `renderSlot` or `renderSlotChain` call, and records the runtime dispatch specification. One live entry owns each declaration. Registering into an undeclared slot or declaring a child already owned elsewhere fails during plugin activation.

`root` is the only built-in declaration and the only key rendered through the Cordis service itself. `ui-renderer` calls `ctx.slots.renderSlot('root', {})`; every descendant is rendered through the `renderSlot` or `renderSlotChain` prop of the entry that declared it.

Registrations and declarations follow Cordis effect lifetimes. Disposing an entry removes its contribution and recursively collapses the child slots it declared. A feature that contributes into another package's slot therefore uses `ctx.slots.inject(key, callback)`: the callback runs for each declaration lifetime, its effects are removed when the owner collapses, and it runs again if the owner is mounted again.

```tsx ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'

type HeaderActionProps = PropsRuntime<'conversation.session.header.actions'>

function HeaderAction({ useSession }: HeaderActionProps) {
  const running = useSession(snapshot => snapshot.running)
  return <button disabled={running}>Review</button>
}

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'review',
      order: 100,
    }, HeaderAction))
}
```

## Cardinality and scope

The slot declaration fixes two independent axes.

| Axis | Value | Meaning |
|---|---|---|
| cardinality | `single` | One cell. The active priority winner renders. Use a child slot instead of treating this as an additive list. |
| cardinality | `list` | Cells are addressed by required `id` and ordered by `order`, then registration order. |
| cardinality | `keyed` | The owner dispatches an `entryKey`; the matching cell renders with any key-specific props. |
| cardinality | `chain` | Each entry supplies a pure `select(owner)` function. The first non-null result in priority order renders and receives that result as `matched`; otherwise the owner fallback renders. |
| cardinality | `hoc` | Entries nest around the owner's `renderSlot(key, owner, { children })` content, lowest outermost; an optional `key` selects layers by the owner's `entryKey`. See [Hoc layers](#hoc-layers). |
| scope | `root` | One root-scoped component and store instance. |
| scope | `session-maybe` | Inherits the surrounding Provider binding but stays renderable without one; Session values are optional. |
| scope | `session` | Requires a resolved surrounding Provider binding and receives definite Session values. |

`priority` is a shadowing rank for `single`, `list`, `keyed`, and `hoc` cells and an election order for `chain`. Lower values run or render first. Ordinary additive contributions should choose a fresh list or hoc `id`, or keyed `key`; intentionally reusing a shipped cell replaces its presentation.

<a id="slot-style-ownership"></a>

### Which package supplies the rendered content?

`data-slot` identifies a position; `data-plugin` identifies the package supplying its content, regardless of that package's CSS settings. For [scoped styles](../../packages/client/ui-renderer/README.md#package-style-isolation), a different package name ends the enclosing package's scope; a nested root with the original name starts it again. An unknown supplier or framework error has `data-plugin=""`. A shared outlet with no `data-plugin` leaves the enclosing scope unchanged.

| Position | Existing element | Whose package name goes in `data-plugin`? |
|---|---|---|
| `root`, `single`, `keyed` | `[data-slot]` | The winner, or the caller for a `single` or `keyed` fallback. An exhausted cell shows a framework error instead. An unregistered `root` is an assembly error. |
| `chain` | `[data-slot]`; `[data-chain-overlay-fallback]` for an overlay's fallback | The elected registration, or the caller for no match or `fallbackOnly`. The separate fallback element always names its supplier, even while hidden. |
| `list`, including `only` | `[data-slot-item]` for a winner; `[data-slot]` for a fallback | Each item's winner. An outlet with rows is unmarked, even for a single row. With no matching `id`, the outlet names the caller; an exhausted `id` gets `data-plugin=""` on its direct error element. |
| `hoc` | `[data-slot]`; `[data-slot-children]` where a layer forwards children | The outermost applicable layer, or the caller with no layers. Each children outlet names the supplier of its *contents*: the next layer, or the original caller at the innermost layer. |
| Component Factory | `[data-slot-factory]`; `[data-slot-factory-children]` for a mounted local replacement | The definition supplies the body; the caller supplies the selected local. A default local has no separate root. A missing definition returns the caller's fallback without a Factory root. |

No additional DOM element or render permission comes with these attributes. The [style scoping decision](../../.agents/notes/implemented/architecture/2026-11-23-slot-module-boundaries-for-css-scope.md) shows how a button keeps its caller's styles inside another package's Factory and how HOC layers forward children.

<a id="list-item-roots"></a>

### List item roots

A `list` outlet (`[data-slot="key"]`) has one direct `[data-slot-item]` child for the winning registration of each selected `id`, even when `only` selects a single `id`. The attribute has an empty value; it does not identify the registration or the render instance. The outlet and its item roots are `div`s by default or `span`s when the list declares `inline: true`. Both use `display: contents` and have no layout box of their own.

A winner that returns `null` leaves an empty item. Text and all local nodes of a React Fragment stay inside one item; portal content stays at its destination. Counting item roots does not tell you how many controls are visible. If the list has no registrations or `only` matches no `id`, the owner's `fallback` renders directly inside the outlet (nothing if omitted). If all registrations for a matching `id` have failed, its `[data-slot-error="key"]` placeholder is a direct child of the outlet instead of an item. Reordering siblings or switching `only` preserves the item, its controls and their state while the same registration remains selected.

<a id="hoc-layers"></a>

### Hoc layers

A hoc entry is a layer addressed by its required `id` and optional `key`. A layer without `key` is a wildcard that applies to every dispatch; a layer with `key` applies only when the owner passes the same `entryKey` to `renderSlot`, and an owner that omits `entryKey` gets only wildcard layers. Each `(key, id)` pair, with the wildcard as its own key, is one shadowing cell; within one `id`, an exact-key layer replaces the wildcard layer for that key.

Layers nest by ascending `order`, then `priority`, then registration order, lowest outermost. Every layer receives the same owner props. The renderer supplies the next inner layer as React `children`, or the owner's content at the innermost layer. The owner may omit its content without skipping the layers. Each layer may render `children` at most once. Owner props must not use the name `children`.

The outer `[data-slot="key"]` marks the named slot's render position. With no applicable layer, the owner's content renders unchanged inside it, without a children outlet. Where a layer renders `children`, the renderer inserts one `[data-slot-children="key"]` outlet around the inner content, even when it is empty. Forwarding layers nest these outlets. A layer that omits `children` replaces everything inside it: neither its children outlet nor its inner content mounts.

`data-slot-children` names the slot that supplied those `children` to the layer. Passing them through another slot preserves that name. All layers and all render occurrences of the same slot share the value; it does not identify a layer, plugin module, or dispatch `entryKey`.

Suppose the owner passes a button to `outer.frame`. Its layer passes a React fragment containing its `children` followed by a second button to its declared hoc slot `inner.frame`. If the `inner.frame` layer returns its own `children` unchanged, the DOM is:

```text
[data-slot="outer.frame"]
  [data-slot="inner.frame"]
    [data-slot-children="inner.frame"]
      [data-slot-children="outer.frame"]
        button
      button
```

Both buttons have `inner.frame` as their nearest `[data-slot]`, and `[data-slot-children] > button` matches both. Within the intended `outer.frame` instance, `[data-slot-children="outer.frame"] > button` matches only the owner's button; `[data-slot-children="inner.frame"] > button` matches only the button added by the `outer.frame` layer.

- Remounting: adding or removing a layer that applies to a dispatch remounts the content inside it; a `session` or `session-maybe` layer also remounts it when its Session binding changes. Outlets of the same named slot that dispatch the same key share one compiled layer chain, so a registration for another key does not remount their content; an outlet that switches its `entryKey` switches chains and remounts its content even when the same layers apply.
- Errors: a crashed layer reports its error and falls back to the same `children`, including its outlet, for the rest of that occurrence's mount even when its owner props change. The layer stays registered, so other occurrences, including those dispatching the same key, keep it, and a remounted occurrence renders it again. An error thrown by the wrapped content passes every layer and is reported against none; a layer that wraps its `children` in its own error boundary catches it as an internal wrapper error rather than the original.
- Layout: both outlet elements are `div`s (`span`s for `inline: true`) with `display: contents`. They create no layout boxes, but child and sibling selectors still see them. Identify the outlets by their attributes, not by depth. A layer that wraps `children` must not create a box of its own unless its slot documents otherwise.

The [context-menu plugin](../../packages/client/ui-context-menu/README.md) contributes `useContextMenu` through `provideRoot`; every scope receives the same plugin-owned trigger factory. Its prop and retained handlers retire when the provider unloads. Its root-scoped keyed `contextMenu.icon` Slot renders business-owned icons from action metadata.

<a id="component-inputs"></a>

## Component inputs

A registered component receives inputs assembled at its binding site. Components derive these types rather than copying their members.

| Input | Declared by | Component type |
|---|---|---|
| owner values and standard scope values | the `SlotMap` row and installed scope adapters | `PropsRuntime<K>` |
| authorized child renderers | the registration's `children` keys | `PropsRenderSlots<S>` |
| selector hook and mutation callbacks for shared view state | the registration's `store` | `PropsStore<H>` |
| private data, callbacks, and observable hooks | the registration's `inject` factory | `InjectFace<I>` |
| localized `t` function | the registration's `locale` namespace | `PropsLocale<N>` |
| selected chain value | the registration's `select` result | `matched` through `ComposedProps` |
| wrapped owner content | the `SlotMap` row's `hoc` kind | `children` through `ComposedProps` |

`SessionProvider` is also present in `PropsRenderSlots` when an entry declares a `session` or `session-maybe` child. With no `session` prop it inherits the surrounding binding; an explicit `SessionReference` or `undefined` overrides only that subtree. The Provider does not key its whole body. A strict `session` entry remounts when its binding generation changes. A blank `session-maybe` entry adopts its first binding without remounting, then remounts for a later generation or a return to absence.

Components never receive `ctx`. Parent-owned point-in-time values enter through the owner argument to `renderSlot`; shared view state uses a declared store; services and model objects stay in the `apply` closure and are projected into callbacks or observable sources.

<a id="framework-provided-hooks"></a>

## Framework-provided hooks

The shipped adapters add these standard props. They are available according to the target slot's scope, independent of which package registered the component.

| Availability | Props | Owner |
|---|---|---|
| every scope | `useSessions`, `useSessionRetainInfo`, `useSessionAccess` | `ui-session` |
| every scope | `useSessionStatus` | `ui-session-status` |
| every scope | `useWorkspaces`, `useWorkspaceAccess` | `ui-workspace` |
| every scope | `useRemoteAccess` (the `global` resource) | `api-remote-access` |
| every scope | `usePanelInfo` | `ui-layout` |
| every mounted scope | `useDocumentPortal`, `useDocumentViewport` | [ui-renderer](../../packages/client/ui-renderer/README.md#use-this-package) |
| every scope | `useMediaQuery` | `ui-responsive` |
| every scope | `useMobile` | `ui-responsive` |
| every scope | `useTheme` | [ui-theme](../../packages/client/ui-theme/README.md#use-this-package) |
| `session` | `sessionId`, `useSession`, `useProjection`, `useAccess` (the bound Session's answer) | `ui-session` |
| `session-maybe` | optional `sessionId`, `useSession`, `useProjection`, `useAccess` results | `ui-session` |
| `session` | `useConversation`, `useInput`, `inputActions` | `ui-conversation` |
| `session-maybe` | optional `useConversation`, `useInput`, `inputActions` results | `ui-conversation` |
| `session` | `useChat` | `ui-chat` |
| `session` | `useTrajectory` | `ui-trajectory` |

`useMediaQuery(query)` answers whether a CSS media query matches in the page window and rerenders the component when the answer changes; use it when the answer selects rendered structure or behavior, and keep a style-only difference in a CSS `@media` rule. `useMobile()` answers whether the page runs on a phone or tablet and stays fixed for the page lifetime; use it only for automatic focus and soft-keyboard behavior, and select layouts with width media queries. A plugin whose components read either prop injects the `uiResponsive` service, so it starts after both props exist and unloads with them. `useTheme(selector)` selects from the current theme snapshot; a plugin whose components read it injects the `theme` service.

The renderer also creates `useStore` from a declared store and `t` from a declared locale namespace. These are registration-derived props rather than global standard props.

Framework and domain-adapter owners may extend the standard set through `ctx.slots.provideRoot()` or `ctx.uiSession.provide()` together with the corresponding `GlobalStandardProps`, `SessionStandardProps`, or `SessionMaybeStandardProps` declaration merge. A feature component should not create a React hook prop itself or add a global standard prop for entry-private data.

## Developer-provided injection

The `inject` option on a registration is the ordinary feature-owned injection point. Its factory runs in the plugin's `apply` world, may close over injected Cordis services, and returns only the data and callbacks that the component needs. For a `session` slot it receives `sessionId`; for `session-maybe` it receives `sessionId | undefined`; when a store is declared it also receives the store's bound actions.

A reserved `hooks` object in that return value accepts bare `getSnapshot`/`subscribe` sources. The renderer converts `hooks: { status }` into a `useStatus(selector)` component prop and caches the binding by source identity. Components do not receive the source itself and do not call `useSyncExternalStore` directly.

The owner of a slot may put an `inject` face in the child declaration when every occupant needs the same capability. Plain members reach all occupants unchanged. Function-valued members inside its `hooks` object are hook factories; they receive the slot's standard props and optional per-render `hookContext`, then return the constrained hook exposed to the occupant. `conversation.chat.node` uses this mechanism to provide `useTurnData(key)` for the node currently being rendered.

Use owner props for values already known at one render occurrence, registration `inject` for one entry's callbacks and private observables, slot-level `inject` for a capability controlled by the slot owner, and a declared store for mutable view state shared across entries or preserved across remounts. React nodes compose through child slots, not through injected values.

<a id="current-hierarchy"></a>

## Conversation hierarchy

The following Conversation paths distinguish declaration owners from reusable Factory roots; unrelated shell positions are omitted. An entry owns its declared children, while a Factory owns its child declarations for the lifetime of its registered definition. Bracketed names identify the default React components; a plain React descendant can render its owner's Slot. Factory calls are references to independent reusable definitions, not new Slot declarations.

```text
root [AppFrame]
└─ main[key=conversation] [ConversationPanel]
   └─ main.conversation [ConversationRoot / ConversationMainPanel]
      ├─ conversation.header [ConversationHeader]
      │  ├─ conversation.header.leading
      │  └─ conversation.session.header [ConversationSessionHeader]
      │     ├─ conversation.session.header.lineage
      │     ├─ conversation.session.header.actions
      │     ├─ conversation.session.header.utilities
      │     │  └─ id=session-panel [SessionPanelToggle]
      │     │     └─ conversation.session.panel.indicator [list, inline]
      │     ├─ conversation.session.header.views.actions
      │     └─ conversation.session.header.corner
      └─ calls Factory: conversation.content

Factory: conversation.content [ConversationContent]
├─ conversation.session [ConversationSession / DefaultConversationViews]
│  └─ conversation.view
│     ├─ id=chat [ChatView]
│     │  ├─ conversation.chat.text-interaction [list]
│     │  ├─ conversation.chat.markdown.fence [hoc, keyed by fence language]
│     │  ├─ conversation.chat.aside [SessionPanel]
│     │  │  ├─ conversation.session.panel.section [list]
│     │  │  │  └─ id=environment [EnvironmentSection]
│     │  │  │     └─ conversation.session.panel.environment.row [list]
│     │  │  └─ conversation.session.panel.section.actions [keyed]
│     │  └─ conversation.chat.flow [ChatFlow]
│     │     └─ conversation.chat.node [ChatNodeSeat dispatch]
│     │        ├─ key=user [UserMessageNodeView]
│     │        │  ├─ conversation.chat.user.before [chain]
│     │        │  └─ calls Factory: conversation.chat.user.content
│     │        ├─ key=steering [UserMessageNodeView]
│     │        │  └─ calls Factory: conversation.chat.user.content
│     │        ├─ key=assistant-step [AssistantNodeView / AssistantMarkdown]
│     │        │  ├─ conversation.chat.message.images [MessageImages]
│     │        │  └─ conversation.chat.reasoning.body [DefaultReasoningBody]
│     │        │     └─ calls Factory: conversation.chat.reasoning.content
│     │        ├─ key=tool-call [ToolCallTree]
│     │        │  └─ tool.call.toolview
│     │        │     └─ key=read_image [ReadImageRow / ToolRow]
│     │        │        └─ tool.call.images [MessageImages]
│     │        ├─ key=command-input [GoalCommandInputView]
│     │        │  └─ calls Factory: conversation.user.text
│     │        ├─ key=command [CommandNodeView]
│     │        │  └─ conversation.chat.commandview
│     │        └─ key=turn-tail [TurnTailNodeView]
│     │           ├─ conversation.chat.turnTail
│     │           └─ conversation.chat.assistant-actions
│     └─ id=trajectory [TrajectoryView / TrajectoryTable]
│        └─ conversation.trajectory.images [MessageImages]
├─ conversation.composer
│  ├─ conversation.approval.detail
│  └─ conversation.plan-review.actions
├─ conversation.composer.bar [InputBar]
│  ├─ conversation.input.attachments
│  ├─ conversation.input.placeholder
│  ├─ conversation.input.permission
│  ├─ conversation.input.plan
│  ├─ conversation.input.model
│  │  └─ conversation.input.model.label
│  ├─ conversation.input.overlay
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  └─ conversation.input.right
├─ conversation.input.dock
│  └─ id=queue [QueueDock]
│     └─ calls Factory: conversation.user.text
├─ conversation.hero.frame [hoc]
│  └─ id=pixel-whale [PixelWhale]
├─ conversation.hero.brand.mark
├─ conversation.hero.workspace
│  └─ conversation.hero.workspace.directoryFlow
├─ conversation.hero.agentPreset
└─ conversation.hero.options

Factory: conversation.chat.user.content [UserContent]
├─ conversation.chat.user.images [MessageImages]
└─ calls Factory: conversation.user.text

Factory: conversation.user.text [UserText]
└─ conversation.user.text.node [keyed, inline]

Factory: conversation.images.content [MessageImagesContent / ImageGallery]
Factory: conversation.chat.reasoning.content [ReasoningContent / MarkdownText]
```

All four image Slots default to `MessageImages`, which calls `conversation.images.content` with the caller's image references and authorized loader. User and output image replacements are independent. The `conversation.user.text` Factory is shared by user content, Queue, and Goal; its `inline: true` keyed Slot renders span anchors and inline error placeholders rather than block wrappers.

The generated [Client inspect catalog](../../packages/extensions/cordis-client-runner/src/client/slot-catalog.ts) covers all shell branches and is the exhaustive contract for each key: cardinality, scope, owner props, standard props, current occupants, declaration owner, and replacement risk. A running dynamic package can query the live tree and an exact key with `cordis_inspect what:"client"`; the source catalog is generated from `SlotMap` declarations and `slots.register()` call sites by `pnpm run gen-client-catalog`.

<a id="extension-rules"></a>

## Extension rules

- Import another feature package only for declarations with `import type`; never import or re-export its runtime values.
- Declare a new child slot only in the component that owns and renders that location. Other packages wait with `ctx.slots.inject()` and contribute through `ctx.slots.register()`.
- Keep business and transport state in their owning Cordis services or Client models. Slot stores hold shared viewing and interaction state only.
- Keep observable source and snapshot identities stable between changes. Republish through the same source whenever its value changes.
- Pass JSON-compatible data and callbacks between UI domains. The `hooks` compartment is the sole exception for bare observables; React content travels through slots.
- Treat `single` and an occupied keyed cell as replacement points. Use fresh list or hoc ids, or an unoccupied key, for additive extensions.
