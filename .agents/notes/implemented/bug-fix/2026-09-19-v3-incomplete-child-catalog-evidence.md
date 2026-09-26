# Agent Note: Preserve V3 Sessions with incomplete child catalog evidence

Status: implemented

English | [中文](2026-09-19-v3-incomplete-child-catalog-evidence.zh.md)

## Problem

A valid V3 child log can have no own descriptor, an unsupported descriptor version, or multiple descriptors. Its header still establishes its identity and parent relationship. Requiring one supported descriptor to migrate the parent makes unavailable discovery fields prevent access to otherwise readable history.

## Decision

The V3→V4 migration appends a complete missing parent catalog entry only when exactly one supported own child descriptor supplies its discovery fields. Other descriptor counts and unsupported versions retain unknown-mode membership through [session-local catalog preparation](2026-09-19-session-local-subagent-migration.md). Existing parent entries and child events remain intact. This replaces only the missing-evidence refusal in the [adjacent migration decision](../architecture/2026-08-31-released-session-format-migrations.md).

The JSONL failure-propagation rules below are partially superseded by [session-local catalog preparation](2026-09-19-session-local-subagent-migration.md); the converter still validates supplied facts and conflicts. Known child creation times must still match existing parent entries. Mode/label and descriptor fields are checked only for exactly one supported own descriptor. JSONL isolates invalid descriptor fields and corrupt child bodies while retaining known header identity; unreadable or unsupported headers are excluded from discovery. Changed source revisions still refuse publication.

## Alternatives considered

**Refuse the whole parent.** Discovery metadata is insufficient to justify making valid parent history unavailable.

**Choose the first or last descriptor.** [`foldSubagentDescriptor()`](../../../../packages/subagent/subagent/src/descriptor.ts) takes the first under the establishing provider’s exactly-once rule; the [identity projection](../../../../packages/subagent/subagent/src/projection.ts) takes the last to override inherited identities. Multiple own records violate that rule. Backfill requires one own record rather than choosing between these consumer policies.

**Infer missing fields.** Invented mode or label fields would become durable catalog facts without evidence.

## Consequences

A historical child with a readable header but no usable descriptor retains unknown-mode membership in its parent's direct-child catalog. Existing catalog entries remain visible. Once a V4 successor is published, opening it does not rescan historical children; automatic later mode backfill is outside this migration. Preparation still rechecks child revisions before publication, so newly available evidence cannot silently bypass source consistency checks.

Unit, JSONL read/write, and Preview packing tests cover unavailable evidence, unchanged source bytes, retained entries, identity conflicts, and evidence changes before publication.
