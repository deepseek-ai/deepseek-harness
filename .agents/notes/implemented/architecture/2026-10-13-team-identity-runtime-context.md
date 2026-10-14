# Agent Note: Team identity in required runtime context

Status: implemented

English | [中文](2026-10-13-team-identity-runtime-context.zh.md)

## Problem

A teammate identity embedded in its initial task depends on ordinary history retention. Compaction can remove it, and an ordinary fork from that teammate can retain the old role even though the fork is an independent Lead. Identity must reflect current membership while keeping shared system instructions uniform.

## Decision

`tool-agent-team` contributes `team:identity` through the Agent-scoped `systemPrompt.context()` registry with `required: true`. Its provider reads the existing Team membership and renders the member's role, name, and addressing instructions. Optional-context suppression cannot remove it. Fixed collaboration policy stays in the system prompt; roster and task state remain tool queries. Initial tasks contain only their supplied content.

The loop owns logging, retained-snapshot comparison, and re-admission after compaction. A changed role appends the current full runtime-context snapshot after inherited history; unchanged retained context adds no message. No Team-specific retention state, event type, or log migration is introduced. Existing recorded reminders remain historical messages.

This supersedes only the initial-task identity decision in [Agent Teams](../feature/2026-08-05-agent-teams.md#team-identity); its roster, mailbox, and task decisions remain active.

## Alternatives considered

**Keep identity in the initial task.** Preserves a uniform system prompt but cannot restore removed identity or correct a fork's inherited role without another mechanism.

**Put identity in the system prompt.** Makes system text differ across members and can rewrite the inherited request prefix on routes without in-history system updates.

**Add custom reminder retention and reinjection.** Duplicates the loop's existing runtime-context projection and recovery responsibilities.

## Consequences

Members pay for identity within the full runtime-context snapshot. Other context changes repeat it, while stable retained context adds no new message. Forks preserve inherited history and append current identity; actual provider cache hits remain best-effort. Existing Team authorization remains in tool execution.

Verification covers fresh and fork teammates, an independent fork from a teammate, optional-context suppression, compaction restoration, cold resume, and registration disposal. The recorded `team-targets` scenario pins Lead context; the keyless headless Team workflow pins teammate context through the shipped profile.
