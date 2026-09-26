# Agent Note: Reusable component factories with local slots

Status: implemented

English | [中文](2026-09-10-component-factories-and-local-slots.zh.md)

## Problem

The browser Slot system starts with a parent-owned extension position. A parent entry declares a child through `children`, and unrelated plugins may then register implementations into that position. The declaration fixes the child Slot's kind, scope, render authority, and lifetime.

A reusable component assembly has the opposite ownership direction. One package defines the assembly, unrelated parents render independent occurrences, and each parent may choose a different Component for a named internal region. An ordinary Slot cannot represent this relationship because its definition belongs to one parent position in the global Slot tree.

The defining and consuming packages compile independently. TypeScript cannot infer a selected Component's props from a runtime registration in another package, and a separately maintained flattened props type would duplicate the store, injection, locale, child-render, and scope declarations.

## Decision

`ui-slots` and `ui-renderer` provide named Component Factories beside the [ordinary Slot system](2026-07-22-slot-type-chain-implementation.md). `registerFactory()` installs one reusable definition, `renderFactorySlot()` renders an occurrence, and the definition reads caller-selected local Components through `useFactorySlot()`.

### Opposite registration directions

Ordinary Slots and Component Factories retain distinct ownership models.

| Property | Ordinary Slot | Component Factory |
|---|---|---|
| First declaration | Parent declares a child Slot | Definition owner declares the Factory |
| Later operation | Child registers into the parent position | Parent renders an occurrence |
| Static authority | `SlotMap` describes the position | `SlotFactoryMap` describes the complete definition |
| Live definitions | Multiple entries may occupy cells | One definition owns one Factory name |
| Parent input | `renderSlot()` owner and keyed props | `renderFactorySlot()` occurrence props |
| Parent-selected Component | Registry routing selects entries | Caller selects one Component per local slot |
| Descendant extension points | Entry-owned ordinary `children` | Definition-owned ordinary `children` |

`SlotFactoryMap` declaration-merges the complete static definition:

```text
interface SlotFactoryDef {
  scope: SlotScope
  props?: object
  children?: ChildrenDecl
  store?: StoreDecl
  inject?: object
  locale?: keyof LocaleNamespaceMap & string
  slots?: Record<string, { scope: SlotScope; props?: object }>
}
```

The map is the only type authority. `registerFactory()` checks the runtime definition and main Component against its map entry. Store declarations normalize through `HandleOf`, so registration accepts one shared handle or one factory that produces that handle, never a nested factory. `FactoryComponentPropsOf<F>` and `FactoryLocalComponentPropsOf<F, N>` derive the complete Component props from the same entry; definition owners and consumers do not restate a flattened shared type.

### Definition and occurrence lifecycle

A Factory name has one live definition in a registry ledger separate from ordinary Slot cells. Registration follows the caller's Cordis effect. Disposal removes the definition, collapses its ordinary child declarations, notifies mounted outlets, and invalidates retained child-render or local-Component authority.

Each `renderFactorySlot()` call creates an occurrence whose identity follows its React position and `key`. Definition replacement remounts occurrences. Definition Components and their fallback local Components report failures against the definition, while caller-selected local Components report against the caller registration; nested Factory renders preserve the same owner. All failures remain contained to that occurrence without retiring the shared definition. Assembly errors propagate, while ownership and stale-authorization failures report like ordinary component failures. The outer error boundary resets with the Factory scope incarnation, and each local boundary resets with its local slot's scope incarnation.

Factory scope follows the scope binding at the occurrence's React position. `renderFactorySlot()` accepts no Session id or scope target. A strict `session` Factory requires a current binding and remounts when its identity changes; a `session-maybe` Factory preserves its first empty-to-Session adoption and remounts on later identity changes, matching ordinary Slot behavior.

A shared store handle keeps the ordinary handle-by-scope behavior, including requiring a Session binding for either non-root scope. An exclusive store factory creates one handle when an occurrence first materializes and rejects that handle if it declares `spec.persist`, because registration must remain lazy and independently live occurrences cannot share one persistence key safely. Render-time records stay weak until an idempotent effect setup retains the committed occurrence; effect cleanup removes the strong mounted reference, while the occurrence-keyed WeakMap preserves identity during React effect replay and permits collection after unmount.

### Local slots and ordinary children

The caller may select one Component for each name in the Factory's `slots` declaration. The Factory calls `useFactorySlot(name, fallback)` and receives an identity-stable bound Component that accepts only that local slot's occurrence props. The renderer supplies the Factory's store, injection, locale, child renderers, and the local slot's own standard scope props when the bound Component renders.

Local slots have no list, keyed, or chain routing and no independent registration lifetime. Multi-contributor extension points remain ordinary child Slots declared by the Factory. Those child declarations are global to the definition, while every occurrence renders their registered entries under its inherited scope.

Live inspection represents each definition as a `type: 'factory'` node and nests its ordinary child Slots beneath it. Ordinary nodes retain `type: 'slot'` and their existing `kind`; callers select a Factory root with `factory:<name>`.

Every renderer-created Component receives `renderFactorySlot`, so a Factory occurrence needs no parent-side use declaration. Local selection remains per occurrence and does not introduce a runtime value import from the defining package.

### First shipped use

`ui-conversation` registers the optional-Session `conversation.content` Factory around the shared body and Composer. Its strict-Session `views` local position defaults to an adapter that renders the existing `conversation.session` Slot; another occurrence can select a different view Component without mounting the main Conversation Header.

The Factory does not own the Conversation store. The ordinary `conversation.session` body and `conversation.session.header` retain one shared strict-Session handle, preserving draft and View-selection identity without mounting that handle under both `session` and `session-maybe` scopes.

### Type and runtime enforcement

The type chain rejects unknown Factory names, missing or extra occurrence props, child specs that disagree with `SlotMap`, definition fields that disagree with `SlotFactoryMap`, nested store factories, unknown local names, incompatible selected Components, and overlapping ownership among input, registration, injection, and scope props.

Runtime checks cover dynamically assembled and plain-JavaScript callers: duplicate definitions, child-declaration conflicts, undeclared local names, recursive rendering, prop collisions, stale authority, strict-scope absence, and component failure isolation. Type and runtime tests also pin independent stores per occurrence, shared handles by scope, fallback behavior before registration, definition replacement, local scope projection, and ordinary child rendering.

## Alternatives considered

**Reuse an ordinary Slot as a portable definition.** An ordinary Slot belongs to one parent declaration and one position in the global tree. Reusing it elsewhere would borrow the wrong ownership and lifetime.

**Move the main Conversation Header into the Factory.** Only the main host renders that Header. Keeping it outside the Factory lets embedded occurrences omit it without another local selection and preserves its existing strict-Session Slot lifecycle.

**Move the shared Conversation store onto the optional-Session Factory.** The Header and Session body share one strict-Session handle. Mounting that handle on both the `session-maybe` Factory and the `session` Header would violate the one-handle-one-scope rule.

**Register the same assembly under every parent.** Separate registrations would duplicate the definition and its child declarations. Global contributors would need parallel child names or conflicting declarations.

**Maintain a flattened shared props type.** This repeats facts already present in `children`, `store`, `inject`, `locale`, and scope fields, allowing the declaration and Component props to drift.

**Pass React nodes or render callbacks as business props.** Those values bypass renderer-supplied scope props, store and injection assembly, stale-authority checks, and local Component type checking.

**Give local slots ordinary Slot routing.** Ordinary Slots already own multi-contributor routing. A local slot represents one caller choice for one occurrence.

**Pass Session identity to `renderFactorySlot()`.** The occurrence inherits its render-position scope like an ordinary Slot. A second identity argument would create two authorities that can disagree; independently addressed Session providers are a separate capability.

## Consequences

Feature packages can publish one reusable UI assembly without runtime-importing its Component from consumers. Each occurrence gets independently selected local Components and exclusive state while preserving global ordinary child contributions and the existing scope, locale, injection, and store rules.

The additional registry ledger and occurrence bookkeeping increase renderer complexity. Factory definitions must be globally unique, local slots intentionally support only one selected Component, and the API does not itself create an independently addressed Session scope.

The Factory type and runtime tests are the executable compatibility record. The Slots subsystem reference and the `ui-slots` and `ui-renderer` package references document the consumer API.
