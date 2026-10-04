# Agent Note: Windows-native durable JSONL publication

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-05-windows-jsonl-durable-publish.zh.md)

## Problem

`dsh-session-persistence-jsonl` publishes a session log lazily on the first append. The POSIX protocol writes a temp file, fsyncs it, links it to the final name, fsyncs the parent directory, and then removes the temp link. The parent-directory fsync is part of the durability contract: a crash after the namespace change must not lose the committed final name while leaving callers believing the session log materialized.

Windows has atomic namespace operations, but Node does not expose a POSIX-equivalent parent-directory fsync contract there. Treating Windows directory sync failures as success would silently weaken a durable backend. The Windows path therefore needs a different publication primitive rather than a conditional inside the POSIX `syncDir` helper.

## Decision

The JSONL backend forks inside `materialize()` before any namespace mutation. Shared code computes the session directory, final log path, and encoded header plus initial event batch; POSIX and Windows then run separate publication protocols.

POSIX keeps the existing protocol: create the root, project directory, and session directory with parent directory fsyncs, write and fsync a temp file, publish with `link()` so an existing final log is never overwritten, fsync the session directory, then remove the redundant temp hard link.

Windows creates missing directories through a durable staging publish: create a random sibling directory under the constant `.dsh-mkdir-` prefix, independent of the target basename, then publish it to the final directory name with `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without `MOVEFILE_REPLACE_EXISTING` or `MOVEFILE_COPY_ALLOWED`. File materialization writes and fsyncs the temp log, then publishes that temp file to the final path with the same write-through `MoveFileExW` call and no replacement. `koffi` is the minimal Win32 bridge for this API; its install script is allowed in `pnpm-workspace.yaml` because the package ships the native loader and prebuilt platform modules.

## Alternatives considered

**Ignore Windows directory-sync failures.** Rejected because it reports a first append as durable without forcing the published namespace entry to stable storage.

**Use `CreateHardLinkW`.** Rejected because hard links are filesystem-dependent, do not publish directories, and expose no write-through option.

**Use replacement or transactional APIs.** `ReplaceFileW` has replacement semantics that conflict with same-id collision rejection, and Transactional NTFS is not recommended for new application designs.

## Consequences

The backend keeps one external contract across platforms: first append either publishes a complete log at the final name or fails without overwriting an existing log. The platform split is an implementation detail; `SessionPersistence` APIs and the logical JSONL record format do not change. The later [Zstandard encoding decision](2026-07-19-zstandard-jsonl-session-logs.md) applies before either platform publishes the opaque bytes.

Windows tests exercise the real Win32 publish path on native Windows. Power-loss behavior remains an API-contract property rather than something unit tests can prove; the testable invariants are that directory fsync is not called on Windows materialization, final-path collisions fail, maximum-length target components remain materializable, temp logs are fsync'd before publication, and the resulting log loads normally.

Append and repair still use ordinary file-handle fsyncs on both platforms. A failed append closes its append-only handle, reopens the log read/write, truncates it to the pre-append size, and fsyncs the rollback because Windows rejects `ftruncate` on append-only handles.
