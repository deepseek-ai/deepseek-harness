# Agent Note: Team projection retains only tasks and mode

Status: implemented

English | [中文](2026-10-29-team-task-only-projection.zh.md)

## Problem

The Team projection retained historical member, message, and delivery collections after subagent discovery and messaging replaced their runtime consumers. Its retired lifecycle and mailbox validators could still fail the current task board, while checkpoints retained message bodies with no current reader.

## Decision

Project only tasks, saved mode, and their recovery metadata. Ignore `team/member` and `team/message/*` payloads without rebuilding or validating their former state machines. This deliberately gives up historical teammate and mailbox state recovery and the associated validation failures. The user accepted that loss; task recovery remains required.

Checkpoint version 7 invalidates prior state, including failures caused by retired records. The registry rebuilds from the unchanged Session log. Historical event declarations, format migrations, message sources, and attachment export remain supported; no Session format bump or log conversion is needed.

This partially supersedes the projection and mailbox-validation decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md). The [subagent identity](../architecture/2026-10-15-agent-teams-as-subagents.md) and [inbox-only wait](2026-10-29-inbox-only-agent-wait.md) decisions remain active, as do task durability and shared-checkout semantics.

## Alternatives considered

**Retain decode-only roster and mailbox projections.** No production consumer reads these collections. Keeping them preserves message history in checkpoints and lets obsolete validation stop current task operations.

**Migrate or delete historical log events.** The task board can ignore these records directly. Rewriting them adds migration work and would discard archival data that existing format readers and exports can still use.

## Consequences

Old teammate and mailbox state is unavailable through Team projection. Original log records remain readable, but neither grant authority nor trigger delivery. Reintroducing recovery requires a concrete consumer and an explicit decision about its retained data and failure scope.

Tests cover ignored legacy payloads, version-6 checkpoint invalidation, current checkpoint suffix replay, JSONL restart with task mutation, stable view references, and a recorded headless profile accepting a task after retired lifecycle and mailbox records. Task and mode validation still fail visibly.
