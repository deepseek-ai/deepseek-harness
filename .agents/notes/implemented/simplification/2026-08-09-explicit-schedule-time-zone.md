# Agent Note: Explicit Schedule time-zone boundary

Status: implemented

English | [中文](2026-08-09-explicit-schedule-time-zone.zh.md)

## Problem

Implicit local `at` input made a browser fact into shared product state. Capturing a default zone on Session creation required new Session headers, create/resume/fork conflict rules, JSONL metadata, a SQLite migration, client creation plumbing, Host comparisons, and Schedule logic coupled to time-context markers. Travel, concurrent tabs, missing browser-zone records, and old Sessions then needed a confirmation protocol merely to decide whether an omitted field was safe.

Most of that complexity sat outside Schedule. The model already interprets natural language before it calls the tool, so a durable Session default duplicated an assumption instead of strengthening the absolute-time boundary.

## Decision

The browser zone is request-local source data. The Web client samples `Intl.DateTimeFormat().resolvedOptions().timeZone` for every prompt. The Host accepts an optional `clientTimeZone`, validates and canonicalizes `UTC` or an IANA Area/Location at the RPC boundary, and logs it on that exact `user-rpc` message. Invalid values reject prompt admission. Non-browser clients may omit it.

Time-context derives unique, mixed, or missing browser facts from original user-rpc messages in the open turn. A unique zone formats the clock and tells the model to interpret otherwise-unqualified dates and times in that zone. Mixed or missing browser-zone records tell the model to ask the user. The configured or process zone is only a display fallback and is never presented as user authority.

Schedule accepts no implicit local zone. `at` is either a strict offset-bearing RFC 3339 string or exact `{ date, time, time_zone }`. The structured form requires its zone even when time-context just showed the model a browser zone. Schedule does not import time-context, inspect user-message sources, read a Session header, or produce a confirmation error. Its parser validates the explicit value, rejects daylight-saving gaps, chooses the first instant in overlaps, and stores only canonical UTC `scheduledAt`.

No Session time-zone field, create/resume/fork zone conflict, JSONL header field, SQLite column or migration, connection default, or Schedule-specific Host/client presentation remains. The browser assumption crosses into Schedule only through the model's explicit tool arguments.

## Alternatives considered

**Persist the first browser zone as an immutable Session default.** This makes later local input deterministic but spreads ownership across core and persistence, while travel and concurrent tabs still require mismatch handling.

**Use the most recent browser zone as mutable Session state.** This reduces confirmation prompts but lets one tab silently change another tab's interpretation and makes replay depend on update ordering.

**Let Schedule inspect the latest time-context message.** A prose snapshot is model-visible evidence, not a typed package seam. Consuming it would couple Schedule to AgentLoop history and duplicate validation against the original user-message sources.

**Let the Host inject `time_zone` into tool calls.** The Host cannot know which natural-language expression the model interpreted or whether the user named another zone. Rewriting model arguments hides meaning at the wrong boundary.

**Require the model to ask on every unqualified time.** This is safe but unnecessarily interrupts the common browser-local case. The request-local instruction provides the intended assumption while mixed or missing browser-zone records still ask.

## Verification

Host tests pin canonical aliases, omission, and rejection before Agent entry. Client tests pin one browser-zone sample on each prompt. Time-context tests pin unique, mixed, and missing current-turn derivation and exact model policy. Schedule tests pin required `time_zone`, strict offsets, calendar validation, canonical zones, gap rejection, overlap-first selection, and absence of an implicit context path. The assembled Web scenario fixes Playwright to `Asia/Shanghai`, sends through the real composer, observes the same zone in the model request, verifies an explicit local tool call, and snapshots the ordinary reminder response.

Source audits reject `SessionHeader.timeZone`, persistence `time_zone` columns, confirmation errors, Schedule imports of time-context, and independent receipt machinery.

## Consequences

- Browser-local natural language works without a persisted Session-zone subsystem.
- Schedule has one explicit, independently testable absolute-time boundary.
- Travel and concurrent tabs affect only their own prompts; a turn with mixed browser-zone records asks instead of mutating shared state.
- Non-browser clients remain valid but must provide enough natural-language context or explicit tool arguments.
- The model may still make an interpretation error; the tool guarantees only that the explicit calendar value is valid and deterministic.
