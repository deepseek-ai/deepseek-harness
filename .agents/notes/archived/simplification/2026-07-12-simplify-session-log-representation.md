# Agent Note: Simplify session-log representation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-12-simplify-session-log-representation.zh.md)

## Problem

The session log maintains two representations that cost more machinery than their consumers require: a pseudo-linked surface and custom request-header deltas.

`SurfaceManager` stores the same order in an array, a seq map, and mutable `prev`/`next` links. Production never reads either link: compact's tool-pairing balance answers from per-cut balances cached in surface order. Replacement already uses `indexOf`, so the links do not make its dominant operation constant-time. A seq array with linear replacement lookup has the same asymptotic replacement cost and one representation to validate.

The request-header subsystem implements a custom system/tool delta codec and transmission-decision layer even though its contract says deltas are an encoding optimization, not a reconstructability requirement. Retaining the initial/resume full snapshot at each loop-instance boundary, then writing a canonical full `request/header` whenever that instance's assembled header changes, preserves replay while deleting `SystemDelta`, `ToolsDelta`, round-trip fallback, and the durable `request/header-delta` variant. Codec-only vocabulary disappears with the codec, not because its individual arms were invalid.

The implementation retains append and replacement `sourceEventSeqs`, the `tool/call` seq cited by crash-repaired results, and all `SessionStartSource` variants because those fields have an audit/interception role that zero current readers does not overturn.

## Decision

`SurfaceManager.nodes` is a `readonly number[]` of event sequences; the public `SurfaceNode` shape, node links, and seq-to-node map are removed. The internal replace-generation signal remains. The complete `foldSurface()` read used by session-query returns the same number-array representation plus replacement metadata without making the incremental manager retain history. Tool-pairing balance and compaction use event sequences and surface positions; the compact-owned per-cut balance cache does not depend on node links.

Request headers use canonical full snapshots only. Initial and resume anchors remain full snapshots even when unchanged; an in-instance change appends another full `request/header` with reason `change`; and an unchanged envelope beginning an explicitly declared message series or following a surface replacement appends a full snapshot with reason `series`. Ordinary append-only later Turns, further Steps, and retries in that model-message series inherit the latest snapshot. The delta event, codec types, diff/apply helpers, and codec-only `fallback` reason are removed. Request reconstruction selects the latest snapshot.

Current v1 seed and append validation accept only full pinned request headers and current reasons. The frozen v0-to-v1 edge owns the explicit refusal of historical `request/header-delta` and `fallback` forms before current Session construction; accepted historical normalizations are limited to the separately enumerated lossless shapes. The ACP snapshot harness represents legitimate mid-session changes as full pinned headers and full readable prompts.

## Alternatives considered

**Keep linked nodes and compact deltas for possible scale.** Links could help a future cursor API, and deltas can reduce logs when large tool schemas change by a small amount. No shipped cursor uses the links, while full snapshots trade disk size for substantially simpler correctness. If header volume proves material, compression or a measured canonical-delta scheme can be designed around real traces.

## Verification

Unit coverage pins ordered-surface append/replace behavior, tool pairing, compaction, full-header folding/logging, request reconstruction, and dev invariants. Seed validation plus JSONL load tests reject the legacy event before replay. The keyless ACP suite exercises record, refresh, replay, changed-header pinning, and the sandbox mode-switch fixture in the new shape.

## Consequences

Full headers increase log volume, and linear replacement lookup could be slower on very large surfaces. Replacements were already linear because the prior implementation called `indexOf`; benchmarks are deferred until real traces show the simpler array is a bottleneck. Current v1 keeps exactly one representation, while the v0 edge is the only owner of the released legacy forms. In return, surface order and request-header state each have one current representation, deleting link maintenance, maps, codec arms, round-trip fallback, and delta-aware snapshot normalization.
