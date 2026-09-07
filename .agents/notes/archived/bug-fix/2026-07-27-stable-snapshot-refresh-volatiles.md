# Agent Note: Stable snapshot refresh volatiles

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-27-stable-snapshot-refresh-volatiles.zh.md)

## Problem

ACP snapshot comparison normalizes generated UUIDs, cwd aliases, spill locators, embedded event times, and omitted-byte counts, but refresh write-back persisted the fresh raw values. A behaviorally unchanged refresh therefore rewrote fixtures with new randomness or host-specific path spellings even though the comparison contract considered both logs equal.

Message identity needs a weaker structural precondition than aligned records: an unrelated log event can break record alignment while an inherited message's identity-free value remains unchanged across parent and child logs. Record mode also begins with freshly minted message UUIDs when it replaces an existing fixture.

## Decision

Before record or refresh writes session fixtures, the shared snapshot support passes fixture-ready logs to one structural message-ID owner. It recognizes surface carriers through the session package's authoritative surface-type predicate and the correlated queued copies in `agent/inbox/spliced`, fingerprints every complete message with its top-level `id` removed, and records every ID-to-fingerprint edge across all parent/child logs. It reuses an existing UUID only when both its ID and fingerprint have degree one in the fresh and existing graphs, then rewrites only validated message `id` fields in those carriers. Repeated inherited occurrences with the same ID remain one candidate, while new, changed, duplicate-content, malformed, and conflicting messages keep their fresh IDs. ACP, JSON-RPC, and Web recorders run this pass after header scrubbing and cwd tokenization, so fixture spellings rather than raw host paths determine identity.

Refresh write-back uses `normalizeSessionLog` as its volatile-value authority for aligned leaves. It normalizes the original harvested records with the fresh run's ids, cwd, and every cwd alias, while normalizing fixture records with the fixture header context; literal replacements are limited to fresh-run session IDs, cwd values, and spill paths. After existing record alignment, it recursively compares fresh and existing leaves through those normalized records: normalized-equivalent leaves retain the existing raw value, while normalized-distinct leaves retain the fresh semantic value. Complete message IDs in surface or inbox carriers are excluded from this path so positional reuse and structural reuse cannot assign the same committed UUID independently.

Before reuse, the complete logical-record layout must align, apart from the existing packed-chunk and inserted-title equivalences. Normalized-equivalent changed strings form a log-wide bijection: one fresh string maps to exactly one existing string and vice versa, so repeated IDs remain correlated across records. An unexplained record mismatch or conflicting mapping disables normalized string reuse for that log.

Object fields align by key. Array elements align only when all corresponding arrays have the same length; otherwise the fresh array wins. Strings remain atomic leaves. Existing packed-chunk timing alignment and inserted-title handling remain separate because they align logical events rather than values inside one record.

## Alternatives considered

**Use deterministic UUIDs and spill filenames in snapshot deployments.** Replacing production randomness would weaken the security shape under test or require test-only behavior in storage and approval implementations.

**Commit normalized fixtures.** Tokenized session logs would stop being raw replay inputs and would cause a broad fixture migration unrelated to the write-back defect.

**Preserve a whole record when its normalized form is unchanged.** This is simpler but churns a random field whenever another field in the same record changes semantically. Leaf-level preservation keeps those decisions independent.

## Consequences

Record and refresh no longer rewrite an unchanged unique message UUID solely because another event changed the surrounding record layout, regardless of whether ACP, JSON-RPC, or Web owns the recording. Repeated refreshes also retain aligned fixture values that the normalizer classifies as volatile, and new volatile categories added to the normalizer automatically inherit that write-back behavior. Structural ambiguity remains conservative: unmatched records, conflicting string mappings, resized arrays, strings containing both semantic and volatile changes, malformed messages, and any message graph with a non-unique ID or fingerprint use fresh values rather than risk reusing misaligned data.

Focused unit coverage pins all authoritative surface-message shapes, durable inbox/surface correlation, scenario-wide parent/child correlation, cwd-bearing fixture-ready matching, unrelated event insertion, malformed-message isolation, both-axis graph ambiguity, single-owner write-back, recursive object/array behavior, conflicting mappings, fresh cwd aliases, volatile strings, and fresh semantic fields. Keyless refresh coverage proves approval UUIDs, cwd aliases, spill paths, and event-read volatility leave their committed fixtures byte-identical.
