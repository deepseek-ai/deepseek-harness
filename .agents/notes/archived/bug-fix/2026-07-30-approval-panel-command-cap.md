# Agent Note: The approval takeover shares the composer's text cap

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-approval-panel-command-cap.zh.md)

## Problem

The approval panel is a composer takeover: while a sandbox escalation waits, it replaces the InputBar in the composer seat with the model's justification, the paired command, and a refuse/allow row. Both texts are unbounded model output, and the card had no height cap. A long command — the realistic shape, since escalation happens on the command the sandbox just denied, and a denied command is often a long inline write — grew the card until the action row left the viewport. The user could read the request and not answer it: the buttons existed, off screen, in a sticky footer that had already used the whole column.

The InputBar the panel replaces has always been capped (14 lines, then the textarea scrolls), so the takeover was also the one composer state that could grow without limit — the seat's height jumped on election and jumped back on answer.

## Decision

The panel's justification and command move into one scroll region (`data-approval-scroll`) capped at the same height as the composer's draft area; the amber strip and the action row sit outside it, so both buttons are in the card at every content length.

The cap is one value with two consumers, declared as `--dsh-composer-text-max-height: 336px` on `ConversationRoot`'s `.composerSeat` — the composer chain's only shared ancestor, since the fallback InputBar and an elected takeover render as siblings. `InputBar`'s draft scrollport and the panel's scroll region both read it, so the seat cannot cap its two states differently: what the designer asked for ("unify it with the input box's max height") is now a fact of the stylesheet rather than a number repeated in two files. The region is `box-sizing: border-box` so the cap is its outer height, the same box the composer's draft area occupies.

The region is a tab stop (`tabIndex={0}`, named `role="group"`). Unlike the question composer's scroll body, whose option rows are focusable and pull the container along, this one holds nothing but text: without its own tab stop a keyboard-only user could reach the buttons and never the command's tail, and approve what they could not finish reading.

The panel's card rebinds `--dsh-scrollbar-thumb{,-hover}` to the l2 pair, as every scrolling surface on an elevated background must ([scrollbar contract](../../../../packages/client/ui-theme/src/styles/scrollbar.css)).

## Alternatives considered

**Cap the whole card instead of the text region.** One declaration, no restructuring, and it reads as the literal "same max height as the input box". Rejected because the card holds the strip and the action row: at 336px total the justification and command would get ~250px, less room than the draft they replace, and the numbers would only agree by coincidence of the strip's height. Capping the text region makes both seats top out at the same text height, which is the property that keeps the footer from jumping.

**Cap against the viewport like the question composer (`min(60vh, 520px)`).** The sibling takeover already does this, so it is the local precedent. Rejected because the designer's request was parity with the InputBar, and the two takeovers are not the same shape: the question composer's scroll content is a list of options the user must compare, which wants as much viewport as it can get, while the approval panel's is one command the user skims before deciding. A viewport-relative cap would also make the seat's height jump on election again, in the other direction.

**Ellipsize or truncate the command.** No scroll region, no cap, and the buttons stay put. Rejected because the command is the thing being approved: hiding its tail asks the user to consent to text they cannot read. Truncation is also unrecoverable here — the panel is the whole approval UI, so there is no "show more" surface to fall back to.

**Leave the action row inside the scroll region and cap the region.** Fewer moving parts than pinning the row. Rejected because it reproduces the defect inside the card: the buttons scroll out of the region, and the user has to discover a scrollbar to reach them.

## Consequences

- A long command scrolls inside the card and the refuse/allow buttons stay on screen. Measured on the built client at 900x1000 and 900x700: the region reports `scrollHeight` past `clientHeight`, and both buttons stay inside the card and inside the viewport.
- Electing the takeover no longer changes how tall the composer seat can get, so the transcript above it does not reflow by hundreds of pixels when an approval arrives or resolves.
- The InputBar's 14-line cap now resolves through a custom property inherited from `.composerSeat`, on the box that scrolls its draft ([one scrollport for both text layers](../../archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.md) moved the declaration off the auto-grow mirror). Rendering the bar outside that seat would drop the declaration (an unresolved `var()` with no fallback), so a future composer host has to carry the property — which is why it is declared on the shared seat rather than the app root.
- The scenario's recorded command is a 200-token blob, far longer than a round trip needs. That cost is deliberate: the cap is unfalsifiable without content that passes it, and the model compresses any regular payload (the first recording turned "alpha 400 times" into `printf 'alpha %.0s' {1..400}`, a one-line command that proves nothing).

## Verification

`apps/web/tests/approval-composer.e2e.ts` drives the real composition: a read-only session, a denied write, the model's escalation retry, and the answer clicked through the panel. The geometry assertion runs on the live panel at two viewport heights and is guarded against holding vacuously — the region must actually be scrolling, and the measured cap must equal the composer's own, which the test reads off the live draft scrollport before sending rather than hardcoding the px value.

Confirmed both directions against the built client. With the cap reverted, the region reports `scrolls: false` and grows to the command's full height (1798px for the recorded blob at 900x1000, against 336px capped); at 900x700 the card is 680px tall against a 700px viewport and the action row's bottom lands at y=749 — below the fold, the designer's report exactly. With the cap restored the scenario passes in replay.

Reproducing the off-screen buttons needs a card taller than the scrollport, not merely a tall card. The composer seat is `position: sticky; bottom: 0`, so while the card still fits it stays pinned to the viewport bottom and the buttons remain visible — at 900x1000 the uncapped card ate the whole transcript yet kept its action row on screen. Only once the card outgrows the scrollport does sticky stop being able to hold the bottom edge, and the row goes under.

The geometry block and the golden are replay-only, so record mode reaches the fixture write instead of aborting on layout.

The scenario keeps exactly one golden — the waiting panel — and asserts the answered state on the world instead (the decided outcome, the file the escalated command wrote, `DONE`, the panel gone, the composer re-enabled). An answered-transcript golden cannot hold: the denied first attempt renders the OS's own refusal, and that text is platform-specific (`bash: notes.txt: Operation not permitted` on macOS against `bash: line 1: notes.txt: Read-only file system` on Linux). Any scenario whose transcript contains a sandbox-denied command inherits that, so the denial belongs in assertions, never in a golden.

The panel ships as a client-module bundle: `pnpm run build:web` alone does not pick up a change to `ApprovalPanel.module.css` or a new `data-` hook in `ApprovalPanel.tsx` — the package build must run first, or the browser lane asserts against an older client than the tree.
