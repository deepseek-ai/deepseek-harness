# Agent Note: Inbox-only Agent waits

Status: implemented

English | [中文](2026-10-29-inbox-only-agent-wait.zh.md)

## Problem

A task-board commit changes shared state but does not deliver input to a member. Ending every member's wait on each edit couples ordinary subagent controls to Team coordination and makes callers resume without a message explaining what needs attention.

## Decision

`wait_agent` observes only its exact caller's next-step inbox through the existing insertion event. It subscribes before checking pending input, consumes nothing, and removes listeners and timers on input, timeout, cancellation, caller disposal, or tool unload. Queued next-turn input, other Agents' activity, and task-board changes do not end the wait.

Task commands append and flush their revisions without notifying waits or writing inbox messages. A caller sends an explicit message when a member needs to act on an update. No Agent method, shared waiting service, or task-specific waiting event is introduced.

This supersedes only the wait-signal decision in [Team task boards](../architecture/2026-10-19-team-task-board-inbox.md). Its tree authority, durable task storage, historical non-authority, and separation from ordinary controls remain applicable. No Session event generation changes.

## Alternatives considered

**Notify all current waits after every task commit.** This avoids duplicate inbox state but still makes unrelated task edits interrupt every waiting member. Moving the notification behind a service method retains that behavior and coupling.

**Persist each task change as a message.** The task journal already preserves revisions; per-member notices add unread state and delivery recovery. Explicit messages communicate which updates require action.

**Add waiting to Agent or its inbox.** Existing input events and tool-owned cancellation already implement the required wait without extending the core API.

## Consequences

Task updates alone do not resume a waiting or idle member. Callers must communicate when work should continue. The tool returns no task contents; members query the board when needed. Task changes before or during a wait have the same effect: none.

Unit tests cover pending input, caller isolation, concurrent waits, cancellation, disposal, and task commits that leave waits pending. The recorded task-board scenario checks past and concurrent commits against timed-out waits, while completion notification remains ordinary inbox input.
