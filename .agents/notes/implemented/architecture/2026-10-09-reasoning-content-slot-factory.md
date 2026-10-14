# Agent Note: Standard reasoning Body Slot and reusable Content Factory

Status: implemented

English | [中文](2026-10-09-reasoning-content-slot-factory.zh.md)

## Problem

Reasoning bodies need to let third parties replace or wrap their presentation while reusing the official Markdown renderer, localized labels, and compact typography. An optional renderer parameter that makes the host choose between direct rendering and a chain fallback leaves the default body outside the registration system and forces plugins to maintain another Markdown call.

The render position and the base implementation serve different purposes: the position accepts plugin registrations and lets the framework select one, while any component can call the implementation directly. Calling the base implementation must not repeat plugin selection for that position or require a Session.

## Decision

The design uses existing [Component Factories](2026-09-10-component-factories-and-local-slots.md) and ordinary Slots without adding framework dispatch machinery.

| Name | Type | Owner and responsibility |
| --- | --- | --- |
| `conversation.chat.reasoning.body` | `single`, `session` Slot | Body position declared by the Assistant node registration; receives only original text and streaming state when expanded. |
| `conversation.chat.reasoning.content` | `root` Factory | Standard reasoning content provided by `ui-chat`; accepts text, streaming state, and optional labels, supplies default labels, and fixes `variant="compact"`. |

The Factory receives no Session identity, reads no Session, and owns no translation state. The current Factory API requires `scope`; `root` expresses the absence of a Session dependency, while each render position still has an independent React instance. The Chat plugin registers the Factory independently of any Body occupant, so replacing a body does not remove the base implementation.

### Registration and rendering

1. `ui-chat` registers the Content Factory with component props derived through `FactoryComponentPropsOf`. When the caller omits labels, the Factory constructs stable defaults from Chat's locale seat.
2. The Assistant node registration declares the Body Slot. An expanded `ReasoningRow` only calls `renderSlot`; it accepts no optional renderer, supplies no inline fallback, and does not check whether a plugin is enabled.
3. The official default Body is an ordinary registration with `priority: 100`. It forwards only `text` and `running` to the Content Factory.
4. Third parties wait for the Body declaration through `slots.inject` and register their Body with a smaller priority value. They may call the Content Factory directly and add their own controls around it without importing private official React components.
5. When a third party unregisters, the framework selects the official default registration again. Multiple third-party registrations follow existing single-slot priorities; they do not form middleware or render multiple bodies together.

```text
ReasoningRow
  └─ conversation.chat.reasoning.body
       ├─ 官方默认 Body ───────────┐
       └─ 第三方 Body → 自有控件 ─┤
                                  └─ conversation.chat.reasoning.content
                                       └─ MarkdownText
```

The body render position:

```tsx ignore-check
<div className={css.thinkBody}>
  {renderSlot('conversation.chat.reasoning.body', { text, running })}
</div>
```

The default Body and third-party wrappers use the same reusable implementation; a third party passes labels when it needs custom copy:

```tsx ignore-check
renderFactorySlot('conversation.chat.reasoning.content', {
  text: displayText,
  running,
  labels,
})
```

### Data, state, and lifecycle

- `ReasoningBodyOwnerProps` contains only readonly `text: string` and `running: boolean`. `ReasoningContentInput` also accepts `labels?: MarkdownLabels`; supplied labels are used unchanged without field-level merging, and omission selects the official defaults. Callers own the localization and reference stability of custom labels.
- The Body's `text` is always the original reasoning. A third party selects original or derived display text and passes that value to the Factory without rewriting the Session or Chat projection.
- `ReasoningRow` retains its existing disclosure state, summary, shimmer, and title behavior. Plugin-specific selection state, buttons, and styles stay inside the plugin's Body wrapper; the official implementation supplies no `setHeaderAction`, header-action type, or corresponding state.
- Registrations follow Cordis effect lifetimes. Collapsing the Body declaration removes its contributions through `slots.inject`; unloading the Chat plugin removes the Content Factory.
- Factory components and the default Body have stable module-level identities. Text changes update props instead of rebuilding component types or keys. Plugin replacement or HMR may remount components according to existing framework semantics; unmounted components have no state-retention guarantee.

### Translation plugin integration

The [anonymous translation design](2026-10-05-anonymous-reasoning-translation.md) retains its external-request, privacy, failure, and cancellation decisions; this design supersedes its body composition mechanism. The translation plugin registers in the standard Body Slot, renders original/translation selection, status, and retry controls in its own toolbar, and wraps the official Content Factory with its own state and optional custom labels rather than calling `MarkdownText` directly.

Translation requests, splitting, caching, persistence, and settings remain unchanged. The translation toggle belongs to the plugin body rather than the official Think title. The design adds no Slot outside the body, does not handle user-message masking, and does not change the general Markdown parser.

## Alternatives considered

**Translation-specific chain and host fallback.** The default content is not an ordinary registration, the host maintains a second render path, and third parties cannot directly reuse the complete official body implementation.

**Expose only the Body Slot.** This permits replacement, but wrapping plugins still have to copy the official Markdown call, labels, and variant.

**Provide only the Content Factory.** This permits implementation reuse but supplies no actual body position for third-party replacement registrations.

**Export React components across plugins.** This bypasses existing Factory loading, lifecycle, and type derivation and adds feature-plugin runtime dependencies.

**Name the Factory as general Markdown.** This implementation fixes reasoning-specific compact typography and supplies Chat defaults; it is not a general entry point for all Markdown uses.

**Make the official implementation maintain plugin header actions.** The default body has no such requirement; a dedicated setter makes the host own plugin state, cleanup, and button styles.

**Force official labels in the Factory.** Default copy must not prevent caller customization; an optional parameter provides an override without replacing the whole body implementation.

## Verification

- The body host only calls `conversation.chat.reasoning.body`, with no old `reasoning-body` chain, optional renderer, or inline Markdown fallback.
- Both the default Body and translation Body render through `conversation.chat.reasoning.content`; omitted labels use official defaults, and custom labels reach Markdown unchanged.
- The Factory works without a Session Provider, and two render positions do not share component-local state.
- The official implementation has no header-action type, setter, state, or dedicated styles; the translation wrapper supplies its own selection and retry controls.
- Enabling, disabling, or hot-reloading the translation plugin selects the corresponding Body; default output, original-text access, streaming, disclosure, and cancellation behavior remain consistent.
- Unit and assembly tests cover registration disposal, a Session-independent Factory, default and custom labels, shared implementation reuse, and independent occurrences; existing browser replay covers default bodies and translation switching.

## Consequences

The old Slot name, chain-selector registrations, and header-action callback are unsupported, so third parties must migrate. Test fixtures and the Client inspect catalog must follow the new declarations rather than offer obsolete registration examples.

The Body remains an exclusive replacement position. This design does not automatically compose multiple text-transformation plugins or turn display transformations into redaction or model-input modification.
