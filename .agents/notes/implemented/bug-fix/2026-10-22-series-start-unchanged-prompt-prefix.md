# Agent Note: A series start with an unchanged prompt keeps the surviving system node

Status: implemented

English | [中文](2026-10-22-series-start-unchanged-prompt-prefix.zh.md)

## Problem

A surface replacement can invalidate only a later portion of conversation history. Moving unchanged system instructions back to node 0 at that request-series start invalidates the provider prefix from the beginning without changing those instructions.

## Decision

Keep unchanged admitted system nodes in place when a new request series starts. The system-prompt service compares canonical committed section text independently of request-series markers. Replacing unrelated user or tool content does not require rebuilding instructions. Compaction is a separate trigger for [deferred rebuilding from current sources](../architecture/2026-11-09-deferred-system-compaction.md), not a consequence of the series marker. The [section-admission decision](../architecture/2026-10-21-section-based-system-updates.md) owns incremental updates, retirement, complete overrides and adapter representations.

Request-series and tool-declaration handling remain independent. A surface replacement still starts a series and declarations can still rebuild; neither operation alone moves system instructions. An unsupported tool-update route receives the complete active declarations even when unchanged system instructions produce no system event or additional `startsSeries` marker.

## Verification

- [`admission.spec.ts`](../../../../packages/core/system-prompt/tests/admission.spec.ts) verifies unchanged text produces no delta and compaction alone marks a full rebuild pending.
- [`system-prompt-admission.spec.ts`](../../../../packages/core/agent-loop/tests/system-prompt-admission.spec.ts) verifies unchanged prefixes through explicit series starts, unrelated replacements, tool changes, and resume, plus retry recovery when compaction removes a system node.
- The [`in-history-series-start`](../../../../snapshots/session/in-history-series-start/) recorded session verifies two retained system messages and no redundant system event after replacement of unrelated history.

## Alternatives considered

**Consolidate on every series start.** Rejected because a tail replacement does not invalidate the entire cached prefix.

**Always keep admitted nodes.** Rejected because compaction can remove instructions and explicitly adopts current live sources for the next model attempt. Its full rebuild clears retained additions too; the old head alone is not authoritative current state.

**Stop treating local replacements as series starts.** Rejected because compaction and image-offload still require request-series handling. Prompt admission owns the separate instruction decision.

**Compare reconstructed wire requests.** Rejected because this duplicates request reconstruction and couples admission to adapter serialization. Canonical Session records already identify the instructions and their conversation positions.

## Consequences

Retained system history continues to cost input tokens. Preserving its position enables prefix reuse only when the adapter representation also preserves it; it does not guarantee a cache hit. Retries reuse accepted instructions. Compaction recovery rebuilds them from the same captured sections before another model attempt without admitting the user input twice.
