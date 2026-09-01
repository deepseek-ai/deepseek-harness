---
description: "Durable workflow-run Conversation Node for the dsh web client: reconstructs top-level workflow runs as independent chat nodes with nested member disclosure."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workflow-run

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-workflow-run` is the browser plugin that reconstructs durable top-level workflow runs as independent Chat nodes in the dsh web client. It consumes the four `tool-workflow/*` Session events owned by `dsh-tool-workflow`, registers one `ConversationNodeDefinition`, and renders through the keyed `conversation.chat.node` slot without changing the existing workflow tool card. The run and each phase are controlled disclosures: a mount opens running, failed, cancelled, and interrupted levels and closes fully completed levels, and users can toggle either level with the full row, Enter, or Space. A member opens a child Session only while every current fact agrees, and the node shows run, phase, member identity, and status only.

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

The run uses a 32-pixel row with persistent chevrons, an inline state dot, and status text; phases use disclosure rows with title and member count in the main area and a fixed aggregate-status tail; members use a 16-pixel dot slot, a truncating name area, and a fixed status column. Opening a member's child Session requires the member to be running, the child id to be in the ordinary Session list, the row to have `origin: 'subagent'`, its `parentId` to be the current Session, and the list row to still be running — remote, addressed-only, wrong-parent, or terminal rows remain non-interactive.

### State and completion

Completion updates the visible status immediately but delays its automatic close while focus remains inside the content. A closed Turn or Step with missing terminal events presents the affected run or members as interrupted without changing the tool result.

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
- **Navigation is intentionally live-only** — terminal members remain visible for review but never expose a cold-session opener from this node.
- **The node shows run, phase, member identity, and status only** — scripts, outputs, errors, logs, usage, static topology, and controls remain outside this surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The browser plugin contributes one effect-owned Conversation Definition, keyed renderer, and dictionary; tests prove their disposal and the Host tool package owns the durable event invariant.
