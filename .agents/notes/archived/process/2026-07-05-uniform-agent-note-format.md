# Agent Note: One gated in-file format for Agent Notes

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-05-uniform-agent-note-format.zh.md)

## Problem

Agent Note paths encoded lifecycle and class, but file contents still mixed headings, status formats, ADR and proposal templates, and proposal-era sections in implemented records. Authors copied whichever neighbor they found, and lifecycle moves could skip the required rewrite because no gate enforced an in-file contract.

## Decision

[README.md § The file format](../../README.md#the-file-format) is the in-file contract — the header block (`# Agent Note: <title>` plus a dateless, folder-agreeing `Status:` enum whose only content is the rejection reason), the per-lifecycle body skeleton (`Problem` opener everywhere; `Proposal`/`Acceptance criteria`/`Risks` in `proposed/`; present-tense `Decision`/`Consequences` with proposal-era headings banned in `implemented/`; frozen proposal shape in `rejected/`), a mandatory `Alternatives considered` section, and the canonical section vocabulary between which bespoke technical sections stay free-form. `pnpm run verify-agent-note-format` ([scripts/verify-agent-note-format.ts](../../../../scripts/verify-agent-note-format.ts)) enforces every mechanical clause as part of `doc-sync`, so a lifecycle move that skips its rewrite now fails CI instead of review memory.

The whole corpus was normalized in the same change that defined the format — the pre-release stance: no transition period, no dual-format tolerance. The one grandfather is content, not format: alternatives are recorded, never invented, so a pre-format Agent Note whose alternatives are not reconstructible from the record carries the exact `agent-note-format: alternatives-not-recorded` comment, which the gate accepts only for files dated before this Agent Note.

## Alternatives considered

- **A full rigid template** (one fixed section sequence per lifecycle, every Agent Note restructured to fit) — rejected: the big design Agent Notes carry eight to fifteen bespoke technical sections (package topology, wire contracts, schemas) that are load-bearing content, not drift; a rigid sequence would force destructive rewrites now and template-fighting forever.
- **Header-only normalization** (H1 and Status, bodies untouched) — rejected: the debt markers flagged the *body* genre split, and leaving `Context`/`Decision` beside `Problem`/`Proposal` indefinitely resolves nothing.
- **No Status line** (the folder already is the status; the three newest pre-format Agent Notes (and the zh counterpart of one) omitted the line) — rejected in favor of keeping a self-describing file: the drift risk that motivated dropping it is neutralized by gating the line against the folder instead.
- **Dated status** (`Status: implemented (accepted YYYY-MM-DD)`) — rejected: the acceptance date is narrated history the writing rules keep out of docs; the filename carries first-proposed, git carries the rest, and the gate could check a date's format but never its truth.
- **A bare `# <title>` H1** — rejected: the `Agent Note: ` prefix self-describes the genre when a file is read outside its tree, and the format gate prevents it from drifting.
- **`## What we give up` as the implemented closer** (the README's own phrase for what an Agent Note records) — rejected: it names only costs, and an honest consequences section records what the trade-off bought as well.
- **Convention without a gate** (write the contract down, enforce by review) — rejected: the slop checklist already outlawed spec-speak in `implemented/` by convention, and nineteen files show what convention alone achieves here.
- **A standalone `FORMAT.md` contract file** — rejected because one entry point carrying layout, classification, and format is easier to discover and maintain than two contract files.

## Consequences

Every Agent Note now costs slightly more structure, and the mandatory `Alternatives considered` section is deliberate friction: a decision recorded without what it beat invites the re-litigation Agent Notes exist to prevent. Pre-format Agent Notes whose alternatives were not reconstructible carry the grandfather comment permanently — an honest gap on the record rather than fabricated rationale. `doc-sync` gains one gate, and moving an Agent Note between lifecycle folders is now real work at move time (the body rewrite the move always owed) instead of deferred cleanup nothing tracked. The thirty-nine debt markers are gone, resolved by the template they were waiting for.
