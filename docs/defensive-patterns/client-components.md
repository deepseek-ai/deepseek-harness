# Client component rules

English | [中文](client-components.zh.md)

Rules for client components, their state, and their effects. [packages/client/AGENTS.md](../../packages/client/AGENTS.md) carries the detailed discipline; [slots.md](../subsystems/slots.md) owns the Slot design and [web-styling.md](../web-styling.md) the styling rules. Each section below states the requirement, how a reviewer judges it, where its boundary and exception sit, and a correct and a wrong example.

## State arrives through injection

A Slot's component receives everything it renders through the inject face of its own registration — plain data, action callbacks, and the reserved `hooks` compartment the renderer binds to `use<Name>` hooks — while the parent's render site passes owner data through the derived `renderSlot`. It never reads one large global state at the top of the tree to hand values down. Keeping every live value on that face is what makes a prop that did not change keep its identity, and what lets a component subscribe only to the sub-state it reads. Without it any unrelated field change re-renders the whole subtree, which is how a long session under streaming events loses frames while the user scrolls or types.

- Judged by: at the registration and at its render site, the author must be able to name which sub-states the rendered component subscribes to and which of its incoming props keep a stable identity across renders. Watch the mutability of every prop: a value rebuilt each render — a fresh object, array, or inline callback — propagates re-renders even when nothing in it changed.
- Not covered: the component's own local state (`useState` for a fold, a hover, a draft) is not injection content, and a component that subscribes to nothing outside React needs no new seat.
- Exception: a new hook seat changes the Slot contract, so that change states its impact — which components subscribe to what — in review; using an existing face needs no per-component approval.
- Fix: narrow the injection to what the view renders, expose one field per read through a hook seat, and pass a narrow action set instead of a store or service handle. [Component inputs](../subsystems/slots.md#component-inputs) owns the inject factory, the standard hook seats, and how each becomes a prop.

The registration carries plain data, a narrow action set, and one hook seat; the render site passes owner data, and the component reads only the field it renders:

```tsx
// The inject factory returns plain data and callbacks; hooks is the reserved compartment.
ctx.slots.register(
  {
    name: 'sidebar.right',
    inject: () => ({
      rename,
      hooks: { info: infoSource },   // bound by the renderer as useInfo()
    }),
  },
  SidebarRight,
)

// The parent's render site passes owner data through the derived renderSlot.
{renderSlot('sidebar.right', { id })}

function SidebarRight({ id, useInfo, rename }: Props) {
  const { title } = useInfo()   // subscribes to title only
  return <button onClick={() => rename(id)}>{title}</button>
}
```

The top-level component reads the whole view store and hands it down as one prop, so the render site can no longer answer either question above:

```tsx
function Sidebar() {
  const view = useViewStore()           // one top-level global read
  return <SidebarRight view={view} />   // the whole store travels down
}

function SidebarRight({ view }: { view: ViewStore }) {
  return <span>{view.activePanel.title}</span>
}
```

Every field change in that store re-renders the whole sidebar subtree, and the component's subscription set is invisible to the site that bound it.

## Props carry data and callbacks, not React nodes

A prop is data or a callback; a React node travels through a declared slot. Passing an element as a prop value or an injected member hides a second composition path that the Slot contract does not describe, moves render control from the registration surface to the call site, and lets one package assemble another package's markup. New node-valued props or injected members are never added; a location that needs host-supplied markup is declared as a child slot instead.

- Judged by: `ReactNode`, `ReactElement`, or a `() => JSX.Element` in a component's props type, in an inject factory's return value, or in an owner-props object at a render site.
- Not covered: node-valued fields that already shipped keep working. The rule triggers when a change touches one, and that change converts it rather than extending it.
- Exception: when the conversion cannot happen in the same change, the owning domain expert confirms the deferral and the change records that confirmation; the author never self-approves.
- Fix: declare the location in the parent registration's `children`, render it with `renderSlot`, and pass data through the child's props. [Extension rules](../subsystems/slots.md#extension-rules) own which package may declare and render which slot.

The header location is a declared child slot, so the host passes data and the registered component owns its markup:

```tsx
// The card declares the header location; the host passes data only.
ctx.slots.register(
  {
    name: 'tool.call.toolview',
    children: { header: { kind: 'single', scope: 'session' } },
  },
  ToolCard,
)

function ToolCard({ title, renderSlot }: Props) {
  return <article>{renderSlot('header', { title })}</article>
}
```

A React node crosses the boundary as a prop value, so the composition path it travels is not declared anywhere:

```tsx
type ToolCardProps = {
  header?: React.ReactNode
  footer?: React.ReactNode
}

// The call site assembles another package's markup.
<ToolCard header={<ArchiveBadge />} />
```

The card's Slot contract stops describing what it renders, the call site keeps render control, and the badge's package becomes a runtime reference from whoever passes it.

## A slot registration is a stable function component

The value registered into a slot is a stable function component declared at module scope. A component function created during render is a new component type on every pass, and React treats a changed type as a different component: it unmounts the subtree and mounts a fresh one, which resets expanded rows, input focus, and scroll position. Registration-time parameters reach the component through props rather than by closing over render-time variables.

- Judged by: where the registered value is created. An inline arrow in a registration or render call, a component defined inside a render body, and a `useCallback` wrapper around an inline component all fail; a module-scope `function` declaration passes.
- Not covered: the rule constrains the identity of the registered value, not its complexity. A stable component may still read injected props, hooks, and callbacks.
- Exception: creating a component during render is correct only when the caller wants the remount, and an ordinary change needs no separate approval; a change to the form of the Slot contract follows the injection-face review described under State arrives through injection.
- Fix: move the component to module scope, type its props from the registration's shares, and pass the varying value through the inject face instead of the closure.

The registration holds one stable reference to a module-scope component, and the varying value arrives injected; the render site supplies the local component:

```tsx
function PanelTitle({ title, count }: Props) {
  return <span>{title} ({count})</span>
}

// Registration: the local slot's scope is declared, never a component.
ctx.slots.registerFactory(
  {
    name: 'panel',
    scope: 'root',
    slots: { title: { scope: 'root' } },
    inject: () => ({ title: 'Sessions', count: 3 }),
  },
  Panel,
)

// The render site passes the local component, keeping its identity stable.
renderFactorySlot('panel', { /* owner data */ }, { slots: { title: PanelTitle } })
```

An inline arrow at the render site creates a new component type whenever that render runs:

```tsx
// A new component type each time this render runs.
renderFactorySlot('panel', { /* owner data */ }, { slots: { title: (p) => <span>{p.title}</span> } })
```

React sees a different type than the previous registration, remounts the seat, and resets its local state — expanded, focused, or scrolled position — on an otherwise unrelated update.

## Components never receive a Cordis context

`ctx` belongs to the apply world: the plugin body and the `inject` factories closed over it. A component never receives a Cordis context, never imports a service class to poke it, and never reads a React context, because business components see zero contexts — the renderer's binding contexts are internal to it. A bare observable reaches a component only after Injection wraps it in a hook; a component that subscribes directly owns a lifecycle that nothing on the Injection face releases.

- Judged by: `ctx` or `Context` in a component's parameter or props type; a component body reading `observable.value`, calling `subscribe`, or wiring `useSyncExternalStore`; a service class imported into a feature `.tsx` module.
- Not covered: a component-internal behavioral hook that subscribes to nothing outside React (a timer, a media query) is not injection content and stays in the component.
- Exception: none. The direct subscription still present in `TabSlot` is remediation work owned by that entry's owner, not a precedent for new code.
- Fix: move the fact into the registration's `inject` — plain data and callbacks, with bare observables in the reserved `hooks` compartment — or into a declared store, and read it through the derived seat.

Injection binds the observable, and the component reads one derived hook whose subscription the renderer owns:

```tsx
// The inject factory is the only place that closes over ctx.
const inject = () => ({
  hooks: { tab: tabStore.observable },
  action: { openTab },
})

function TabView({ useTab, action }: Props) {
  const { loaded } = useTab()   // the renderer owns the subscription
  return <button hidden={loaded} onClick={() => action.openTab('files')} />
}
```

The component holds `ctx` and reads the source itself, so the subscription and its lifetime belong to the component:

```tsx
function TabView({ ctx }: { ctx: Context }) {
  const store = ctx.get('tabStore')                     // component holds the container
  return <span>{store.observable.value.title}</span>    // raw observable read in render
}
```

No one releases that subscription, re-renders fire outside React's scheduling, and the component is now bound to one store implementation.

## Context comes from the current scope

`session`, `panel`, `tab`, and the like come from the current scope — a provider, an injected member, or a framework hook. A new global `current`, `active`, `selection`, or `viewId` is not a channel for reaching them, so the several composers and conversations of one session each work independently.

The judged condition is whether a component obtains its context through the scope, or through a global field. Multi-instance behavior is the test: two composers under one session must not cross. Where an object really is globally unique, a service or instance carries it and callers `inject` it explicitly.

```ts
// The injected factory closes over the scope's own session and panel.
interface Scope { readonly session: string; readonly panel: string }
const inject = (ctx: Scope) => ({ session: ctx.session, panel: ctx.panel })
```

```ts ignore-check
const activeTabId = globalThis.__activeTabId   // every tab reads the same value
```

The wrong form makes instances cross-talk, and ownership of state becomes unauditable.

## Resource consumers go through `useResource`

An element that shows a resource reads it through the injected `useResource` hook, addressed by the resource's protocol and address. A domain wrapper — a Tab, a panel — composes its own hook over `useResource`, and its return structure is free, but the fetch, cache, and subscription underneath are not rebuilt. A second read path per protocol splits cache and invalidation policy, so one address can be live in one place and stale in another.

- Judged by: the read path. `useResource<Protocol>(address)`, or a business hook whose body calls it, passes; a hand-built subscribe-and-cache, a copy of a provider's stream handling, or a flat generic hook such as `useTabStream` fails.
- Not covered: non-resource local UI state — a collapse, a hover, a draft — stays `useState` and gets no resource address. [Client resources](../subsystems/client-resources.md) owns the status values and what holds a resource open.
- Exception: reshaping the snapshot is free, but a wrapper that hides protocol differences behind conditional branches states its ownership in review, and a new protocol's hook comes from that protocol's owner.
- Fix: call `useResource` inside the domain hook, map its result onto what the component renders, and delete the bespoke cache.

The domain wrapper takes the injected hook as an argument and only reshapes its result, so the bottom layer stays single:

```tsx
// The bottom layer is the standard hook, reached through the component's inject face.
function useChatMessages(useResource: UseResource, id: string) {
  const resource = useResource<'chat'>(`dsh-resource://chat/${id}`)
  return resource.status === 'live' && resource.value !== undefined
    ? { messages: resource.value.messages, loading: false }
    : { messages: [], loading: true }
}

function ChatBody({ id, useResource }: Props) {
  const { messages } = useChatMessages(useResource, id)
  return <ol>{messages.map((message) => <li key={message.id}>{message.text}</li>)}</ol>
}
```

A wrapper rebuilds subscription, cache, and invalidation under its own name, so the provider's lifecycle and the shared cache no longer apply:

```tsx
export function useTabStream(id: string) {
  const [value, setValue] = useState<TabData>()            // bespoke cache
  useEffect(() => {
    const subscription = tabProtocol.open(id).subscribe(setValue)   // bespoke subscription
    return () => subscription.close()                              // bespoke teardown
  }, [id])
  return value
}
```

Every protocol grows its own fetch and invalidation logic, cache entries and refresh policy cannot be unified, and consumers of one address disagree about its current value.

## Store usage is narrow and explicit

A front-end store carries shared viewing or interaction state. Its spec declares the initial state, the actions that mutate it, and — when the value should survive a reload — a persistence key the framework runs mechanically, with a session-scope instance suffixing that key so per-session instances persist independently. The store's attributes and the actions that mutate them are encapsulated and injected as a narrow interface, so a component receives those and the selectors it needs and never the whole view store. Business data lives in the object layer rather than in a store, and a setting change goes through the settings interface, not through store state.

- Judged by: whether the injected face is a narrow interface or the store object itself, and whether the handle is built inside `apply` or at module level.
- Persistence: the spec's `persist` key is the whole mechanism, run by the framework; the engine instance exposes `getSnapshot`, `subscribe`, the baked actions, and `clearPersisted`, and nothing hydrates it by hand.
- Not covered: render state in a store is fine while it does not change a setting, and component-local state is not store content. [Store contracts](../subsystems/slots.md#component-inputs) own how a declared store becomes props, and [Web Client architecture](../subsystems/web-client.md) owns where business data lives.
- Exception: a store handle exported at module level is forbidden — module-cache identity is a disguised singleton across plugin reloads; restructuring an injection face into a narrow one needs no separate approval.
- Fix: replace the store handle in the inject return with the fields and action callbacks the component renders, and keep the handle inside `apply`.

One handle is built inside `apply` and passed to the registration, and the inject face carries only the fields and actions the view renders:

```tsx
// The handle is built in apply; persistence is the spec's own key.
const sidebarStore = createSidebarStore()   // defineStore({ init, actions, persist: 'sidebar' })

ctx.slots.register(
  { name: 'sidebar.header', store: sidebarStore, inject: () => ({ onSelect: selectPanel }) },
  SidebarHeader,
)

// The component reads through the framework-bound seat and writes through the actions.
function SidebarHeader({ useStore, actions, onSelect }: Props) {
  const { title } = useStore()
  return <button onClick={onSelect}>{title}</button>
}
```

The whole view store is injected for the component to pick fields from, and a module-level handle takes instance lifecycle away from the framework:

```tsx
// The component receives the store itself and picks its own fields.
const inject = () => ({ viewStore })

function SidebarHeader({ viewStore }: Props) {
  return <button onClick={viewStore.select}>{viewStore.activePanel.title}</button>
}

// Module-level handle: one identity shared by every plugin load.
export const paneStore = createPaneStore()
```

The component's dependency face stops being auditable, and the shared module identity outlives every scope teardown: two panes end up on one instance instead of one each.

## Identity and initial state are deliberate

Switching state does not remount a control or replace its DOM node: the instance and its DOM identity stay the same across a state change, so focus, selection, and an in-progress draft survive it. Initial state is ready when the first flow runs — the same path prepares the data and establishes the state — instead of being filled in later by an effect. A component receives hooks, selectors, and action callbacks rather than a whole service.

- Judged by: after a state change, whether the control instance and its DOM node keep their identity; an unmount followed by a mount is the violation. The initialization path is judged the same way: state established inside the first flow passes, state written from an effect fails.
- Dependency face: hooks read, selectors pick a sub-state, and action callbacks write back. A whole service passed as a prop or an injected member fails.
- Scope: input and command controls that hold an internal instance and local state, and business views created by a factory.
- Exception: a genuinely required remount — switching to a data set whose instance state cannot migrate — is explained in review together with the state migration plan; the reviewer of a change that affects a control's instance lifetime accepts it.
- Fix: derive the initial value where the first flow builds its state, keep the layout node mounted and vary its props, and replace a service prop with the three narrow shares.

The draft exists with the session and the composer node stays mounted while only its props change:

```tsx
// The draft is built by the first flow; nothing fills it in later.
const draft = useDraftState(sessionId)
const { canSend } = useComposerSelectors(draft)

// The node stays mounted; state changes reach it as props.
return (
  <div className={s.composer} data-ready={canSend || undefined}>
    {draft.text}
  </div>
)
```

Initial state arrives one commit late, and the keyed control is rebuilt whenever the session changes:

```tsx
// The draft is filled in after the first commit.
useEffect(() => { setDraftState(initialDraft) }, [])

// The keyed composer unmounts on every session switch.
<Composer service={composerService} key={sessionId} />
```

The first frame renders an empty draft, and every session switch drops focus, selection, and whatever the user had typed.

## `useLayoutEffect` is not a default

`useLayoutEffect` is not used by default, and replacing it with `useEffect` is not a fix, because the two differ in timing rather than in what the code is doing. A layout measurement first answers why it happens here, why CSS cannot express it, and why it must be a pixel measurement; only then does it move into an injected measurement hook with the owning domain expert's sign-off. An effect of either kind never records state or binds logic, because that belongs in Injection.

- Judged by purpose, not by hook name: which measurement or which binding the effect exists for. A state-recording or logic-binding effect returns to Injection as a Provider or an injected hook; only a measurement that survived the three questions stays, and its result is consumed as a declarative layout parameter.
- Not covered: the timing difference between the two effects, which `@types/react` documents for `useLayoutEffect` as synchronous after DOM mutation and before paint, is background fact and not a license to rewrite one as the other.
- Exception: any retained `useLayoutEffect` needs the owning domain expert's confirmation, and the change records that confirmation.
- Fix: express the layout in CSS — grid, `aspect-ratio`, a container query — or collect the measurement inside the injected hook and expose one value.

Layout is declared in CSS, and the one measurement that survived the questions lives in an injected hook:

```tsx
// Fix 1 — express the layout in CSS and delete the measurement.
// .card { display: grid; grid-template-columns: minmax(0, 1fr) auto; aspect-ratio: 16 / 9; }

// Fix 2 — the approved measurement is injected and returns one value.
function CardBase({ useLayoutMeasurements }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { gutterWidth } = useLayoutMeasurements(ref)
  return <div ref={ref} className={s.card} style={{ '--gutter': `${gutterWidth}px` }} />
}
```

Both of the first two effects below answer the wrong question — which effect to use — and the third parks a binding in an effect:

```tsx
// A synchronous pixel measurement the design did not need.
useLayoutEffect(() => { setHeight(ref.current.getBoundingClientRect().height) }, [])

// The same measurement with the hook name swapped.
useEffect(() => { setHeight(ref.current.getBoundingClientRect().height) }, [])

// Logic binding parked in an effect instead of Injection.
useEffect(() => { bindShortcut(handler) }, [])
```

The rename leaves the layout problem in place, the measured height now depends on which effect was chosen, and the shortcut binds one render late instead of through Injection.

## Effects never push render-derived data to a parent

An effect body never calls a setter that arrived through props or slot props to push data back to a parent when that data could be decided during render from props or state the component already has. Such a push costs a second render, leaves the parent without the value on its first frame, and turns any later state change into a render cascade. The value is decided during render, the host takes it through a render-time channel, or a user gesture updates its own state in its handler.

- Judged by: a setter from props or slot props called inside an effect, whose argument derives from the current props or state, with no external event or subscription callback driving it. A cleanup `return () => setX(undefined)` is part of the same violation.
- Consequences to name in review: the extra render pass; the parent's first frame missing the value; a dependency array that goes stale when a member is omitted; the effect → parent state → render cascade; and a child lifecycle entangled with parent state.
- Not covered: an effect that reacts to a genuine external event — a subscription callback, a socket frame, a user gesture — is not this pattern, and an event handler may update state directly.
- Exception: none by default; any exception needs the owning domain expert's confirmation.
- Fix, in order: render the UI where the state already is; if the host must render it, hand the value over during render; if the state is shared across entries, move it to the inject face or a declared store.

The control is rendered where its state already lives, and the shared variant is read during render while the write stays in the gesture handler:

```tsx
// 1. Render it where the state already lives; no channel is needed.
return <Button onClick={() => setShowOriginal((v) => !v)}>{label}</Button>

// 2. The host renders it: the flag is declared state, read during render
//    and written only from the gesture handler.
const { showOriginal } = useStore()
const { toggleOriginal } = actions
return <Button onClick={toggleOriginal}>{showOriginal ? rendered : source}</Button>
```

`label` and `disabled` are render-derivable, so calling the parent's setter from an effect makes the parent render twice and still lack the header on its first frame:

```tsx
useEffect(() => {
  setHeaderAction({ label, disabled, onClick })   // render-derivable data pushed up
  return () => { setHeaderAction(undefined) }
}, [label, disabled, setHeaderAction])
```

The parent renders twice for data it could have had on the first pass, the header appears a frame late or flashes, and the hand-written dependency list decides when it is published.

## Build and style follow their owners

Every build adjustment for a client package goes through the tsdown plugin for that package, and a package does not grow its own build branch. Styling goes through CSS Modules, and only images, GIFs, and SVG are inlined — inlined into CSS rather than into JSX. Large text never appears inline in TSX, and a `style` object holds only runtime-computed values, because static values and style variants belong to CSS Module class names.

- Judged by: a new build branch inside a package instead of the tsdown plugin; a literal color, a component library, or Tailwind in feature styling; base64 data or large text in TSX; and a `style` object carrying static values or a variant switch.
- Not covered: a runtime-computed value such as a measured gutter or a progress percentage may enter `style`, and a component-local custom property may carry a layout value. [Component rules](../web-styling.md#component-rules) own the tokens, CSS Module, and class-name rules.
- Exception: a new build branch or a new inline form is explained in review before it lands, and the owning package's rules decide whether it stays.
- Fix: move the variant into a CSS Module class switched by `className`, keep base64 in CSS produced by the build chain, and delete the large text constant from the TSX module.

The component switches class names and data attributes, and the CSS Module owns the presentation:

```tsx
import s from './card.module.css'

// Style variants are class names, not style-object branches.
export function Card({ active, tone, children }: Props) {
  return (
    <div className={clsx(s.card, active && s.active)} data-tone={tone}>
      {children}
    </div>
  )
}
```

Large text and inlined binary data enter the module, and the `style` object encodes a variant the theme cannot override:

```tsx
const HUGE = '...several KB of text...'   // large text inline in the module

// A variant switch and an inlined asset both sit in the style object.
<div style={{ color: toneColor, backgroundImage: `url(${AVATAR_DATA_URL})` }} />
```

The bundle carries text and binary data that belong in CSS and assets, diffs carry unreadable blobs, and a theme override can no longer reach that colour.

## A key states what it identifies

Pass a `key` only when it names which entity or instance an element represents, and state that identity — a `turnId`, for example, is unique inside one session. Most lists already have a stable business id and need no extra key. A key invented to silence a warning or to encode render order states an identity the data does not have, and an array index is never that identity, because an insert or delete shifts every following item onto a different element.

- Judged by: whether the item's identity can be expressed by position or by a stable id. When a key is passed, the change states what makes it unique, and `key={index}` over a mutable list fails.
- Not covered: React's own requirement that a list's items carry keys still applies; that key is the item's stable business id and not a second key beside it.
- Exception: none. An ordinary change needs no sign-off, while the key semantics of a shared component are stated in review.
- Fix: use the entity's stable id, and when two rows genuinely share one id, fix the id source instead of mixing an index into the key.

The key is the turn's own id, whose uniqueness inside a session is the identity the element represents:

```tsx
// turnId is unique inside a session; the id is the identity.
export function TurnList({ turns }: Props) {
  return (
    <ol>
      {turns.map((turn) => <TurnRow key={turn.turnId} turn={turn} />)}
    </ol>
  )
}
```

The index stands in for identity, so every following row changes identity when the list changes:

```tsx
// The index stands in for identity.
{items.map((item, index) => (
  <Row key={index} data={item} />
))}
```

After an insert or a delete, each following row keeps its previous state on new data, so an expanded row or an in-progress edit appears on the wrong item.

## Each shared layer keeps its own isolation level

A feature absorbs its requirement in its own package, and how much separation it must keep from shared code depends on which shared layer that code belongs to. The violation to look for is a feature-specific concept placed in a shared layer, because every other consumer then has to understand a concept that is not theirs and the branch is hard to withdraw.

| Shared code | Isolation a feature keeps |
|---|---|
| `ui-primitives`, the catalogued controls | Consume the catalogued control. A new control starts in the feature package and is promoted into the shared catalog only when a second consumer needs it. |
| `ui-layout` and the shell layout | Consume it; adapt in the feature package with a wrapper, an overridden style, or an added layer. |
| `ui-renderer` and the other render machinery | No value dependency from business code; extend only through the documented registration seams — slots, provide/inject-bound hooks, declared stores. |
| Another feature plugin | No runtime import and no re-export of its values. UI crosses through slots and behavior through injected services; shared runtime code lives in a narrow static owner such as `client/store`, `ui-primitives`, or a browser-safe utility package. |
| The data object layer (`client/connection`, `session-controller/client`, `client/store`) | Read through the documented surface; a feature's own concepts do not enter these objects or their stores. |
| The feature's own package | Unrestricted — the requirement is absorbed here, including its own rows, ordering, and presentation. |

- Judged by: whether the diff puts a feature-specific branch, field, or concept into any layer but the feature's own package.
- Not covered: code the feature owns, and a change to a shared layer that is genuinely general rather than one feature's need.
- Exception: a shared-layer change carries the owning domain expert's confirmation and regresses every consumer; a GUI change runs the minimum check in [packages/client/AGENTS.md](../../packages/client/AGENTS.md).
- Fix: absorb the requirement in the feature package, or, when the need is genuinely general, promote it to the shared layer in its own change with the owner's sign-off.

The feature owns its row rendering and its ordering rule, and the base component is consumed unchanged:

```tsx
// The feature owns its rows; the base is consumed, not edited.
// packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx
export function WorkspaceBrowser({ rows, onArchive }: Props) {
  const ordered = [...rows].sort((a, b) => Number(b.archived) - Number(a.archived))
  return (
    <ul>
      {ordered.map((row) => <WorkspaceRow key={row.id} row={row} onArchive={onArchive} />)}
    </ul>
  )
}
```

A base component learns one feature's ordering rule, so every consumer inherits a concept that is not theirs:

```tsx
// ui-layout: the base learns one feature's ordering rule.
export function BrowserList({ rows, ...rest }: Props) {
  const ordered = [...rows].sort((a, b) => Number(b.archived) - Number(a.archived))
  return <ul {...rest}>{ordered.map((row) => <Row key={row.id} row={row} />)}</ul>
}
```

Every other consumer of `ui-layout` now has to understand an archive concept that only one feature has, and withdrawing the branch means auditing all of them.
