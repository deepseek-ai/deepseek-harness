# Agent Note: Keep Chat presentation independent of Trajectory inspection

Status: implemented

English | [中文](2026-09-14-chat-presentation-defaults.zh.md)

## Problem

Trajectory inspection benefits from exposing complete recorded reasoning. Applying that default to Chat expands the live transcript during reasoning and changes its height when an answer or Tool call arrives. The Trajectory inspection change also added historical first-token recovery to Chat without a separate Chat behavior decision.

## Decision

[Chat](../../../../packages/client/ui-chat/README.md#turn-process-folding) starts each reasoning row collapsed and retains the reader's manual disclosure choice through subsequent output and settlement. Settlement retires the observed live chunks and rebuilds Chat reply nodes from durable events without recovering first-token time from embedded streams. Consequently, completed-turn TTFT and decoding speed are absent after live settlement as well as after reopening history. Turn-level process folding remains independently owned.

[Trajectory inspection](../feature/2026-09-09-ptc-trajectory-code-inspection.md) keeps its expanded reasoning default, recorded timing, JSON controls, and PTC code inspector. The [compact stream readers](../architecture/2026-09-06-embedded-stream-record-readers.md) remain available to Trajectory and other consumers. These decisions partially supersede the Chat presentation additions while preserving both notes' independent rationale.

## Alternatives considered

**Keep Chat's automatic expansion and historical timing recovery.** These change Chat behavior beyond the requested Trajectory inspection work. Reintroducing either requires a separate Chat product decision and its own verification.

**Revert the entire inspection change.** That would remove the requested Trajectory behavior along with the unintended Chat changes.

## Consequences

Chat reasoning requires a click to inspect in full. Elapsed turn time and the independently projected Session Stats remain available. Assembler tests distinguish transient retirement at live settlement from reopening durable history; browser replay verifies the completed-turn timing dialog before and after reload. Component tests cover collapsed streaming and reasoning-only replies and manual disclosure across answer and Tool-call arrival. Trajectory tests retain its separate defaults and timing.
