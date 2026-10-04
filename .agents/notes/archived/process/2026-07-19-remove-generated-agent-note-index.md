# Agent Note: Keep Agent Notes discoverable without a generated index

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-19-remove-generated-agent-note-index.zh.md)

## Problem

A committed Agent Note index duplicates facts already encoded by each file's lifecycle/class path, filename date, and H1. Every branch that adds, moves, or renames an otherwise unrelated Agent Note rewrites the same generated file, making that artifact a predictable merge hotspot.

The centralized chronological list adds little discovery value beyond browsing the lifecycle/class tree or searching the repository, while its generator, renderer, command, and freshness check remain maintenance burden.

## Decision

The lifecycle/class filesystem tree is the Agent Note inventory. [README.md](../../README.md) remains the curated entry point and contract, while ordinary tree navigation and repository search provide discovery.

`scripts/agent-note-tree.ts` owns the closed lifecycle/class sets and structural walker. `verify-agent-note-classification` validates that tree and rejects the legacy homes and a root `INDEX.md`; it does not render or freshness-check a centralized list.

## Alternatives considered

**Keep the committed generated index and resolve conflicts by regenerating it.** Regeneration makes conflict resolution mechanical but does not prevent unrelated branches from modifying the same artifact or reduce the review noise it creates.

**Offer an uncommitted on-demand index command.** It avoids committed conflicts but preserves a renderer and command for a discovery path already served by tree navigation and repository search.

**Restore a hand-maintained index.** It has the same shared-file contention and adds completeness/order mistakes that generation avoided.

## Consequences

- Adding, moving, or renaming an Agent Note no longer changes a corpus-wide generated file.
- The classification gate performs less work and the documentation gate topology gains no process or stage.
- Readers give up a single chronological page and use the lifecycle/class tree or repository search instead.
