# Agent Note: Multi-line answers in the question composer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-multiline-question-answer-field.zh.md)

## Problem

`ask_user_question` offers a free-text answer beside the model's own options. On a question that carried options, that answer was a single-line `<input>`: a long sentence scrolled sideways inside one 24px line, Shift+Enter did nothing, and an answer with structure — two requirements, a short list, a paragraph — could not be typed at all. The optionless question already used a textarea, but a fixed 64–140px box that neither followed the draft nor opened wider.

The chat composer next to it grows with the draft and takes Shift+Enter as a newline. A user who has just typed a multi-line prompt there meets a field that silently flattens the same answer.

## Decision

Both question shapes answer into one `AnswerField`: a `<textarea rows={1}>` sharing a single CSS-grid cell with a hidden mirror `<div>` that renders the draft plus a trailing newline.

The mirror sits in normal flow and so sizes the grid row; the textarea stretches to that row, and `rows={1}` keeps the control's own intrinsic height out of the row sizing, leaving the mirror the only input to the height. Soft wraps are invisible to a `'\n'` count, so the mirror is what makes a wrapped answer grow the box rather than scroll one line. The trailing newline covers the last line the textarea's caret can reach and the block container drops. Mirror and textarea must keep identical type, padding, and wrapping rules; a divergence sizes the box wrong for the text being typed.

Growth stops at the mirror's `max-height` of six lines, and past that the textarea scrolls itself. The mirror takes `box-sizing: content-box` against the card-wide `border-box` so that cap counts text lines rather than text plus padding: the optionless variant carries 16px of vertical padding, which under `border-box` spends two thirds of a line and delivers the last one as an 8px sliver, while the inline variant has no padding and would land on a different line count from the same declaration. It is the only scrollport in the stack: unlike the chat composer, this field paints its own glyphs, so there is no second layer whose scroll offset would have to match.

Enter continues the flow and submits the batch on the last question, Shift+Enter breaks the line, and the IME guard is unchanged — Enter during composition confirms the candidate without advancing. The `variant` prop names which of the two looks the field takes, so the field owns both and neither caller assembles one out of class names.

## Alternatives considered

**`field-sizing: content`.** Rejected for the same reason [the composer's Safari recovery](../../archived/bug-fix/2026-08-13-safari-textarea-soft-wrap-reflow.md) rejected it: Safari reproduces a stale intrinsic height after a deletion crosses a wrap threshold. The mirror is a plain block whose height Safari computes correctly, and it is the technique the chat composer ran before its Lexical editor.

**Resize in JS on every keystroke** — set `height: auto`, read `scrollHeight`, write it back. Rejected: it pays two forced layouts per keystroke and reintroduces the stale-geometry class of defect the mirror avoids, in exchange for no capability the mirror lacks.

**Reuse the InputBar stack verbatim.** Rejected because that stack carries a decoration backdrop between mirror and textarea, which forces both layers into one outer scrollport so the caret and the glyphs cannot drift apart. This field has no backdrop, so letting the textarea own its own scroll removes the outer scrollport and that obligation with it.

**A separate expand-to-dialog entry for long answers.** Rejected as unnecessary: growing in place already satisfies the requirement, and a dialog would take the options the answer is an alternative to off screen at the moment the user is weighing them.

**Uncapped growth.** Rejected because the card tops out at `min(60vh, 520px)` and still owes that budget to the title, the option rows, and the footer actions; an unbounded field pushes the choices the answer belongs to out of view.

**A per-variant cap that absorbs each variant's padding.** Rejected because it couples the line count to a padding value: changing `.customBlock`'s inset would silently change how many lines the field grows to. `content-box` states the intent once, in the units the cap is written in.

## Testing

Component tests pin the round trip: both shapes render a textarea, the mirror follows the draft, Shift+Enter never advances the flow, and line breaks reach the answer batch verbatim. The assembled `question-composer` web e2e measures the live engine — a soft-wrapped draft grows the field without scrolling it, two Shift+Enter presses leave `"\n\n"` in a taller field with the question still open, and a draft past the cap scrolls instead of growing at exactly six text lines in both variants.

## Consequences

An answer can now carry the structure the question asks for, and the field the user sees behaves like the chat composer above it. The cost is a second element per field and the standing obligation to keep mirror and textarea metrics identical, which the JSDoc at `AnswerField` states and the e2e growth assertion detects.

The [single-select highlight item](https://github.com/deepseek-harness/deepseek-harness/issues/1687) of the same issue is untouched: focusing the custom field still leaves the previously chosen option visually selected until the first character lands.
