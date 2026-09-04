# Agent Note: Released Session formats migrate on body read through adjacent pure edges

Status: implemented

English | [中文](2026-08-31-released-session-format-migrations.zh.md)

## Problem

Session format v0 shipped in an alpha release, so a structural writer change can no longer treat existing JSONL as disposable pre-release state. Stored event bodies reach consumers through read or write `SessionHandle` instances used by resume, query, export, fork, and continuation paths. Migrating only one consumer would let callers observe different logical generations or fail only when a later writer reaches the old file.

Migration must retain the exact source path, bytes, and inode, including a torn physical tail, while giving every published format one unambiguous canonical filename. Plain JSONL and Zstandard are encoding choices for the same logical format and must not create parallel migration implementations.

## Decision

`SESSION_FORMAT_VERSION` is a monotonic current-writer integer. One profile-independent pure package owns each adjacent `vN -> vN+1` conversion. `@deepseek-ai/dsh-session-format` supplies only lossless snapshots, unique gap-free planning, header-only conversion, and whole-artifact composition; `@deepseek-ai/dsh-session-format-catalog` statically imports the complete chain independently of mounted Cordis plugins. Historical codecs and normalizers live in the named edge package, while current Session and persistence code accept only the latest logical types.

Each edge freezes strict source and target semantics, while its target physical codec remains vocabulary-neutral so ordinary event growth can stay within one format version. The catalog restores the final generation through the installed peer `@deepseek-ai/dsh-session` and its current `KNOWN_SESSION_EVENT_TYPES`, preventing a frozen historical edge from becoming the current vocabulary owner.

The JSONL provider completes ensure-current work before `open` returns a handle for a stored Session. It selects the highest canonical generation, migrates a supported historical body, and decodes the current result from one physical snapshot; the public `SessionPersistence` and `SessionHandle` interfaces contain no migration operations. Header-only `stat` and `list` rescan Session directories, translate supported historical headers in memory, and never publish a successor. `create` checks canonical filenames independently of header readability, so every existing generation reserves its Session id.

Cancellation belongs to the `open`, `stat`, or `list` call that supplied it. Discovery, stable reads, decoding, and pre-publication checks observe that signal; once an immutable successor is published and its directory entry is synced, later cancellation does not delete the committed generation.

The configured JSONL encoding owns one full suffix, `.jsonl` or `.jsonl.zstd`. Migration reads a stable exact source, decodes the recoverable logical prefix, composes every required edge in memory, validates and syncs a same-directory temporary stage for only the final target, rechecks the source fingerprint, publishes that previously absent target without overwrite, syncs the namespace, and reopens it through current validation before returning a handle. The source never moves or changes; only disposable temporary stages may be moved, linked, or removed. Migration does not synthesize interrupted-turn events: agent-loop appends those repairs through the write handle, while read-only query paths balance them in memory.

Canonical filenames encode the physical format generation: v0 is `session.jsonl` or `session.jsonl.zstd`; every positive generation is lowercase `session.vN.jsonl` or `session.vN.jsonl.zstd`. `dsh-session-format` owns the raw basename rule (`sessionFormatLogFilename`, `parseSessionFormatLogFilename`); the JSONL provider, the session-log export archive, and recorded-session fixtures append only the compression suffix. Publication never renames, replaces, or deletes a committed generation path. If the target already exists, it is accepted only as a regular current-format file with exactly the expected bytes; any other target refuses. Lower generations remain for operator inspection or explicit copying, but normal runtime operations select the numerically highest canonical name and never use retained predecessors as automatic fallback, restore, or downgrade support.

The current-format fast path classifies the header from one stable source snapshot, invokes no historical converter or generation write, and passes that snapshot to current decoding without another file read. The decoded log enters the existing bounded revision-keyed memo for an immediate observe-to-resume handoff, while `stat` and `list` deliberately rescan. Multiple edges leave the original generation unchanged and publish only the final target; intermediate versions exist only in memory. A source fingerprint recheck restarts migration when content changes, and exclusive target publication accepts a racing winner only when its bytes match exactly. Cross-process append fencing remains outside this guarantee.

The first edge, `@deepseek-ai/dsh-session-format-v0-to-v1`, is intentionally identity-shaped: aside from the version and bounded historical normalizations already accepted by v0, it preserves logical headers, events, sequence numbers, references, timestamps, payloads, and the configured compression choice. The exact `session.jsonl[.zstd]` source remains byte- and inode-identical, while the current writer encodes the new `session.v1.jsonl[.zstd]` successor. This exercises the complete publication lifecycle before a cardinality-changing format needs it.

Projection-cache records bind their fold to the Session header's `formatVersion`. The `session_projcache` v7 reader may load predecessor domain records structurally, but a record without the format generation cannot seed a current Session; the authoritative log refolds it and the next checkpoint writes the complete current identity. This prevents a cache row produced before a bounded normalizer or cardinality-changing edge from bypassing that migration.

## Consequences

Reading event bodies with a newer build may durably add a higher generation. The exact old generation remains available, but the runtime thereafter selects the highest canonical filename; retention does not promise that an older build can safely downgrade or that the newer build will fall back when the successor is corrupt. A read-only filesystem reports an actionable migration failure instead of returning an in-memory current view that differs from disk.

JSONL publication uses POSIX hard-link creation plus directory sync, and Windows uses no-overwrite `MoveFileExW` with write-through. A competing writer that wins target creation is accepted only when the committed bytes exactly match. One process-local writer per Session is the supported concurrency model. A future per-Session cross-process lock can close the remaining source-check-to-publication race without changing the format edge interface.

Retained generations are not a live-stream write-ahead log. A future optional WAL sidecar may preserve unfinished assistant streams across a hard crash. Explicit generation inspection or copying, retention tooling, compression conversion, and streamed whole-artifact transformation are separate features; automatic fallback and downgrade compatibility are not implied future work.

This note supersedes the continue-only persistence rule and the deferred-chain status in [Session log versioning](2026-08-10-session-log-version-mechanism.md). That note remains the authority for when to bump the version and for ordinary equal-version `ignorable` event behavior.

## Verification

Release verification runs the committed Session-format corpus gate over every versioned persisted-or-projected `session*.jsonl` fixture under `snapshots/`, `packages/`, and `scripts/snapshots/python-sdk-single-exe/`. Fixture-only omitted envelopes and request-header tokens are materialized before the real static catalog; every fixture reaches the current v1 view through current restoration or historical migration. Released-v0 replay inputs remain suffixless, while fresh v1 writer outputs use `session.v1.jsonl` for a parent and `session.<ordinal>.v1.jsonl` for children. Record and refresh preserve every completed generation, including generations of a child role absent from a later run. Malformed historical fixtures are repaired at their source rather than admitted through path-dependent replay policy. The continuing gate discovers the corpus dynamically and fails every restoration refusal; separate assembled JSONL tests own exact physical-byte migration.

Handle-integration verification runs the pure format, catalog, persistence-seam, and JSONL provider suites together: 420 tests cover both encodings, immutable publication races, header-only observation, read and write handles, migration refusal, append after migration, cancellation, and crash-tail behavior with per-file 100% statement, branch, function, and line coverage. Repository typecheck and lint, 113 keyless recorded-session replays with two declared skips, and 28 owner-local expected-output cases also pass on the merged master checkpoint.

The assembled headless profile test stages `session.jsonl`, resumes it through the shipped composition, observes v1 before Session construction, verifies that the exact v0 bytes and inode remain while `session.v1.jsonl` appears, and proves the next append targets v1. JSONL contract tests exercise raw and Zstandard exclusive publication, torn-tail preservation, source changes, target collisions, future-highest refusal, revision-keyed parsed-log reuse, listing rescans, temporary cleanup, committed reopen, and current-format bypass.

## Alternatives considered

- **Migrate only on continuation** — leaves query, export, fork, and suffix consumers on old generations and duplicates restoration policy.
- **Return a migrated in-memory view without persisting** — lets one process observe state that does not match the highest committed generation and postpones failure until a later writer.
- **Persist every intermediate version** — consumes space and creates recovery states with no runtime consumer; only the source and final generation are durable.
- **Let mounted event-owner plugins register migrations** — makes historical readability deployment-dependent; the static catalog must work before feature plugins mount.
- **Reuse one filename for every current format and relocate its predecessor** — rejected because migration would move or overwrite committed evidence, require collision and retention rules, and make the filename disagree with the stored format. Canonical immutable generation names let discovery select the highest version directly.
