# Agent Note: Forked children preserve the parent request prefix

Status: implemented

English | [中文](2026-08-10-fork-children-stay-one-shot.zh.md)

## Problem

Fork differs from spawn by seeding the child Session with the parent's completed-turn prefix. That seed costs tokens, and its intended payoff is provider-side prefix reuse: under the same provider and model, a child request whose leading bytes match the parent's does not prefill the shared span again. A child-only system-prompt section or tool schema ahead of the inherited history defeats that payoff.

The earlier shipped composition avoided this mismatch by keeping forked children one-shot. That restriction was a consequence of the former child-only return tool, not an intrinsic property of continuable fork.

## Decision

The model-facing `send_message` tool is registered globally for every Agent in a composition. A continuable forked child therefore receives the same tool name, description, schema, and ordering as its parent. Its initial task is appended after the inherited Session seed, and the task includes the direct parent id plus guidance to return results with `send_message({ agent_id, message })` when that tool is visible to the child.

The base and headless compositions retain one-shot fork as their conservative lifecycle policy. The `cordis`, `standard`, and `ptc` CLI presets may bind fork to the continuable lifecycle because that binding no longer inserts child-only request-head fields. `ForkInProcessProvider.prepareContinuable()` and `ctx.subagents.startContinuable()` remain the implementation seam for those presets.

Byte-identical prefix reuse is qualified by explicit deployment choices. A fork delegation that applies a child persona or `toolFilter` may still change the request head. In particular, filtering out `send_message` removes both the schema and the return guidance from the child; the runtime does not bypass an explicit allow-list.

## Alternatives considered

**Keep every fork one-shot.** This preserves the prefix but unnecessarily gives up durable, multi-turn forked children after the child-only schema difference is gone.

**Install a child-only return alias.** A recipient-free alias would make child calls shorter, but it would recreate a tool-schema and prompt delta before inherited history and duplicate the adjacent-Agent operation.

**Add the return instruction to the system prompt.** This would place child-only bytes ahead of inherited messages. Appending it to the initial user task preserves the inherited prefix and keeps the parent id next to the task that needs it.

**Ignore an explicit child `toolFilter`.** Structural return tools previously bypassed the child allow-list. Rejected because a declared tool restriction must determine both schema visibility and guidance; hidden authority would make the model-facing roster inaccurate.

## Consequences

- Parent and continuable-fork child expose byte-identical ordered tool schemas when the delegation does not request a persona or tool filter.
- The inherited Session seed precedes the child's initial task and return guidance.
- The base and headless profiles keep one-shot fork, while selected CLI presets exercise continuable fork without a child-only request-head addition.
- A child sends zero or more messages to its direct parent explicitly; its final answer is not implicitly copied. The manager-owned settlement notice remains unconditional and separate.
- Keyless snapshots and package tests pin schema equality, inherited-history ordering, parent-id guidance, and child-to-parent delivery through the same `send_message` operation used in the other direction.

### Accepted risks

Provider-side prefix reuse still depends on the selected provider and model and on the absence of explicit persona or tool-filter differences. The harness proves equality of its assembled request-head inputs, not a provider's cache behavior.
