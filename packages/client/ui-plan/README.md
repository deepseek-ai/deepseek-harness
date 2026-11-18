---
description: "Plan-mode status chip for the Web GUI: the composer control that shows plan mode is on and turns it off; for users and maintainers of plan mode."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plan

English | [中文](README.zh.md)

## Summary

Plan mode lets you review a plan before implementation. Enter with `/plan` and leave with the composer chip. Submitted plans open automatically in the right sidebar for review and remain available from cards in the completed Turn’s final artifact area after approval, rejection, or dismissal. Reopening a plan focuses its existing tab, and browser reload expires its transient content; reopen it from the plan card.

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

Mount this plugin alongside `ui-conversation` and `dsh-plan-mode`; the chip then occupies the composer's plan seat to the right of the access-mode control whenever plan mode is active. Enter plan mode through the `/plan` command path — choose Plan from the composer's `+` Command menu or type `/plan` — and turn it off with the chip.

### What the chip shows

While the effective target is plan mode, the seat renders the blue "Plan" status button — the plan glyph ahead of the label, swapped for a circled cross while the enabled button is hovered or keyboard-focused — which executes `/plan off`. Otherwise the seat stays empty: a host without plan mode, or a Draft with no session, shows nothing. While plan mode is the effective target, the composer textarea's placeholder switches to the plan-task hint — "describe your task to generate plan" — unless the owning surface supplies its own placeholder.

### Reading submitted plans

When a Turn ends, each submitted plan appears in its final artifact area, using the file-delivery card treatment with a Markdown icon, title, and Open action. A pending plan opens automatically once per submission in the current browser session. Closing it stays effective across review remounts; a new submission opens its own plan. Historical cards open only when clicked. Use the card or review strip’s View full plan link to read the complete Markdown. Plans open in [content preview](../ui-sidebar-documentpreview/README.md#content-previews) tabs, titled with the plan’s first level-one heading. Without the document preview plugin, which provides content previews, the plan chip, cards, and review strip remain, but their open buttons are disabled and their tooltip names the missing plugin. Different submissions retain separate tabs; the review buttons alone decide whether implementation may begin.

A review without a logged invocation also opens automatically. All plan preview text lives only in the current window’s memory, and the pending review card reopens the same tab. Reloading the page loses that text: the restored tab shows the content preview’s expired line, and a review that is still pending can open it again. Plans opened from an embedded child conversation use the visible parent sidebar and a key containing the child Session identity.

### Failures

Admission failures (`matched: false`, business errors, transport faults) surface as an inline error and the chip stays until the projection confirms the exit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The chip occupies the conversation-declared `conversation.input.plan` single seat; the node half is an empty apply (the roster row). Reads ride the generic projection pair through the standard-kit `useProjection`: the effective target is `pending ? !active : active` — a folded host value, not client optimism, so an arriving frame corrects the chip either way. The seat's injected face carries one verb, `exitPlanMode`, which executes `/plan off` through `ctx.remote.commands.execute` and maps admission failures to an inline error line. The placeholder and hint text live in ui-conversation's `conversation` locale namespace and are shared verbatim with the claimed `/plan` command hint.

Plan cards and pending reviews pass their complete Markdown directly to `ctx.contentPreviews.open`, with a Session-scoped invocation key or review key and a title derived from the leading heading. The shared content tab uses the existing sidebar placement, including embedded child plans displayed in the parent's sidebar. `contentPreviews` is optional: cards and review controls remain disabled until it is available. Automatic review opening also waits for `ctx.sidebarRight.mounted`. Navigation input stays in memory; after reload, reopen an expired preview from its plan or review card. Plan cards still derive from logged native or PTC calls through the Conversation Definition and contribute to `conversation.chat.turnTail` alongside file deliveries.

The framework-bound `usePlans(turn)` exposes only submitted-plan data for that Turn. Chat indexes membership on Node updates and orders this collection when read; card rendering neither scans the transcript nor subscribes to other Turns or Node kinds.

Submitted-plan cards follow the [file-card family](../../../docs/ui-radius.md#radius-scale) for their radius and icon-tile material.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the plan surface is not enough. They move from the chip to the plan-mode domain and the composer shell.

- [dsh-plan-mode](../../plan/plan-mode/README.md) — owns plan mode, the `/plan` command, the projection, and the policy section.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.plan` seat and the placeholder locale keys.
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.md#content-previews) — the right-Sidebar content tab that shows plan documents and temporary reviews.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-plan-mode) — the `exit_plan_mode` tool schema the model uses to leave plan mode.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/plan off` command line the chip dispatches: `dsh-plan-mode` owns the model-visible policy section, the exit-tool schema, and the logged state that line drives.

#### KV Cache effect

Entering or leaving plan mode changes the active `plan:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current plan chip. They are current package constraints, not a plan-mode comparison or a task backlog.

- **Plan mode is guidance, not an execution sandbox** — deployments that require enforced read-only planning must compose the independent sandbox and approval policies.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as plan review temporarily replaces the InputBar and its chip.
- **No inactive plan control** — entry uses the shared Command source; a session with the capability but inactive mode shows no plan affordance in the tool row.
- **Preview text expires on reload** — text lives only in memory; reopen it from the plan or review card after reloading.
- **Plan tabs saved by earlier versions are unavailable** — a layout saved before plans opened in content previews restores its `plan` tabs with no tab type to show them, so each shows the right sidebar’s unavailable line until closed; the plan’s Chat card reopens it as a content preview.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
