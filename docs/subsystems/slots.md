# Web Client Slots

English | [中文](slots.zh.md)

Slots are the Web Client's typed React composition system. [`dsh-client-ui-slots`](../../packages/client/ui-slots/README.md) defines the React-free registry and type algebra; [`dsh-client-ui-renderer`](../../packages/client/ui-renderer/README.md) binds observable sources to hooks, renders the tree, and owns React contexts internally. A feature plugin contributes UI through `ctx.slots.register()` and never imports another feature plugin's component.

This page documents slot ownership, component inputs, extension APIs, and the shipped hierarchy. The surrounding boot, Remote, Client model, and Conversation paths are in [Web Client architecture](web-client.md).

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
| scope | `session-maybe` | Follows current selection but stays renderable without a Session; Session values are optional. |
| scope | `session` | Requires a resolved Session binding and receives definite Session values. |

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

`SessionProvider` is also present in `PropsRenderSlots` when an entry declares a strict Session child. It binds that subtree to the current Session identity and remounts the body when the identity changes.

Components never receive `ctx`. Parent-owned point-in-time values enter through the owner argument to `renderSlot`; shared view state uses a declared store; services and model objects stay in the `apply` closure and are projected into callbacks or observable sources.

## Framework-provided hooks

The shipped adapters add these standard props. They are available according to the target slot's scope, independent of which package registered the component.

| Availability | Props | Owner |
|---|---|---|
| every scope | `useSessions`, `useSessionPendingInteraction` | `ui-session` |
| every scope | `useWorkspaces` | `ui-workspace` |
| `session` | `sessionId`, `useSession`, `useProjection` | `ui-session` |
| `session-maybe` | optional `sessionId`, `useSession`, `useProjection` results | `ui-session` |
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

## Current hierarchy

The hierarchy below is the shipped declaration tree. A child exists only while the named parent entry is mounted; optional feature entries can therefore make a subtree appear or disappear as one lifecycle unit.

```text
root
├─ sidebar
│  ├─ sidebar.brand.mark
│  ├─ sidebar.brand.name
│  ├─ sidebar.footer.action
│  ├─ sidebar.workspaces
│  │  └─ sidebar.workspaces.directoryFlow
│  └─ sidebar.settings
│     ├─ settings.trigger
│     ├─ settings.header
│     ├─ settings.action
│     ├─ settings.close
│     ├─ settings.onboarding
│     └─ settings.section
│        ├─ settings.general.item
│        ├─ settings.models.provider-card
│        ├─ settings.models.footer
│        └─ settings.plugins.tab
│           └─ settings.plugin.item
├─ conversation
│  ├─ conversation.session
│  │  └─ conversation.view
│  │     ├─ conversation.chat.node
│  │     │  ├─ conversation.chat.assistant-actions
│  │     │  ├─ conversation.chat.commandview
│  │     │  ├─ conversation.chat.turnTail
│  │     │  └─ tool.call.toolview
│  │     │     ├─ tool.call.images
│  │     │     └─ tool.view.cordis
│  │     ├─ conversation.message.images
│  │     └─ conversation.trajectory.images
│  ├─ conversation.session.header
│  │  ├─ conversation.session.header.lineage
│  │  ├─ conversation.session.header.actions
│  │  └─ conversation.session.header.utilities
│  ├─ conversation.composer
│  │  └─ conversation.approval.detail
│  ├─ conversation.composer.bar
│  │  ├─ conversation.input.attachments
│  │  ├─ conversation.input.plan
│  │  └─ conversation.input.model
│  ├─ conversation.input.overlay
│  ├─ conversation.input.dock
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  ├─ conversation.input.right
│  ├─ conversation.hero.brand.mark
│  ├─ conversation.hero.workspace
│  │  └─ conversation.hero.workspace.directoryFlow
│  └─ conversation.hero.agentPreset
├─ details
│  └─ conversation.details.tool
└─ shell.overlay
```

The generated Client inspect catalog is the exhaustive contract for each key: cardinality, scope, owner props, standard props, current occupants, declaration owner, and replacement risk. A running dynamic package can query the live tree and an exact key with `cordis_inspect what:"client"`; the source catalog is generated from `SlotMap` declarations and `slots.register()` call sites by `pnpm run gen-client-catalog`.

## Extension rules

- Import another feature package only for declarations with `import type`; never import or re-export its runtime values.
- Declare a new child slot only in the component that owns and renders that location. Other packages wait with `ctx.slots.inject()` and contribute through `ctx.slots.register()`.
- Keep business and transport state in their owning Cordis services or Client models. Slot stores hold shared viewing and interaction state only.
- Keep observable source and snapshot identities stable between changes. Republish through the same source whenever its value changes.
- Pass JSON-compatible data and callbacks between UI domains. The `hooks` compartment is the sole exception for bare observables; React content travels through slots.
- Treat `single` and an occupied keyed cell as replacement points. Use list ids or an unoccupied key for additive extensions.
