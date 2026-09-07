# Agent Note: Drop the mutable session summary

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-19-drop-mutable-session-summary.zh.md)

## Problem

The [session-persistence seam](../architecture/2026-06-14-session-persistence.md) split a session's out-of-log metadata into two types owned by `dsh-session`: an immutable `SessionHeader` (`version`, `id`, `createdAt`, `cwd?`, `parentSession?`) written once at creation, and a mutable `SessionSummary` (`updatedAt`, `title?`, `firstPrompt?`) "updateable without touching the append-only log". Their union was `SessionMeta = SessionHeader & SessionSummary`, and the abstract `SessionPersistence` service carried a seventh method — `update(id, summary)` — for rewriting the summary. Each backend implemented the mutable store its own way: JSONL wrote a separate atomic `.summary.json` **sidecar** beside the log (temp-write + rename, best-effort), SQLite kept `updated_at`/`title`/`first_prompt` **columns** bumped inside the append transaction.

The summary was designed for a future session picker (recency ordering via `updatedAt`, a `title`/`firstPrompt` preview). That picker was never built. An audit of the whole repo found the entire `SessionSummary` API is **dead state**:

- `SessionPersistence.update()` has **zero production callers** (every `.update(` hit is `createHash().update()` or a test).
- `firstPrompt` is **never read** anywhere in production.
- Session titles come from durable `session/title` events, while tool-card titles come from tool presenters; neither reads mutable session metadata.
- Persistence-list consumers use immutable header identity, creation, lineage, and cwd fields. Recency and previews derive from the log rather than an `updatedAt` summary.
- Decisively: the live `Session.header` was already typed `SessionHeader`, not `SessionMeta` — the summary never existed on the live session object; it lived only in the persistence layer, written and read by nothing but its own contract test.

## Decision

Delete the mutable session summary entirely. `SessionSummary` and the `SessionMeta` name are absent; the metadata a backend stores and returns is just `SessionHeader`. `SessionPersistence.update()` is absent from the abstract service. The shipped JSONL provider has no summary sidecar machinery (`writeSidecar`/`readSidecar`/`touchSummary`/`removeSidecars`/`sidecarPath` or load/list overlays), and an out-of-tree provider implements the same summary-free service contract.

Anything the summary was meant to provide is **derivable from the append-only log** when a consumer actually needs it (`firstPrompt` = first `user/message`; recency = the last event's `time` or the file mtime) or already lives in the immutable header (`createdAt`, `cwd`). The one thing *not* derivable — a user-*edited* title — had no implementation and is pure YAGNI; it can return as its own log event or header field if a real feature ever needs it.

The removal narrows the public service contract and JSONL on-disk format; the summary was a deliberate forward-looking design, not an accident; and `SessionHeader` stands where the original Agent Note described `SessionMeta`, which is why the summary vanished. It also simplified the then-current [shared persistence write coordinator](../../archived/architecture/2026-06-18-shared-persistence-write-coordinator.md): with no mutable summary, that orchestration needed no `updateSummary` hook.

## No migration

The shipped JSONL provider has no mutable summary format or migration path: it reads and writes only `SessionHeader` plus the append-only log. The repository has no first-party SQLite Session provider. The [JSONL-only persistence decision](2026-08-30-jsonl-only-session-persistence.md) owns the compatibility cut for databases written by the removed provider and directs operators to export them with an older build before upgrading.

## Consequences

A future session picker now has to derive its preview/ordering from the log (or reintroduce a typed field) rather than reading a ready-made summary row. That is the correct cost: a cache for a feature that does not exist is dead weight that every backend pays to maintain and every contract test pays to assert. The principle — **a passing test pins current behavior, not necessarily correct behavior; behavior can be an artifact of a past compromise** — is now recorded as a standalone convention in [root AGENTS.md](../../../../AGENTS.md), with this change as its worked example.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
