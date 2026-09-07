# Agent Note: Project-grouped session directories

Status: implemented

English | [中文](2026-07-24-project-session-directories.zh.md)

## Problem

A persistence root may be local to one project, shared by several projects, temporary, or centralized. The hashed cwd buckets kept all deployments functional but made a shared root difficult to navigate because a developer could not recognize a project from its directory name.

Each JSONL session also occupied one file directly inside the project bucket. That shape had no ownership directory for additional session artifacts such as metadata, attachments, spill files, or coordination state.

## Decision

The JSONL backend stores sessions under a readable project key and gives every session its own directory:

```text
<configured-root>/
  --<normalized-cwd>--/
    <encoded-session-id>/
      session.jsonl.zstd
```

Raw mode uses `session.jsonl`, and sessions without a cwd use `_no-cwd`. Filesystem and drive separators become `-`, unsafe code units use `~XXXX`, and the readable name is bounded to keep the component within filesystem limits.

The project key intentionally has no hash suffix. This follows the common human-readable convention used by coding agents and keeps the normalized project path as the complete directory name. The normalization is lossy: paths such as `/a/b-c` and `/a-b/c`, or long paths with the same retained prefix, share one project directory. Their distinct session ids still select separate session directories; reuse of the same session id remains a storage collision and is rejected.

Case-insensitive filesystems can also make differently cased project keys refer to one physical directory. Identity validation accepts such an alternate spelling only when filesystem canonicalization resolves the discovered and expected paths to the same transcript. A different canonical path remains corruption, so case aliases do not weaken the same-id collision check on case-sensitive stores.

The configured root remains a deployment choice. The layout neither selects a global root nor requires projects to share one. When a deployment does centralize storage, project paths remain recognizable; a project-local root uses the same deterministic structure.

The encoded session id names an ownership directory rather than the transcript itself. The backend's diagnostics-only `locate` hook resolves the fixed transcript path inside it for format-refusal messages ([export and pre-release trims](../../archived/simplification/2026-08-27-persistence-export-and-pre-release-trims.md) owns removing the consumer-facing path query). Discovery ignores other entries inside the session directory so the backend can add session-owned artifacts without another layout change.

Lazy materialization remains tied to the transcript: `create()` performs no filesystem I/O, and the first append creates the project/session directories before collision-safe transcript publication. Empty directories are not listed as sessions. The backend rejects flat `<project>/<id>.jsonl*` artifacts with an explicit layout error; the pre-release format provides no automatic data migration.

## Alternatives considered

**Keep opaque cwd hashes.** This preserved short names but defeated the requested navigation by project path when several projects share a persistence root.

**Put session files directly in each project directory.** This matched Claude Code and pi's basic file organization but left no session-level ownership boundary for future artifacts.

**Add a collision-resistant hash suffix.** This distinguishes paths whose normalized forms collide, but makes the directory name more than the normalized project path. The chosen convention accepts lossy project grouping in exchange for the simpler, recognizable name.

**Mandate a centralized root.** Rejected because storage placement belongs to deployment configuration. Project grouping is useful when roots are shared and harmless when they are not.

**Load both flat and directory layouts.** Rejected under the pre-release no-compatibility stance. One accepted layout keeps identity checks and discovery deterministic.

## Consequences

Shared stores can be navigated by recognizable project names, while local and custom roots keep their existing configuration freedom. Every session has a directory available for future backend-owned artifacts, and existing transcript consumers still receive a file path.

Project directory names are longer than the former 12-hex cwd hashes. Very long paths show only a bounded prefix. Moving a project usually selects a different directory, but distinct cwd strings that normalize to the same name share one project directory by design.
