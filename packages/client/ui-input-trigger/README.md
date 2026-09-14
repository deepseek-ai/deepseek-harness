---
description: "Input trigger pipeline for the Web GUI: / and @ detection under the caret, the grouped candidate menu, and pick routing to registered sources; for users and maintainers of slash commands and references."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-input-trigger

English | [中文](README.zh.md)

## Summary

When users type `/` or `@` at the caret in the Web GUI, this package opens a grouped menu for slash commands, file references, and session references. It supports keyboard and pointer selection, including drill-down choices and launchers that open a single candidate group over the current selection. A pick either invokes a command flow or inserts a reference for the consuming input surface to handle. The package affects browser presentation only; it does not assemble or send model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation`; the menu then appears in the input overlay when the user types a trigger under the caret. Grouped candidates render under title rows, or under the section headings a source attaches to its own rows; a pick routes to the source, and the consuming surface applies the result — a slash command opens its popup or executes, a reference inserts its inline token. A row shows its icon, its title (the candidate `label`, or the `name` when no label is given), the `name` as a trailing alias when the label is not the name in another letter case, and the description right-aligned; a query matches either the name or the label.

### Keyboard and mouse

The composer surface keeps focus while the menu is open: rows pick on mousedown, the highlight rides `aria-activedescendant`, and a pointer press outside both the menu and the composer card dismisses it. Space and Enter adjudication polls the optional `matchSpace`/`matchEnter` hooks in registration order; the first non-undefined answer wins, and a source can refuse a submission it cannot consume whole. Tab acts on the highlighted completion: a candidate declaring `drill: true` routes through `onPick` with `action: 'drill'`, while an ordinary candidate settles through `action: 'pick'`; without a highlight, Tab passes untouched so native focus traversal survives. A drillable row's trailing chevron exposes the same second verb to pointer users. A source implementing the optional `header` hook additionally publishes crumbs above its group: the pipeline re-polls it on every hit with the live query and whether a drill, rather than typing, produced it, and a crumb pick routes back through `onPick` with `action: 'drill'`.

A source may implement `openReference(session, reference)` to open a draft reference without submitting it. Acceptance may precede asynchronous catalog loading. Chips route by source name; editable tokens route through the current source lexicon. Returning `false`, a missing source, or a disposed controller leaves the editor gesture unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/core/` is the pure core — trigger detection, menu reduction, and exact match, with zero React/DOM/cordis — while `src/client/service.ts` wires the core to the menu snapshot store, the per-hit candidate fetch (generation-gated, `AbortSignal`-superseded, failed sources dropping silently with a console record), and the pick paths. One `InputTriggerController` resolves per session scope (`sessionOf`); the conversation wiring layer drives `track`/`arbitrate`/`onSpace`/`adjudicate` on the controller. A source is warmed into every session controller it can reach; sources whose `lexicon` rolls change after warm implement `subscribeLexicon` and the controller re-polls on each notification. `MenuView` self-registers into `conversation.input.overlay` (list kind, session scope) and renders null while closed. The `listbox` role sits on its scrolling viewport rather than the bounded shell, because a breadcrumb header is not an option and a listbox may not carry one; crumbs ride their own snapshot store beside the menu store, so the frozen reducer stays unaware of them. The overlay SlotMap merge lives here because the dependency direction (ui-conversation → ui-input-trigger) admits no reverse type import.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the trigger pipeline is not enough. They move from the pipeline to the sources that register into it and the shell that owns the input.

- [ui-commands](../ui-commands/README.md) — registers the `/` command source into this pipeline and owns the command popup shell.
- [ui-reference](../ui-reference/README.md) — registers the `@` file and session reference sources.
- [ui-conversation](../ui-conversation/README.md) — declares the input overlay slot and owns the composer and input machine.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the trigger pipeline is browser presentation only — picks produce command claims and reference inserts whose model-visible consequences are owned by the consuming host and input-machine packages.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current trigger pipeline. They are current package constraints, not a general menu comparison or a task backlog.

- **Global source layer only** — session-scope source registration (per-session shadowing) is designed but not enabled; the ledger tracks the trigger condition, a real per-session source need.
- **Overlay SlotMap merge home is split from slot ownership** — the sole `conversation.input.overlay` merge lives here, while ui-conversation owns its anchor, children declaration, and lifecycle because the dependency direction is ui-conversation → ui-input-trigger.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The trigger pipeline is a browser-side pure core (detect/reduce/match) plus a registry whose disposal is proven by the HMR-safety spec; it emits no cordis events and owns no cross-plugin mutable state.
