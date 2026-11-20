# Agent Note: The transcript moves aside for the docked Session panel

Status: implemented

English | [中文](2026-11-16-session-panel-makes-room.zh.md)

## Problem

The [Session panel](2026-11-05-session-panel.md) docked only in a 348px end gutter. With the default transcript width that takes a Chat frame 1576px wide, and the left sidebar takes 280px of the window, so no window under about 1860px docks the panel in the gutter alone. On 1440px, 1512px, and 1728px windows it showed only as the overlay, which closes on the next press outside it. A reader who wants running subagents, background jobs, or change requests in view while working could not keep the panel open at those widths.

## Decision

While the docking preference is on and the end gutter is narrower than 348px, the Conversation body keeps that gutter free: the transcript column and the composer move toward the start edge by the missing gutter, at their own widths, and the panel docks in it. The body makes no room when that would leave less than the column's 32px side inset before it; the panel then hides, and the toggle opens it as the overlay. The column never narrows for the panel. The header toggle turns the docking preference off, which hides the panel and centers the transcript again. Nothing else opts in: the panel docks wherever it has room.

### The body owns the room, and the panel asks for it

[`ui-conversation`](../../../../packages/client/ui-conversation/README.md#end-reserve) owns the transcript's width axis, the scrollport, and the width handles, so it owns the room. A stylesheet asks for it by setting `--dsh-chat-end-reserve` on the Conversation body; the body derives `--dsh-chat-end-inset`, the scrollport's end padding, and `--dsh-chat-end-reserve-max`, the largest reserve the start gutter can give. The panel's stylesheet sets the reserve to 348px through a `:has()` rule that matches while its dock probe carries a mark, so the request needs no Slot prop and no render in the Chat View.

The body derives those lengths from the scrollport's width, which it measures and publishes as `--dsh-conversation-viewport-width`. Three boxes read the inset: the scrollport for its padding, the width handles in the body, and the [`ui-chat`](../../../../packages/client/ui-chat/README.md#scroll-ownership) aside layer, which reaches back across the inset so the panel sits at the scrollport's end edge. A length written with percentages resolves against a different box in each of them, and the scrollport's own content box changes with the inset. A measured pixel width gives all three the same value and does not change when the inset does.

### One probe whose answer does not depend on the room made

The panel's dock probe is 1px wide while the gutter holds the panel, or while the body's largest reserve covers that gutter. The second term reads the scrollport's width and the content width, not the inset, so the answer is the same before and after the transcript moves: the room the transcript makes cannot change the decision that asked for it, and the layout cannot oscillate. The plugin's state, its toggle, and its overlay rules are those of the gutter-only panel; only what its stylesheet counts as room widened.

### Width handles beside the docked panel

The handles follow the column: their positions take half the inset, and each takes its width from the gutter on its own side. While the body makes room, the reserve holds the column's end edge, so a drag moves only the start edge, and the width changes by the pointer's travel instead of twice it, on either handle. A column dragged wider than the start gutter can give takes its room back: the panel hides and the column centers, as a column dragged wide already hid the panel docked in the gutter.

### One motion for the panel and the transcript

A press that shows or hides the panel plays its entrance or exit, and the transcript moves over the same 160ms and curve: the panel's stylesheet sets `--dsh-chat-end-reserve-transition` on the Conversation body while the animation runs, and the scrollport's padding and the aside layer's margin both take their transition from it. The panel tells a press from a change of room by comparing renders: what it shows changed while its room stayed the same. A change of room shows or hides the panel at once, which covers a mount, a switch to another Session, a resized window, and a dragged transcript width.

## Alternatives considered

- **A pin that opts in to making room.** The panel would dock at laptop widths only after the reader found and pressed a pin on it. In a wide window the pin changes nothing visible, and until it is pressed the default at laptop widths stays an overlay that closes on the next press. The panel docks wherever it can instead, and the toggle is the one control that hides it.
- **Narrowing the column for the panel.** A floor such as 480px docks the panel in narrower frames, but it changes the reading width without the reader asking and makes the column's width depend on the panel as well as on the width the reader dragged. The column keeps its width, and a frame that cannot give the room shows the overlay.
- **The docked panel covers the transcript.** It needs no layout change, but on a 1440px window the panel covers about 83px of the transcript column, and the actions at the end of each message, for as long as it shows.
- **A measured reserve passed through Slot props.** The Conversation body, the Chat View, and the aside would each forward a callback for one consumer, and every change of the reserve would render the Chat View. A custom property needs neither.
- **Percentages without a published width.** The inset would differ between the scrollport, the width handles, and the aside layer, and the largest reserve would read a width that the inset itself narrows.
- **A second probe and a room type in the plugin's state.** The plugin would track the gutter and the reserve apart. Nothing reads them apart, so one probe reports their union and the plugin's interfaces stay as they were.
- **No width handles while the transcript makes room.** The handles' positions stay simple, but the panel docks by default at laptop widths, so the reader would lose the width drag there.
- **A transition that is always on.** The inset follows the window and the dragged width every frame, so a standing transition makes the transcript trail the pointer during a resize or a width drag, and it would animate across a Session switch. The transition is on only while a press shows or hides the panel.
- **Animating when the window crosses the width that makes room.** The inset steps there inside the stylesheet, one frame before the panel learns of it, so the transcript would jump while the panel animated. Both change at once instead.
- **Making room in embedded Chat Views.** An embedded transcript's width is a percentage of its frame, so the inset would need that frame's own measure, and embedded frames are rarely wide enough. An embedded Chat View makes no room.

## Consequences

- The panel stays beside the transcript at laptop widths without a press. On a 1440px window with the sidebar open, the 742px column keeps its width and sits 143px toward the start edge while the panel is docked.
- A reader who wants the transcript centered hides the panel from the toggle.
- With the default transcript width the panel docks from a Chat frame about 1068px wide; below that, and beside a transcript dragged wide, it is the overlay it was.
- A width drag beside the docked panel moves one edge of the column, not both.
- The transcript's motion re-lays it out on each of about ten frames. Beside the longest recorded Session, 790 elements, no frame took longer than 9.3ms; a much longer transcript has not been measured.
- `ui-conversation` publishes the scrollport's width and two derived lengths, pads its scrollport's end, and moves its width handles; `ui-chat`'s aside layer has an end margin and a gutter that counts the inset. Neither renders or observes anything more for them.

## Testing

Unit specs read the three stylesheets and evaluate the reserve, the inset, the gutter, the probe, and the handles around their boundaries, and drive a width drag at both scales. `apps/web/tests/session-panel-layout.e2e.ts` measures the shipped Web composition: the column, the composer, the width handles, the probe, and the panel across the gutter that holds the panel, the frames that make room, the last frame that can and the first that cannot, a reload, the toggle, and width drags that keep, lose, and regain the room.
