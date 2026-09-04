# Agent Note: Load all instruction candidates with per-directory dedup

Status: implemented

English | [中文](2026-07-21-instruction-load-all-dedup.zh.md)

## Problem

The [agent-instructions plugin](2026-06-24-workspace-context.md) resolved one winning file per candidate list per directory: the first existing name in `instructionFileCandidates` won the base slot, and the [local overlay](2026-07-21-local-instruction-overlay.md) added one more winner. But `AGENTS.md` and `CLAUDE.md` routinely coexist in the same directory. In most repositories one is a symlink to the other, so they carry identical content; in repositories mid-migration they are two distinct real files that have drifted apart. First-wins silently dropped the non-winning committed file, so a directory that legitimately carried two distinct instruction files only ever surfaced one — and which one depended on candidate order, not on content. The request was to read both and deduplicate only when they are effectively the same file.

## Decision

Every existing candidate in each list loads — the base list first, then the local list — in configured order. Within one directory, candidates whose content is byte-identical after trimming leading and trailing whitespace collapse to the earliest candidate in that order, and the kept file's original bytes are rendered. Dedup is per-directory rather than global, and symmetric across the base and local lists. Trimming before comparison tolerates a trailing newline or indentation difference between a file and its near-copy while still rendering the survivor verbatim — the "extra safe" comparison the request asked for.

Symlinks now flow through this uniformly. Instruction discovery resolves each candidate and stats its target instead of rejecting a final-component symlink, so a `CLAUDE.md` that symlinks its sibling `AGENTS.md` resolves to identical content and collapses here like any byte-identical real duplicate. Content dedup therefore renders the common symlink-mirror once through the same path as a real copy. The [follow-symlinks note](2026-07-21-follow-instruction-symlinks.md) owns that reversal and its residual trust-boundary risk.

## Scope keys become per-candidate

Each `(directory, candidateName)` pair is now its own logical scope, encoded `directory\u0000candidateName` with a NUL separator that cannot occur in a real path. `candidateScopeKey` / `decodeScopeKey` own the encoding, and `probeScopeInstruction` decodes the candidate name to read exactly that file. This replaces the tier-sentinel scope key the overlay note introduced: a directory no longer has a "base scope" and a "local scope" but one scope per candidate name, so `AGENTS.md` and `CLAUDE.md` in one directory are independent scopes that reconcile separately.

Because a scope now names one fixed file, the previous "candidate switch within a scope" — an `AGENTS.md` scope that fell through to `CLAUDE.md` and recorded the old name in `previousPath` — can no longer occur. `previousPath` was removed from the change record, the serialized `context/message` metadata, and the render text; a change is now either `set`, a same-file `replace`, or a `remove`. Removing one candidate emits a `remove` for that candidate's own scope, leaving a distinct sibling as an independent scope.

Dedup is enforced during reconciliation, not only at baseline composition. Each reconciliation pass rebuilds a per-directory set of kept trimmed-content digests in candidate order, so an unchanged file is removed when an earlier candidate converges on its content, and a newly duplicate sibling is dropped or removed. The version cache stores a `trimmedDigest` beside the full content digest so the fast path can re-evaluate duplication without re-reading content.

## Alternatives considered

**Keep first-wins per candidate list.** Rejected: it silently drops a directory's second committed instruction file and makes the survivor depend on candidate order rather than on whether the files actually differ, which is exactly the surprise the request set out to remove.

**Global, cross-directory dedup.** Rejected: identical boilerplate under two different directories is legitimately in scope for each, and the deeper file must still surface for work under the deeper directory. Collapsing across directories would hide instructions the model should see.

**Compare raw bytes without trimming.** Rejected: an editor that adds a trailing newline, or a copy that reflows indentation, would defeat dedup for files that are the same in substance. Trimming before comparison is the tolerant key the request asked for, and the survivor still renders its original bytes.

**Follow symlinks so a mirror deduplicates through content.** Rejected for this change to preserve the no-follow invariant, then adopted separately: the [follow-symlinks note](2026-07-21-follow-instruction-symlinks.md) reverses that invariant, after which a symlinked mirror is resolved and deduplicated through content exactly like a real duplicate.

## Consequences

A directory with two distinct real instruction files now surfaces both; a directory whose second file merely mirrors the first still renders once, and the ubiquitous symlink case is unchanged. The visible behavior difference is confined to transition repositories that carry two distinct real files. The released v0 baseline uses the per-candidate scope key and omits `previousPath` from durable change metadata. The version cache row carries `trimmedDigest`, and reconciliation compares trimmed content per directory, so an unchanged file can be removed by a sibling's convergence — a transition the [state model](2026-06-24-workspace-context.md) previously could not produce.
