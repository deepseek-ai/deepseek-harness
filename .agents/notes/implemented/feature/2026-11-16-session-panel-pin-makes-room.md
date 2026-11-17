# Agent Note: A pinned Session panel has the transcript make room

Status: implemented

English | [中文](2026-11-16-session-panel-pin-makes-room.zh.md)

## Problem

The [Session panel](2026-11-05-session-panel.md) docks only in a 348px end gutter. With the default transcript width that takes a Chat frame 1576px wide, and the left sidebar takes 280px of the window, so no window under about 1860px docks the panel. On 1440px, 1512px, and 1728px windows it shows only as the overlay, which closes on the next press outside it. A reader who wants running subagents, background jobs, or change requests in view while working cannot keep the panel open at those widths. The docking preference does not help: it says whether the panel shows where it already has room.

## Decision

The panel carries a pin: a toggle button in its top end corner, one preference for every Session, persisted in `localStorage` under `dsh.sessionPanel.held` and off by default. While the pin and the docking preference are both on and the gutter is narrower than 348px, the Conversation body keeps that gutter free. The transcript column and the composer move toward the start edge by the missing gutter at their own widths; once the column is 32px from the start edge it narrows instead. The panel then docks, and neither Escape nor an outside press hides it. The body makes no room when that would leave the column under 480px, a Chat frame under 860px; a pinned panel then behaves as an unpinned one until the frame is wide enough again. An unpinned panel behaves as it did.

### The body owns the room, and the panel asks for it

[`ui-conversation`](../../../../packages/client/ui-conversation/README.md#end-reserve) owns the transcript's width axis, the scrollport, and the width handles, so it owns the room. A stylesheet asks for it by setting `--dsh-chat-end-reserve` on the Conversation body; the body derives `--dsh-chat-end-inset`, the scrollport's end padding, and `--dsh-chat-end-reserve-max`, the largest reserve that leaves a 480px column. The panel's stylesheet sets the reserve to 348px through a `:has()` rule that matches while its gutter probe carries a mark, so the request needs no Slot prop and no render in the Chat View.

The body derives those lengths from the scrollport's width, which it measures and publishes as `--dsh-conversation-viewport-width`. Three boxes read the inset: the scrollport for its padding, the width handles in the body, and the [`ui-chat`](../../../../packages/client/ui-chat/README.md#scroll-ownership) aside layer, which reaches back across the inset so the panel sits at the scrollport's end edge. A length written with percentages resolves against a different box in each of them, and the scrollport's own content box changes with the inset. A measured pixel width gives all three the same value and does not change when the inset does.

### Two probes that do not depend on the pin

The panel reports two facts through 1px probes: its gutter holds it as the transcript stands, and the transcript can make that room. The gutter that the aside layer publishes counts the inset, and the gutter probe subtracts it, so a gutter the transcript made reads as no gutter. The plugin combines the facts with the pin: a panel can dock when its gutter holds it, or when the pin is on and the transcript can make room.

Keeping both facts independent of the pin gives the plugin what it needs before a press. It offers the pin on an overlay only where pinning would dock the panel. When the reader unpins a panel that only the pin kept beside the transcript, it knows the panel is about to lose its place and leaves it open as the overlay instead of removing it under the pointer. The room the transcript makes cannot change the decision that asked for it, so the layout cannot oscillate.

### The pin and the docking preference stay separate

The header toggle still hides and shows a pinned panel by flipping the docking preference, and hiding it gives the room back. Pinning also turns the docking preference on, because a reader who pins a panel wants it shown. The docking preference keeps its `localStorage` key, `dsh.sessionPanel.pinned`, so stored choices survive; the plugin's state calls it `docks` and the pin `pinned`.

## Alternatives considered

- **A pinned panel covers the transcript.** It needs no layout change, but on a 1440px window the panel covers about 83px of the transcript column, and the actions at the end of each message, for as long as it is pinned. A panel kept open for a whole Session must not hide part of every reply.
- **Making room whenever the panel shows.** It changes the transcript's position and width for every reader at laptop widths without a request. The [panel's own decision](2026-11-05-session-panel.md) keeps the transcript untouched by default, and the pin makes the trade the reader's choice.
- **A measured reserve passed through Slot props.** The Conversation body, the Chat View, and the aside would each forward a callback for one consumer, and every change of the reserve would render the Chat View. A custom property needs neither.
- **Percentages without a published width.** The inset would differ between the scrollport, the width handles, and the aside layer, and the test for a 480px column would read a width that the inset itself narrows.
- **One probe whose rule follows the pin.** The plugin would not know whether an unpinned overlay can be pinned, or whether unpinning leaves the panel without room.
- **Width handles while the transcript makes room.** The handles sit at the centered column's edges and a drag widens the column about its center. With the column's end edge held by the reserve, a drag would move only the start edge, at twice the pointer's speed. The handles do not show until the transcript centers again.
- **Making room in embedded Chat Views.** An embedded transcript's width is a percentage of its frame, so the inset would need that frame's own measure, and embedded frames are rarely 860px wide. An embedded Chat View makes no room.

## Consequences

- A reader can keep the panel beside the transcript on laptop widths. On a 1440px window with the sidebar open, the 742px column keeps its width and moves 143px toward the start; on a 1280px window it narrows to 613px.
- Below an 860px Chat frame the pin has no effect, and the panel is the overlay it was.
- The width handles do not show while the transcript makes room; the reader unpins or hides the panel to drag the width.
- `ui-conversation` publishes the scrollport's width and two derived lengths and pads its scrollport's end; `ui-chat`'s aside layer has an end margin and a gutter that counts the inset. Neither renders or observes anything more for them.
- Each mounted panel observes two probes instead of one; both call back only when a decision flips.

## Testing

Unit specs read the three stylesheets and evaluate the reserve, the inset, the gutter, and both probes around their boundaries. `apps/web/tests/session-panel-layout.e2e.ts` measures the shipped Web composition: the column, the composer, the width handles, the probes, the panel, and the pin while pinning, narrowing to the 480px column, crossing that boundary, reloading, hiding from the toggle, and unpinning.
