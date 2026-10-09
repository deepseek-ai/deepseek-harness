---
description: "Durable workflow-run Conversation Node for the dsh web client: reconstructs top-level workflow runs as independent chat nodes with nested member disclosure."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workflow-run

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-workflow-run` to inspect each durable top-level workflow run as an independent Chat node. Expand a run to see its phases and expand a phase to see members; running, failed, cancelled, and interrupted levels open by default, while completed levels remain closed. A running member can open its child Session only when it belongs to the current Session and is available locally. The node shows identities and statuses only; scripts, outputs, errors, logs, usage, topology, and controls remain outside this surface.

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

A top-level workflow run through `dsh-tool-workflow` appears in the conversation as its own node: expand the run to see its phases, and expand a phase to see its members. Phase groups come only from members that started, and settlement changes status without removing or reordering members.

### Navigating the node

Run and phase headers keep 6px gaps between their title, count, and status fields, with the status aligned to the right. The run uses a 32-pixel row with persistent chevrons, an inline state dot, and status text; phases use disclosure rows with title and member count in the main area and a fixed aggregate-status tail; members use a 16-pixel dot slot, a truncating name area, and a fixed status column. Opening a member's child Session requires both member and child to be running, with the current Session recorded as its parent and an available child identity projection. Navigation uses the child's own mode for both continuable and historical one-shot children; external executions have no local Session to open. Child activity uses the unified UI status, falling back to the Session summary when unknown. Workflow events establish membership; missing child identity, a different parent, or a terminal member keeps the row non-interactive.

### State and completion

Completion updates the visible status immediately but delays its automatic close while focus remains inside the content. A run or member without terminal events stays running after its Turn or Step ends normally, because a background run outlives its Tool Step. It is presented as interrupted, without changing the tool result, once its Turn is closed after a crash or at a fork boundary.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node is a deterministic replay of durable session events: `tool-workflow/run-start` creates one Context keyed by `runId`, and member starts, member endings, and the run ending update that Context in log order. A history tail containing only updates remains pending until an older page supplies the unique start, after which prepend, complete replay, and live append produce the same state.

### Disclosure choices

Ordinary running updates preserve the current choice, the first abnormal edge opens once, normal completion closes once, and a completed phase plus the outer run open again when a new running member starts under the same phase key. If an entire new clean cycle arrives in one render while the run remains active, the phase finishes folded but the outer run opens once to expose its updated summary. `WorkflowRunPanel` owns the phase choices, so closing and reopening the outer run does not reset them; a renderer remount reconstructs every initial choice from durable facts.

### Composition

The package registers its Definition, locale dictionary, and `workflow-run` renderer as Cordis effects; removing the client entry retracts all three contributions. The shipped Web bundle includes the plugin after `ui-conversation` and `ui-tool`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tool seam, the conversation host, and the tool presentation layer.

- [tool-workflow](../../workflow/tool-workflow/README.md) — the tool that owns the four `tool-workflow/*` Session events.
- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the `conversation.chat.node` slot.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer this node sits beside.
- [Conversation subsystem](../../../docs/subsystems/conversation.md) — how a business-owned feature registers a Conversation node.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that renders durable workflow records without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define which runs produce records and what the node exposes; they are current package constraints.

- **Only top-level calls through `dsh-tool-workflow` produce these records** — nested PTC mode calls and direct `WorkflowEngine` consumers do not.
- **A run lost without terminal events in a normally ended Turn stays running** — for example a background run whose process crashed during a later Turn, or a run whose recording stopped after a failed append; the session log carries no fact that marks it stopped.
- **Navigation is intentionally live-only** — terminal members remain visible for review but never expose a cold-session opener from this node.
- **The node shows run, phase, member identity, and status only** — scripts, outputs, errors, logs, usage, static topology, and controls remain outside this surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
