# Agent Note: Manual generation continuation

Status: implemented

English | [中文](2026-10-26-manual-generation-continuation.zh.md)

## Problem

Users need another turn after a model request fails. A browser page can omit the failed turn's start; streaming must not repeatedly copy loaded history.

## Decision

The play action submits localized ordinary user text through the existing composer, retaining admission, logging, failure drafts, and telemetry. No resume RPC, AgentLoop change, or Session event format is introduced.

The fixed-size Host projection `conversationContinuation` recovers from complete Session history. Eligibility requires admitted ordinary input and a failed attempt, independently of the browser's 500-message page.

The six-code manual allowlist remains independent of [automatic retry policy](../../../../packages/llm/llm-retry/README.md). Pending [injected context](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md) in `next-step` accompanies the new waking message; pending ordinary user submissions prevent duplicates.

## Alternatives considered

**Window scanning or entries caching.** Each revision can materialize a fresh window; caching cannot recover unloaded facts.

**Use provider retryableCodes.** Deployment retry policies could expose authentication or other unsuitable errors as UI actions.

**Add a resume RPC.** Ordinary submission already owns wakeup, admission, error reporting, and history.

## Consequences

Host activation requires `sessionProjections`; custom compositions follow the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.3/conversation-continuation-projection/guide.md). Fixed-size state avoids Client history scans without introducing a second submission lifecycle.

## Verification

Tests cover checkpoint recovery, long-turn paging, injected context, refusal and retained drafts, and zero Client event-window reads. The recorded Web scenario exercises failure followed by continuation.
