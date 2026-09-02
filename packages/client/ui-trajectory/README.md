---
description: "Trajectory view for the dsh web client: a turn-aware event ledger with an interactive timing overview, registered into the conversation view ring."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-trajectory` is the Trajectory view of the dsh web client: it renders a turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records, plus an interactive timing overview. Thick rules mark Turn boundaries, compact inline markers identify Steps, and selecting a record opens a local inspector for token usage, duration, Input, Output, Timing, and durable images from user, assistant, or tool content. The view is a pure consumer: it registers target-specific Event Definitions, a Trajectory view builder, and one tab in the conversation's `conversation.view` slot ring, and provides no service and declares no Context merge. Its typed `trajectory` locale namespace owns every product-authored ledger, timeline, inspector, tooltip, and accessibility phrase; event content, tool names, identifiers, and provider diagnostics remain verbatim data. Long ledgers open at the current tail, page older history on demand, and mount only the visible row window.

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

Open the Trajectory tab in the conversation's view ring to inspect agent activity as an event ledger and timeline. The ledger covers records with an explicit loading row until the initial tail is positioned; while an older prefix remains unloaded, a first-row control loads one earlier page on click and shows a disabled loading status while that page is pending.

### Inspecting records

Selection, timeline navigation, folding, and search cover the React-visible window. Request numbers and cumulative usage cover the complete resident snapshot. Selecting a record opens a local inspector for token usage, duration, Input, Output, Timing, and durable images. Image URLs use the Conversation-owned per-session cache, so Chat and Trajectory share one authorized read per attachment. A record without text labels its row with the image count. A standalone compaction request appears chronologically in its own `Between turns` section, while a numbered compaction remains inside its owning turn.

### The timing overview

A fixed Overview above the ledger projects real record start/duration timing from left to right; Assistant spans divide recorded TTFT from decoding, and a 500 ms hover reveals exact clock and duration details. Dragging an interval focuses the ledger on every record active at any point in that inclusive range; wheel gestures zoom the time domain; a right-button click clears the selected interval, and a right-button drag pans an already zoomed viewport. The initial view and streaming updates stay at the tail; scrolling upward suspends following so new records do not interrupt inspection of earlier rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The view is a pure projection: Trajectory-owned Definitions assemble business records from the shared Session window — including durable cancellation-finalized prefixes, chunk-only interruption fallbacks, and interrupted Tool records — so Trajectory neither reads nor changes the Chat conversation snapshot. Its steering classifier retains only next-step Inbox IDs through persistent splice state and shares each current claimed batch across later Contexts.

### Virtual rows

Long ledgers initially derive React data from 50 target Nodes ending at the mount-time tail. Later Nodes extend that anchored window without evicting its prefix, and the existing load control reveals earlier resident Nodes before requesting another Session page. Virtualization mounts only the visible row window plus a small overscan; request-only separators share the next measurable virtual item, while semantic row keys and ARIA indexes survive prepends. Content-only stream frames preserve virtual row keys and heights, reuse measurements, and do not issue repeated tail-scroll writes. Completed replies retain assembled blocks, timing, and usage in Trajectory target State, while the shared Session window keeps the raw Events.

### Layout

Trajectory asks the conversation shell to float the composer over the full-height ledger, while its responsive vertical scrollers reserve the composer's live height so final rows remain reachable. Scrollable Summary regions keep their scrollbar thumbs transparent until hovered or focused, without changing the reserved scroll geometry. The package provides no service and declares no Context merge.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the conversation host and the session data this view projects.

- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the `conversation.view` ring.
- [session-projection](../../session/session-projection/README.md) — the projection registry serving client-facing read models of session state.
- [session](../../core/session/README.md) — the session seam whose window holds the raw events.
- [compaction](../../compaction/compaction/README.md) — the compaction seam whose requests appear in the ledger.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the view can show while work is in flight; they are current package constraints.

- **In-flight Time stays blank** — `partial` and `runningCalls` rows show their running state without a fabricated duration, so the Overview renders a start marker rather than inventing a live span. Record and timeline selection are local to Trajectory, with no anchor deep links.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A pure-consumer plugin — it emits no cordis events and owns no mutable cross-plugin state; its view-slot registration is a plain effect whose disposal the slot ledger's own specs and this package's behavior specs observe directly.
