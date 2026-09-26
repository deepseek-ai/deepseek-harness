---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Work-details modes control reasoning previews and process visibility without hiding final answers; Verbose keeps completed-turn process rows visible. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [Hidden Chat rows](#system-prompt-row)
- [Command and failure rows](#command-and-failure-rows)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Grouped rendering](#grouped-rendering)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Chat supplies file and HTTP(S) navigation through one `MarkdownDelegateProvider` around its node list. Assistant Markdown file links open in the right Sidebar after the message settles, including references to unmodified files. Relative paths resolve in the viewed Session's workspace; absolute paths retain the same Session's filesystem access. `#L24` and `#L24-L30` navigate to the first specified line and reuse an existing file tab. Missing files show the preview's error state.

Standalone Markdown images show contained previews and open the shared image lightbox; local paths resolve against the viewed workspace after settlement. Image file links keep their sidebar activation and show a thumbnail after hover dwell or keyboard focus. Escape dismisses the thumbnail. Failed images retain a localized status and their description; no duplicate-image filtering is applied.

Settings → General → Open chat links in selects the destination for ordinary clicks on Chat HTTP(S) links: In-App Sidebar (default) opens a new right-Sidebar Browser tab, while Default Browser opens an external tab. The setting is shown only while the Sidebar Browser is available. If the Sidebar Browser is not registered, both choices use the external browser; modified clicks retain native behavior. The `ui-chat.linkOpening` preference persists on loopback browsers and stays process-local when settings cannot persist writes. Sent file references and skills confirmed by the message’s logged invocation also open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## Hidden Chat rows

Chat omits system-prompt, ordinary Context injection, and `permission` command rows in every work-details mode. Context containing tool additions or removals remains visible. The filter changes neither recorded Session events nor Trajectory inspection. Non-human Turn triggers remain independent notices; other command rows remain in Chat.

When an Assistant attempt retires without a visible message, Chat hides its already-published Node instead of removing its key. A retry in the same Step reuses that key when visible content returns. This also applies when the loaded window lacks the Step start.

<a id="command-and-failure-rows"></a>
## Command and failure rows

Generic command rows retain the ordinary command glyph in every lifecycle state; failure remains explicit through the row state and summary. Every terminal Turn failure renders its inline red-dot row; a quota failure's row states the neutral `message.failure.quota` copy instead of the provider message. The transient notice for a newly appended `QUOTA` or `ACCOUNT_QUOTA` comes from this package's frame-wide entry in `shell.overlay`, which outlives the Chat panel: it offers the one live notice to the `shell.quota-notice` chain and falls back to its own warning Toast, while an entry that claims the code replaces that fallback. Only Sessions this Client has bound and materialized publish; quota failures in Sessions it never opened do not. A newer notice replaces the current one unless a claiming entry retains it with `keepOpen()`: that call returns a release the caller owns and must run on unmount, any live hold keeps the claiming entry mounted and drops later notices, and releasing resumes later notices without replaying the dropped ones. The fallback Toast has no deferral of its own: while the Desktop account's opaque native Platform page covers the document, it still runs underneath and its display timer may elapse unseen, dismissing the notice itself, so only the persistent failure row remains. A release drops only its own hold, so one that runs after a dismissal or a newer hold leaves that newer hold intact. Dismissal and sign-out clear every hold, and dropped notices are not queued while their persistent failure rows still render. History replacement and pagination never publish a notice. Intermediate retries do not create a terminal row; output-token limits use the amber warning dot.

-----

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

Settings → General → Performance & usage stores `ui-chat.performanceUsage` as `detailed` (default) or `compact`. Compact shows only available output speed and cache-hit percentage beneath the composer, without interactive statistic dialogs or per-Turn usage. Detailed exposes session statistics and per-Turn token usage. Neither mode shows elapsed time in the completed-turn footer. The preference changes presentation only; accounting and Session events remain intact.

On non-loopback browsers, the preference remains process-local because the settings scope cannot persist writes. Explicit selections update every consumer immediately; accepted Host settings reconcile the live value on loopback browsers.

Preference menus restore focus to their trigger without scrolling before publishing a new selection.

<a id="completed-turn-footer"></a>
## Completed-turn footer

Artifact extensions can subscribe to one Turn and Node kind through `ChatNodeStore.turnDataSource`. The source includes hidden Nodes and exposes their business data in anchor order. Membership updates incrementally; only observed collections materialize ordered arrays, and unrelated Turns or kinds do not notify them.

The completed-turn action footer follows the recorded Turn end. Its action row starts 20px below preceding prose or extension content. Actions remain visible only on the latest Turn when its final visible content is a reply; other endings and historical Turns reveal actions on hover or keyboard focus. Devices without hover keep actions visible.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

During uninterrupted following, local transcript and steering echoes remain mounted through Inbox acceptance and claim until the durable message arrives, without triggering tail following twice. Pending steering follows Inbox order across clients, using matching local echoes in place. Admitted local steering also suppresses matching stale Inbox rows until the claim projection arrives; steering without a locally tracked submission continues to follow the Inbox projection. After reconnect, Host-owned rows replace receipt-confirmed local echoes; a claim awaiting admission may briefly have no bubble.

When Chat ends with an open Turn control and that Turn has no visible input, the first local transcript echo precedes the control. Other echoes remain at the flow tail. The control and echoes share one keyed list, so arrival of the control preserves the echo's mounted identity. Durable inputs replace their matching echoes in the same render.

Work-details modes control process-group display and reasoning previews. Compact, Standard, and Detailed fold eligible completed Turns without hiding the final answer; Verbose retains the duration/status header without a collapse action and shows historical process rows directly. The [business-rule reference](src/client/conversation-nodes/README.md#display-modes) contains the mode table, title behavior, whole-Turn eligibility, clocks, and disclosure resets.

-----

<a id="grouped-rendering"></a>
## Grouped rendering

Chat registers its process Group Definition through `uiConversation.groups`. React renders the mixed `node`/`group` root sequence through stable Group and Node seats; group headers subscribe to data separately from member arrays. Settled group titles remain independent of the live-detail preference; only running titles update when that preference changes. [Process-group business rules](src/client/conversation-nodes/README.md#process-grouping) define segmentation and activity summaries.

`groupPart` selects reasoning or response in the Assistant renderer without copying Node payloads. A Tool node owns its preparing, dispatched, and result stages under one callId. Each part has a distinct DOM anchor for reading-position restoration; Turn navigation addresses the original Node key and lands on its first visible part. Group sources, member parents, and keys survive display-mode changes and newly loaded prefixes that extend an intact group. The source Node Store remains the only Node-data owner, and a replaced Builder rebinds keyed subscriptions without remounting seats. Mode changes retain size observers and reuse the Turn-state selector.

Live tool deltas share reasoning's frame-batched publication; durable calls and results publish immediately. Repeated named deltas retain the Tool node and its data when the projected call, anchor, location, and visibility are unchanged.

The process group uses a stable `div` layout box, a scroll body, and an uncapped content box that reports growth inside the body. Business styles must adapt spacing within and across groups, including hidden or empty members and the answer-spacing exception. CSS variables do not belong in the Group Definition.

Scroll-edge fades initialize when `ResizeObserver` reports the open group's layout; opening the group performs no immediate scroll-dimension read in a layout effect.

Each group owns local `useDisclosure` state that survives mode changes while its component stays mounted.

The Chat-node slot injects a reset-bound `useDisclosure` Hook for reasoning and tools. Intermediate renderers forward it without subscribing; each invocation owns independent open state. Source callbacks retain their receiver and stable identity. When an enclosing Turn actually hides a process member, its seat resets those disclosures without replacing component keys or changing the Hook reference. Display-mode changes preserve their open state.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts, with browser scroll anchoring disabled on its scrollport only while following the tail. Pinned scroll deliveries without reader movement, and reader input that reaches the exact floor, update follow ownership immediately, before subsequent layout changes can invalidate their floor. Other reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. Submitting transcript input or steering immediately restores tail following and clears an older pending reader sample. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

The turn rail and back-to-bottom button sit outside the clipped transcript. They use the shared conversation scrollport for sticky positioning, or the Chat frame for absolute positioning when Chat owns its scrollport. The rail hides when the transcript's available width, excluding its horizontal padding, is at most 900px; the browser viewport width is not the criterion.

The transcript root uses `overflow-x: visible; overflow-y: clip`: vertical overflow is clipped without creating a scroll container. Sticky Markdown code banners and expanded compaction headers therefore retain the actual conversation scrollport as their reference when no nearer scrolling ancestor exists. Capped process groups and terminal sections keep their own scrollports.

Outer transcript following and each open capped group's following are independent. Native animation progress retains follow intent; a reader gesture interrupts the animation, and actual movement determines whether following remains enabled. Scroll chaining can move the outer transcript, which then applies its own distance threshold. The back-to-bottom button restores only outer following.

| Outer follows | Open group follows | Back-to-bottom button | New content |
|---|---|---|---|
| Yes | Yes | Hidden | Each scrollport follows its own floor. |
| Yes | No | Hidden | The outer transcript follows; the group retains its position. |
| No | Yes | Visible | The group follows; the outer transcript retains its reading position. |
| No | No | Visible | Both retain their reading positions. |

The turn rail mounts only visible marks, overscan, and the focused mark's neighbors. Its fixed pitch and observed viewport size determine scroll offsets without reading the DOM scroll extent. Initial placement waits for the body's restored active Turn and the rail's first usable viewport size. The ref controls activate a Turn or scroll the rail independently; the transcript itself remains fully mounted.

While the pointer is outside the rail, automatic follow keeps the rail still when the active mark's center is inside the fade-free band and centers it after it leaves that band. Previews follow pointer movement or focus; marks scrolling under a stationary pointer do not select another preview.

<details>
<summary>Scroll implementation — click to expand</summary>

Within a process group, wheel, touchstart, and any pointerdown interrupt an active smooth animation, including presses on tool cards. ArrowUp/ArrowDown, PageUp/PageDown, Home/End, and Space keys also interrupt it unless a child has prevented the key's default action; editable controls are not excluded. These events stop the animation without requiring a scroll displacement. Subsequent position sampling determines whether following continues.

`useScrollFollow` supplies independent controllers for shared bottom thresholds, follow intent, and native scrolling. `useProcessScroll` owns group observation, initial placement, and edge fades. Outer following remains immediate; group growth uses native smooth scrolling unless reduced motion is requested. Growth retains an in-flight target until `scrollend`; arrival at that target or its shrink-clamped position continues toward the latest floor, while another endpoint releases following. Opening placement remains immediate. A bottom-follow request within tolerance uses immediate positioning when no animation is outstanding, so a fractional no-op cannot leave a pending smooth target.

`useChatViewport` owns turn-aware DOM reads, clamped writes, native events, and one retained paging anchor. For Load older, Node and Group seats mark eligible anchors from their existing disclosure state. The viewport selects the first nonempty, unhidden marker in transcript order without hit testing or geometry-based search, then measures that element and its scroll containers. It compensates the anchor's capped group first, then gives the remaining displacement to the transcript scrollport. An inner compensation write cancels that group's animation through its bound controller and pauses following; reader scrolling back to the bottom resumes it. Commits and later content resizes reuse that anchor; a remounted row is resolved by the same semantic key. Compensation stays within the actual scroll ranges without adding bottom space.

`useChatReading` owns follow policy, sampled reader input, and semantic memory; `useChatNavigation` owns turn jumps and requests preservation from the viewport. Reading gestures release the paging anchor, but composer clicks, typing, and non-scrolling keys retain it; while a page is still loading, `scrollend` captures the reader's new position. `useChatScroll` coordinates their committed inputs. Explicit navigation carries its measured landing into reading policy, so it does not rediscover the known target with a hit test.

Active-Turn highlighting is approximate: `readVisibleTurn` binary-searches the content column's direct Node/Group boxes and retains the preceding candidate in gaps. It neither hit-tests the document nor searches Group members or all Turn markers. Empty Seats retain zero-height in-flow boxes so outer positions remain ordered without extra spacing. This lookup does not change semantic position capture or paging compensation.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **Tool-change presentation** — The `developer-message` Definition shares context presentation with `input-message`. Tool-only developer messages name a single added or removed tool inline without expansion. Multiple changes show added/removed counts and expand to comma-separated tool lists, one line per change kind. Mixed content uses the generic context presentation.

- **Opening echoes predict local order** — several submissions made before the running update can all remain in Chat. Their initial order follows local submission order, not Host queue order; admission can reposition them when the Host receives requests in a different order.

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
