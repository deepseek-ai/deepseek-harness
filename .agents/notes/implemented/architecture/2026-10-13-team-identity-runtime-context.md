# Agent Note: Team identity in required runtime context

Status: implemented

English | [中文](2026-10-13-team-identity-runtime-context.zh.md)

## Problem

A teammate identity embedded in its initial task depends on ordinary history retention. Compaction can remove it, and an ordinary fork from that teammate can retain the old role even though the fork is an independent Lead. Identity must reflect current membership while keeping shared system instructions uniform.

## Decision

`tool-subagent-control` contributes required `subagent:identity` through `systemPrompt.context()`. It resolves the live subagent root and states the Agent id, root id, and role or parent id. Optional-context suppression cannot remove it. Fixed collaboration policy stays in the system prompt; task state remains a tool query. Initial tasks contain only supplied content.

The loop owns logging, retained-snapshot comparison, and re-admission after compaction. A changed role appends the current full runtime-context snapshot after inherited history; unchanged retained context adds no message. No Team-specific retention state, event type, or log migration is introduced. Existing recorded reminders remain historical messages.

This supersedes only the initial-task identity decision in [Agent Teams](../feature/2026-08-05-agent-teams.md#team-identity). [Task-board inbox coordination](2026-10-19-team-task-board-inbox.md) places this identity in ordinary subagent controls, independently of optional task-board tools.

## Alternatives considered

**Keep identity in the initial task.** Preserves a uniform system prompt but cannot restore removed identity or correct a fork's inherited role without another mechanism.

**Put identity in the system prompt.** Makes system text differ across members and can rewrite the inherited request prefix on routes without in-history system updates.

**Add custom reminder retention and reinjection.** Duplicates the loop's existing runtime-context projection and recovery responsibilities.

## Consequences

Members pay for identity within the full runtime-context snapshot. Other context changes repeat it, while stable retained context adds no new message. Forks preserve inherited history and append current identity; actual provider cache hits remain best-effort. Existing Team authorization remains in tool execution.

Verification covers fresh and fork children, an independent Session fork, optional-context suppression, compaction restoration, unavailable roots, cold resume, and registration disposal. Recorded subagent and Team workflows pin identity through their shipped compositions.
