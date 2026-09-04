# Agent Note: Bound cold blank-session verification

Status: implemented

English | [中文](2026-08-13-bounded-cold-blank-verification.zh.md)

## Problem

The Web session tree hides blank Sessions and reuses the selected blank entry as New Session. Attached Sessions can derive blankness from their in-memory event log, but `session.list` normally avoids loading every cold log. Treating every materialized cold Session as non-blank exposes empty Sessions left by older versions. Treating a projection-cache `blank: true` as current can instead hide a real conversation after the log advances and the fail-soft cache remains stale.

The same cold list used the JSONL artifact mtime for `updatedAt`. Opening a Session appends `session/end-seed`, so a pickup with no human prompt refreshed mtime and promoted that Session above recently used conversations.

## Decision

`dsh-api-session-controller` registers `sessionListMetadata`, a projection containing `blank` and `lastPromptAt`. The attached summary folds the same functions directly over the live log. `blank` changes only from true to false on `turn/start`; `lastPromptAt` changes only on a `user/message` whose source kind is `user`.

A cold summary trusts cached `blank: false`, because a checkpoint prefix containing `turn/start` remains non-blank. A cache miss does not prove the current log is blank and is served `blank: false`, keeping the Session visible. The earlier physical-size probe — a `locate()` path plus a `coldBlankProbeMaxBytes` eligibility threshold gating an exact `readFrom(id, 0)` fold — is removed with the seam's path query ([export and pre-release trims](../simplification/2026-08-27-persistence-export-and-pre-release-trims.md)). Persistence snapshot hints do not reintroduce it: listing remains metadata/cache-only and never opens a cold body.

`updatedAt` is the later of `createdAt` and `lastPromptAt`. A cache miss or stale checkpoint orders the Session too old rather than promoting it from an unrelated file write.

## Alternatives considered

**Trust cached `blank: true`.** Rejected because the projection cache deliberately permits a persisted log to advance beyond its checkpoint. A crash or fail-soft write failure after the first `turn/start` would hide a real conversation and could make the client reuse it as New Session.

**Read every cold log.** Rejected because list latency and I/O would scale with total stored conversation bytes; unverified cold entries degrade toward visibility instead.

**Store blankness and recency in an authoritative persistence index.** Deferred because the shipped JSONL provider has an immutable first line and would require a second durable artifact with ordered updates. An out-of-tree provider may use its own index only with defined update atomicity, versioning, and recovery. The broader exact-index design remains in the [last-activity proposal](../../proposed/architecture/2026-07-29-durable-last-activity-index.md).

**Continue ordering JSONL by mtime.** Rejected because mtime records every artifact write, including pickup boundaries, rather than the latest human prompt. Its error direction promotes untouched Sessions to the front.

## Consequences

A stale cache cannot hide a stored `turn/start`, and a cold list performs no artifact I/O: cold rows are served from cached projections only. Blank cold Sessions without a cached non-blank projection remain visible, and missing or delayed recency cache entries fall back to `createdAt`. These are conservative degradations: the UI may show an extra empty row or order a Session too low, but it does not hide a conversation or promote one because it was merely opened.

The gateway-owned projection is an effect of the gateway fiber; unloading the gateway removes the key. Unit coverage pins stale-true rejection, monotonic false reuse, cache-miss visibility, human-prompt recency, and fiber disposal.
