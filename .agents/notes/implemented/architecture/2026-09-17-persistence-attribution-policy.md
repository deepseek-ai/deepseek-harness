# Agent Note: Recorded user-source attribution compatibility

Status: implemented

English | [中文](2026-09-17-persistence-attribution-policy.zh.md)

## Problem

A producer-owned message source appears transitively in several persisted event types. A new attribution kind changes their union fingerprints even when existing readers preserve its fields without the producer. Request-only prompts need no durable identity, but constructing them as Session messages adds unnecessary source alternatives to that union.

## Decision

The core-owned user-message source property binds the [recorded compatibility policy](../process/2026-09-17-persistence-schema-review.md). A producer separately qualifies its literal wire kind as attribution-only. Both saved schemas must carry compatible policy state before a qualified addition receives a same-version classification. Existing alternatives remain structurally compared; missing policy, unqualified additions, removals, and changes to existing semantic groups retain strict classification. Fixed system, model, and tool source fields do not participate.

The tmux-context producer qualifies its location attribution. Its own projection uses the kind to avoid repeated injection, while readers without that producer retain the recorded content and every source JSON property. The qualification promises reader independence; it does not forbid producer-local duplicate suppression.

`RequestMessage` accepts a durable `Message` or a user-only `RequestUserInput` with content and no `id` or `source`. The LLM service and provider serializers accept both; Session writes, Agent delivery, and persisted title-request inputs require durable messages. Auto Review's outer prompt and the compaction summarizer's final instruction use request-only inputs and retain their content and freezing. The caller receives no implicit durable conversion. Assistant replay metadata and tool-result correlation retain their existing requirements.

The finalized V4 acknowledgement records the user-source policy and removes the two request-only source registrations. Its original predecessors and header transition remain intact. This does not grant a general exception for removing accepted variants: the [producer-source migration](2026-09-09-producer-owned-message-sources.md) preserves its producer mappings and extension namespaces, including historical request-only kinds, independently of active source declarations. Catalog generation and comparison remain owned by the [persistence reference](../../../../docs/persistence-changes/README.md#compatibility-rules).

## Alternatives considered

**Treat every source addition as breaking.** This would require a Session-format increment for attribution that readers already retain safely, without distinguishing it from semantic changes.

**Relax every discriminated union or infer compatibility from current names.** A generic exception would admit semantic variants. Current declarations cannot establish what an older snapshot promised, and structural equality does not establish ownership of a source property.

**Use durable messages for every request.** Detached prompts would retain manufactured identities and unnecessary source declarations. The explicit user-only alternative permits their removal while typed Session interfaces retain durable identity requirements.

**Narrow historical context forms to current writer examples.** Writer examples do not establish every value admitted by released readers. Those read-facing variants remain represented.

## Consequences

A qualified addition still changes affected event fingerprints and requires an acknowledgement. Reviewers must verify the producer's attribution promise; type analysis cannot establish replay semantics or detect behavior hidden in opaque values.

Codec-to-Session tests retain unknown user attribution and extra JSON fields without the producer. Provider equality tests compare request-only and durable inputs, while type assertions reject request-only inputs at durable writes. Recorded Session generations and the V3-to-V4 conversion remain independent of catalog policy and rendering.
