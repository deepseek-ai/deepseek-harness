# Agent Note: Persistence export() and pre-release read-path trims

Status: implemented

English | [中文](2026-08-27-persistence-export-and-pre-release-trims.zh.md)

## Problem

The session-persistence seam is moving to a handle-based API with cross-process ownership (open/read/append/flush/close per session). Before that swap, the old seam carried surfaces the new design drops or replaces, each with its own consumers and tests: a consumer-facing path query (`locate`), a capability-flagged verbatim read (`supportsRawArtifacts` + `readRaw`), ~300 lines of same-version legacy event-shape migration in the coordinator, and a `locate`-based size gate for the session list's cold blank probe. Removing them inside the seam swap would bloat an already large change; removing them first shrinks the core swap to the seam itself.

## Decision

**One verbatim export method.** `SessionPersistence.export(id, signal?)` returns the session's raw artifact (`SessionRawArtifact`: parsed header, logical filename, decoded verbatim text) or `undefined`. The base default resolves `undefined`; JSONL overrides it with the former `readRaw` behavior. `supportsRawArtifacts` and `readRaw` do not exist. The apiproxy ZIP download distinguishes an unsupported backend (session present in `list()` but `export()` undefined → 501) from an absent session (404) by list membership instead of a capability flag. Superseded by the [handle seam](../architecture/2026-08-27-handle-based-session-persistence.md): the WebUI download needs only the logical log, so `export()` was removed entirely and the ZIP route serializes JSONL from a read handle, ending the 501 path.

**No consumer-facing path query.** `locate` is not a service method. `SessionLocation` survives only as refusal diagnostics: the JSONL backend derives the artifact path internally so `SessionFormatUnsupportedError` can point at the raw log a build refused. The three consumer features built on `locate` are removed or degraded, not ported:

- `DSH_SESSION_JSONL` no longer exists; shell-env registers no persistence contributor. The variable was only honest with `compression: 'none'` — the default `.jsonl.zstd` artifact is unreadable from bash.
- The Claude Code / Codex hook bridges keep `transcript_path` in the wire payload for protocol shape but always send `''` / `null`. Hook scripts could not parse the compressed artifact either.
- The `locate`-based size gate and the session-controller cold blank probe are deleted. The [handle-based seam](../architecture/2026-08-27-handle-based-session-persistence.md)'s `stat()`/`list()` snapshots may still carry `eventCount`/`sizeBytes`, but listing never opens a body from those hints and has no `coldBlankProbeMaxEvents`/`coldBlankProbeMaxBytes` configuration. A cold row without a current cache answer reports `blank: false` (unknown).

**Legacy event-shape migration is deleted.** Reads validate current v0 records only. Retired event types (`steering/message`, `mode/set`, `request/header-delta`) refuse through the read-side vocabulary gate as `SessionFormatUnsupportedError`. Pre-identity message payloads and the `request/header` `fallback` reason refuse through session validation — surfaced as `SessionPersistenceCorruptionError` on the load/inspect path and as the plain validation error on `readFrom`. Pre-react-loop turn envelopes have no validator: a stale `turn/start.trigger` field and the coarse `aborted`/`disposed` turn-end reasons load unprojected as extension-shaped data, the documented merge-extensible fall-through that the contract test "preserves extension turn/end reasons outside the closed reason set" pins. This consolidates and supersedes the pre-identity-message and pre-react-loop import notes; their record is preserved below.

## Consolidated record of the deleted same-version imports

Two shipped read-side imports existed because message identity (2026-07) and the react-loop refactor (2026-08) changed durable payloads without bumping `SESSION_FORMAT_VERSION`: the coordinator normalized four exact pre-identity message payloads (minting deterministic `legacy-message:<id>:<seq>` identities, with tool-result replacements inheriting their target's id) and projected pre-react-loop shapes (`steering/message` → identified `user/message`, `turn/start.trigger` removal, terminal-reason mapping including a persistence-only `{ kind: 'legacy' }` aborted cause). Both were read-only, exact-shape, and deliberately not a general v0 compatibility layer; their rejected alternatives were stranding first-party sessions, rewriting stored logs in place (violates append-only), and minting unstable identities.

They no longer justify their surface: no tagged release exists, the covered logs are months-old development artifacts, and the mechanism cost ~300 coordinator lines, per-event normalization on every read, a `readFrom` whole-prefix fallback for suffix reads, and fixture suites in three backends. The capability given up: pre-identity logs refuse to load (loudly, with the raw-log path in the refusal) instead of resuming, and pre-react-loop logs either refuse (when they carry the retired `steering/message` type) or load with their stale turn-envelope fields passed through instead of projected to current shapes. Reintroduction condition: after the first tagged release, a durable format change bumps `SESSION_FORMAT_VERSION` and ships an explicit migration under the version gate — never another same-version exact-shape exception. Absence is verified by the vocabulary-refusal tests in the coordinator contract and backend specs.

## Alternatives considered

**Keep `locate` as (or move it to) a separate export-location service.** Rejected: all three path consumers are only functional with compression disabled, so the seam would preserve a half-broken feature; verbatim access needs are served by `export()`.

**Keep the `supportsRawArtifacts` capability flag beside `export()`.** Rejected: `undefined` plus a list-membership check carries the same information with one seam member instead of three.

**Keep the migrations until the first tagged release.** Rejected: the pre-release stance ("remove at the first tagged release") already refuses old on-disk formats everywhere else; the migrations' only beneficiaries are development-era logs.

## Consequences

The seam ahead of the handle refactor is smaller: one export method, no path query, no capability flag, and a coordinator without migration tables. The costs are recorded degradations: hook payload `transcript_path` is never populated (a durable consumer gap in both hook bridge READMEs), the session list marks never-opened cold sessions blank only within the snapshot-metadata probe thresholds, and development-era logs written before the react-loop refactor refuse to load. The 501/404 split for ZIP export costs one `list()` call on the undefined-export path only.

## Related

- [Retain ignorable external session events](../architecture/2026-08-30-retain-ignorable-external-session-events.md) — owns the read-side-only unknown-type gate this change leans on.
- [Session persistence as an abstract service](../architecture/2026-06-14-session-persistence.md) — owns the seam these trims shrink.
- [Zstandard JSONL session logs](../architecture/2026-07-19-zstandard-jsonl-session-logs.md) — owns the frame container these reads and appends flow through.
- [Session identity and log location](../feature/2026-07-10-agent-session-identity-and-log-location.md) — partially superseded: its `DSH_SESSION_ID` and shell-env registry decisions stand; its `locate`/`DSH_SESSION_JSONL`/`transcript_path` decisions are removed here.
