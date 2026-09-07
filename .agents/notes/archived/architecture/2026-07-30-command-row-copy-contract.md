# Agent Note: Command row copy is split between the row and the handler

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-command-row-copy-contract.zh.md)

## Problem

The web command row renders `title · summary` from one logged [command lifecycle pair](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md): the title was the dispatched line rebuilt from `command/run` (`/permission workspace-write`) and the summary was `command/done`'s verbatim `text` (`Permission preset: workspace-write.`). Both halves were written without knowing about the other, so the row said the command name twice and its argument twice — the single worst case being the row a user gets for every Access-chip pick.

## Decision

The row's two halves have disjoint jobs, and each side is written to its own half alone.

The row title is the bare command name — no `/`, no arguments. The `/` belongs to the composer's input grammar, not to a settled record, and the argument is not the row's to report: the summary already says what the command did. `GenericCommandCard` keeps the `命令` fallback for a cross-window node whose `command/run` page fell out of the client's window.

A command handler's settlement `text` therefore never labels its value with the command's own name, because the surface that renders it has already said it. `/permission` returns `preset workspace-write`, bare `current preset workspace-write (available: …)`, and for a bad argument `unknown preset "bogus" (available: …)`. Read as a row this is `permission · preset workspace-write`; read as a standalone line — the TUI appends the same text as a notice — it still states which preset now applies.

The rule bans the *label*, not the vocabulary. `Permission preset: workspace-write.` lost because `Permission preset:` is a caption for a value whose caption is already the title. A domain noun that happens to contain the command's name is not a caption and stays: `/plan` keeps `Plan mode off.` and `Plan mode on. Use /plan off to leave.` (`plan · Plan mode off.` names the mode, and the tail is an instruction, not an echo), and `/goal` keeps `Goal cleared.`. A handler that finds itself writing `<Command> <noun>:` in front of its own value is the case this rule catches.

The log is unchanged: `command/run` keeps the structured `name`/`args` split, so a richer registered command row can still render arguments from the same node without a second data channel.

## Alternatives considered

**Keep the dispatched line as the title and only shorten the settlement text.** The argument would still appear on both sides of the separator (`permission workspace-write · preset workspace-write`), which is the repetition complained about.

**Drop the settlement text from the collapsed row instead of the arguments.** It inverts the row's value: the outcome is what a durable record is for, and an error text would then have nowhere to land.

**Have the row strip a leading command name from the settlement text.** Presentation would silently rewrite handler-authored text, and every handler that phrased its outcome differently would defeat the heuristic.

**Ban the command's name from its settlement text outright, rewriting `/plan` and `/goal` to match.** The broader ban costs more than it buys: `Plan mode off.` and `Goal cleared.` are the clearest sentences those outcomes have, in the row and as standalone TUI notices both, and the shortenings that satisfy a name ban (`off.`, `cleared.`) read as fragments. Captions are the redundancy worth removing.

## Consequences

Every command row gets shorter, and the rule scales: a new command's author writes its outcome without knowing which surface renders it, and no surface has to de-duplicate. The cost is that the dispatched arguments leave the collapsed row — while a command is still executing the row shows only its name and `执行中…` — and that the no-caption rule is a convention the reviewer enforces, not a gate. The `/permission` texts are pinned by the permission package's command tests, and the assembled row copy by the [seeded-history](../../../../snapshots/web/seeded-history/command-row.expected.md) web golden, which reaches a real settled command row keylessly because `/permission` runs entirely on the host.
