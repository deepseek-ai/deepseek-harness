---
description: "Browser Chat target that renders Session conversation nodes, details, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

The browser Chat target for Conversation assembly. It registers Chat event definitions and snapshot construction, supplies `useChat`, renders transcript nodes and details, and owns Chat-specific stores, actions, localization, and scroll restoration; historical image URLs resolve through the Conversation-owned per-session cache (`ctx.uiConversation.imageUrl`). Its Assistant and Turn Tail definitions fold packed historical Assistant runs without expanding their members. Steering classification retains only next-step Inbox IDs through persistent splice state; next-turn splices create no Chat Context. Local submission echoes (`SessionSnapshot.pendingSubmissions`) retain the surface selected when the submit begins: transcript echoes render at the flow tail, steering echoes render with the pending-steering marker, and queued echoes stay out of Chat. Each echo is hidden per render once a user/steering node or queue occurrence carries its prompt `rpcId`, so the handoff is atomic.

## Table of Contents

- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Turn Process Folding](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="system-prompt-row"></a>
## System prompt row

Chat shows a collapsed `System prompt` row for each non-empty initial or resumed request, explicit message-series start, or real system-field change. It does not repeat the row for same-series config-only or tool-only changes, tool steps, or retries. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A partial history window renders a non-initial header conservatively until the preceding page arrives; a header without a system prompt creates no row.

-----

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Settings → General exposes a persisted `Normal` / `Compact` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Normal leaves process rows visible and renders no Turn-process control. In Compact mode, the System prompt remains independently visible before the opening User throughout the Turn. Context injection, reasoning, Assistant material, Tool rows, and Retry rows remain expanded while a Turn is open. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block; preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows then collapse by default. The control reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are omitted, the Tool and subagent figures are mutually exclusive, and neither System prompt nor Context injection contributes a count. When all three counts are zero, the process still folds and the control reads `Thought for a while`. A full-width divider below the summary separates it from the answer or expanded process rows. User and steering messages, System prompt, error, max-token, and turn-tail rows stay outside, and a closed Turn with no final answer keeps all process evidence visible. A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input. While older history remains available through Load earlier, process controls stay absent and no members are hidden; once history is complete, every eligible closed Turn uses the collapsed default immediately. Stable Chat Node Seats keep every renderer mounted, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the group open and leaves focus in place; a manual close focuses the process control before hiding its members. The session-scoped store records only manually expanded Turn-and-answer-Step generations; a different answer generation starts collapsed ([folding decision](../../../.agents/notes/implemented/feature/2026-08-14-web-turn-process-folding.md), [ordering decision](../../../.agents/notes/implemented/bug-fix/2026-08-26-stable-turn-process-order.md)).

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn ([loaded-Turn navigation](../../../.agents/notes/implemented/feature/2026-08-25-loaded-turn-chat-navigation.md)).

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
