# Agent Note: Alpha Session migration refuses every unknown historical event

Status: implemented

English | [中文](2026-08-31-alpha-historical-unknown-event-refusal.zh.md)

## Problem

Equal-version Session reading can safely skip an unknown event only when its producer marked the envelope `ignorable: true`. A cardinality-preserving migration has a stricter obligation: it must prove that every preserved payload remains semantically valid in the target generation. An unknown JSON payload may contain Session sequence numbers, lifecycle facts, or model-visible state that compile-time brands cannot discover.

Silently copying such an event can leave stale numeric references after a later edge changes event positions. Silently omitting it loses durable data. Retaining the exact immutable v0 generation does not make either transformed v1 result lossless.

## Decision

The alpha v0-to-v1 edge owns a frozen complete released-v0 event and payload inventory. It refuses every unknown historical event type before target staging, including an event marked `ignorable: true`, and refuses unexpected members of known payloads except fields explicitly classified as owner-opaque JSON. Merge-extensible nested discriminants remain part of that explicit policy: unknown content-block types, message-source kinds, assistant finish-reason kinds, and turn-ending reason kinds are preserved as owner-opaque JSON, while known arms receive structural validation. The diagnostic names the event type, its sequence number, and the unchanged source generation.

The rule applies only while crossing a historical format edge. Ordinary current-format reading retains the established envelope behavior: an unknown required event refuses, while an unknown event carrying `ignorable: true` remains readable. New v1 external events therefore keep the existing equal-version extension seam, but they do not become implicitly migratable by a future format edge.

Every first-party source event type has an executable disposition and target validator in the edge package. The catalog is build-static and profile-independent, so mounting or omitting the producer plugin cannot change whether an old artifact migrates.

## Consequences

Some v0 Sessions produced by repository-external informational plugins may refuse alpha migration even though the v0 codec can decode them. Refusal publishes no successor, so the suffixless v0 path, bytes, and inode remain authoritative and unchanged. Operators can identify the blocking type from the diagnostic and retain full access to its raw text.

Community feedback will determine the next policy. A later release may add an explicit external-owner migration interface, permit omission of explicitly ignorable historical events while retaining the exact source generation, or keep strict refusal. No option is implied by the alpha marker.

`SessionSeq` and `SessionLogOffset` make known first-party numeric fields auditable, but they cannot classify numbers inside an unknown runtime object. The migration rule therefore cannot infer safety from the absence of a recognized branded field.

This note supersedes [Retain ignorable external Session events](2026-08-30-retain-ignorable-external-session-events.md) only for historical format migration. That decision remains current for equal-version append and reload.

## Alternatives considered

- **Copy unknown ignorable events verbatim** — preserves bytes but cannot prove that opaque numeric or lifecycle facts remain valid after structural edges.
- **Drop unknown ignorable events** — keeps migration available but is not lossless and makes the marker authorize data deletion.
- **Search unknown JSON for number-like field names** — heuristics cannot establish semantic identity and create false confidence.
- **Dynamically ask mounted plugins** — makes migration availability depend on one deployment composition and fails before an absent producer can mount.
- **Refuse only when the first structural edge ships** — would let v1 contain historical values whose safe interpretation was never established; the identity rehearsal is the point where the policy must become executable.
