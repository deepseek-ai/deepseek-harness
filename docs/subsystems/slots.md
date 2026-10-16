# Web Client Slots

English | [中文](slots.zh.md)

Slots are the Web Client's typed React composition system. [`dsh-client-ui-slots`](../../packages/client/ui-slots/README.md) defines the React-free registry and type algebra; [`dsh-client-ui-renderer`](../../packages/client/ui-renderer/README.md) binds observable sources to hooks, renders the tree, and owns React contexts internally. A feature plugin contributes UI through `ctx.slots.register()` and never imports another feature plugin's component.

This page documents slot ownership, component inputs, extension APIs, and the shipped hierarchy. The surrounding boot, Remote, Client model, and Conversation paths are in [Web Client architecture](web-client.md).

`plugins.bundle.config` supplies bundle detail configuration, keyed by npm package name. `plugins.bundle.activation` renders optional guidance after user-requested enablement, with owner callbacks to dismiss or open that bundle’s details. `conversation.input.activity` supplies one action between the model selector and Send, with toolbar expansion released on unmount.

The plugin catalog declares `plugins.add.actions`, a root-scoped list for `MenuItemButton` rows after installation in the Add plugin menu. Its owner supplies `onDismiss()` to close the menu before starting an action. The slot follows the owning Plugins page declaration lifetime.

## Declaration and lifecycle

`SlotMap` is the compile-time registry. A package declaration-merges the key, cardinality, scope, owner props, keyed props, and optional slot-level inject face. The runtime declaration is the matching `children` entry on the component that owns the render location.

Declaring a child has three effects: it makes the child key live, authorizes that parent entry's `renderSlot` or `renderSlotChain` call, and records the runtime dispatch specification. One live entry owns each declaration. Registering into an undeclared slot or declaring a child already owned elsewhere fails during plugin activation.

`root` is the only built-in declaration and the only key rendered through the Cordis service itself. `ui-renderer` calls `ctx.slots.renderSlot('root', {})`; every descendant is rendered through the `renderSlot` or `renderSlotChain` prop of the entry that declared it.

Registrations and declarations follow Cordis effect lifetimes. Disposing an entry removes its contribution and recursively collapses the child slots it declared. A feature that contributes into another package's slot therefore uses `ctx.slots.inject(key, callback)`: the callback runs for each declaration lifetime, its effects are removed when the owner collapses, and it runs again if the owner is mounted again.

```tsx ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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
| scope | `root` | One root-scoped component and store instance. |
| scope | `session-maybe` | Inherits the surrounding Provider binding but stays renderable without one; Session values are optional. |
| scope | `session` | Requires a resolved surrounding Provider binding and receives definite Session values. |

`priority` is a shadowing rank for `single`, `list`, and `keyed` cells and an election order for `chain`. Lower values run or render first. Ordinary additive contributions should choose a fresh list `id` or keyed `key`; intentionally reusing a shipped cell replaces its presentation.

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

`SessionProvider` is also present in `PropsRenderSlots` when an entry declares a `session` or `session-maybe` child. With no `session` prop it inherits the surrounding binding; an explicit `SessionReference` or `undefined` overrides only that subtree. The Provider does not key its whole body. A strict `session` entry remounts when its binding generation changes. A blank `session-maybe` entry adopts its first binding without remounting, then remounts for a later generation or a return to absence.

Components never receive `ctx`. Parent-owned point-in-time values enter through the owner argument to `renderSlot`; shared view state uses a declared store; services and model objects stay in the `apply` closure and are projected into callbacks or observable sources.

## Framework-provided hooks

The shipped adapters add these standard props. They are available according to the target slot's scope, independent of which package registered the component.

| Availability | Props | Owner |
|---|---|---|
| every scope | `useSessions`, `useSessionStatus`, `useSessionRetainInfo`, `useSessionAccess` | `ui-session` |
| every scope | `useWorkspaces`, `useWorkspaceAccess` | `ui-workspace` |
| every scope | `useRemoteAccess` (the `global` resource) | `api-remote-access` |
| every scope | `usePanelInfo` | `ui-layout` |
| `session` | `sessionId`, `useSession`, `useProjection`, `useAccess` (the bound Session's answer) | `ui-session` |
| `session-maybe` | optional `sessionId`, `useSession`, `useProjection`, `useAccess` results | `ui-session` |
| `session` | `useConversation`, `useInput`, `inputActions` | `ui-conversation` |
| `session-maybe` | optional `useConversation`, `useInput`, `inputActions` results | `ui-conversation` |
| `session` | `useChat` | `ui-chat` |
| `session` | `useTrajectory` | `ui-trajectory` |

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
      │     └─ conversation.session.header.corner
      └─ calls Factory: conversation.content

Factory: conversation.content [ConversationContent]
├─ conversation.session [ConversationSession / DefaultConversationViews]
│  └─ conversation.view
│     ├─ id=chat [ChatView]
│     │  └─ conversation.chat.flow [ChatFlow]
│     │     └─ conversation.chat.node [ChatNodeSeat dispatch]
│     │        ├─ key=user,steering [UserMessageNodeView]
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
│  ├─ conversation.input.permission
│  ├─ conversation.input.plan
│  ├─ conversation.input.model
│  ├─ conversation.input.overlay
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  └─ conversation.input.right
├─ conversation.input.dock
│  └─ id=queue [QueueDock]
│     └─ calls Factory: conversation.user.text
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

## Extension rules

- Import another feature package only for declarations with `import type`; never import or re-export its runtime values.
- Declare a new child slot only in the component that owns and renders that location. Other packages wait with `ctx.slots.inject()` and contribute through `ctx.slots.register()`.
- Keep business and transport state in their owning Cordis services or Client models. Slot stores hold shared viewing and interaction state only.
- Keep observable source and snapshot identities stable between changes. Republish through the same source whenever its value changes.
- Pass JSON-compatible data and callbacks between UI domains. The `hooks` compartment is the sole exception for bare observables; React content travels through slots.
- Treat `single` and an occupied keyed cell as replacement points. Use list ids or an unoccupied key for additive extensions.
