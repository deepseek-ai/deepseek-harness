---
description: "Per-message feedback for the Web GUI: the Like/Dislike pair and optional note in the finalized assistant message's action row; for users and maintainers of the feedback experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-message-feedback

English | [中文](README.zh.md)

## Summary

This package adds per-message feedback to the Web GUI: a Like/Dislike pair plus an optional note, contributed as the `feedback` entry of the finalized assistant message's action strip. It renders on the closing assistant message of each turn — earlier steps of a multi-step turn produce tool rows rather than a rateable body. One controller per Session backs every message control in that Session, so a single list read seeds the whole transcript. Feedback is a sidecar: ratings and notes never enter the session log, the model context, or telemetry.

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

Mount this plugin alongside `ui-conversation`; the Like/Dislike pair then appears in the action row of each turn's closing assistant message, between copy and branch. Clicking the recorded rating retracts the feedback; switching sides carries the existing note forward. The note editor is a dialog popover anchored under its trigger, so the row keeps its single line whether the editor is open or closed.

### Failures

A rating or list-load failure shows inline in the row; a note-save failure shows inside the popover, which stays open so the draft can be corrected. Only finalized messages reach the slot — an interruption-frozen partial carries no `messageId` and therefore no feedback controls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package contributes the `feedback` entry (order 10) of `conversation.chat.assistant-actions`, declared by ui-conversation and rendered inside the finalized assistant message's IconActions row. One `MessageFeedbackController` per Session backs every message control in that Session, so a single `messageFeedback.list` read seeds the whole transcript; the read is deferred to the first hover or focus rather than fired on mount. Mutations go through `ctx.remote.messageFeedback`; the Host owns per-item compare-and-set. Every `put` and `delete` carries the `version` this controller last observed, and a `version-conflict` reply carries the authoritative item, so a lost race reconciles from the reply itself instead of refetching. Mutations serialize per Session, so a queued operation always compares against the committed version.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the feedback surface is not enough. They move from the browser strip to the sidecar backend and the conversation shell.

- [dsh-message-feedback](../../feedback/message-feedback/README.md) — the sidecar backend that owns per-item compare-and-set.
- [ui-conversation](../ui-conversation/README.md) — declares the assistant-actions strip and renders the action row.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as feedback is a sidecar that never enters the append-only Session log, the model context, or telemetry; no rating or note is ever visible to the model.

#### KV Cache effect

None; no feedback mutation touches the history tail.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current feedback surface. They are current package constraints, not a general rating comparison or a task backlog.

- **Note size is a Host policy** — the deployment configures `maxNoteBytes` (8192 in the Web bundle) and the Host rejects an oversized note with `note-too-large`. The editor does not pre-check the limit, so an oversized note fails on save rather than while typing.
- **No cross-tab push** — a second tab's rating becomes visible on reconnect or on the next conflict reply, not immediately; the sidecar publishes no live frames.
- **Chat view only** — the trajectory and waterfall views render no feedback controls even though their assistant nodes carry the same `messageId`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin owns one slot registration and one per-session controller map, both released by the same effect disposer. The lifecycle spec proves the registration is withdrawn and every controller is dropped when the owning fiber is disposed, so no second authority exists to check at runtime.
