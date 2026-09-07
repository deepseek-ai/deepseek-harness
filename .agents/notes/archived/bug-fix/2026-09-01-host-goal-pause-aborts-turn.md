# Agent Note: Host-initiated goal pause aborts the live turn

Status: implemented
Archived: 2026-09-04

English | [中文](2026-09-01-host-goal-pause-aborts-turn.zh.md)

## Problem

Clicking "pause goal" in the Web UI moved the goal to `paused` and disarmed automatic continuation, but the model turn already running kept going. The model could keep acting and call `update_goal resume` inside that same turn, immediately undoing the pause, so a manual pause had no real control over goal execution.

## Decision

The goal round driver now reads the `change` on every `goal/changed` event. When `operation === 'pause'` and the pause was not initiated by the agent's own turn, the driver aborts the live turn with `agent.cancel({ kind: 'user' }, { keepInbox: true })`. The Web button runs outside any agent initiator boundary, while a model's `update_goal pause` runs with the agent as the current initiator; the driver distinguishes them with `ctx.agents.currentInitiator() !== agent`. The abort is intentionally broad — it stops any live turn, not just a goal round — because a manual pause is a strong "stop now" signal and disarming alone stops future rounds but not the execution already under way.

`keepInbox` preserves pending work. A queued goal round already fails the existing pre-step reservation check once the goal is disarmed, so it cannot run after the pause.

The idle handler that pauses a cancelled goal is fenced to the dropped attempt's exact `{ goalId, revision }`. A resume bumps the revision, so a pause followed by an immediate resume — before the aborted turn converges to idle — is preserved instead of being re-paused by the stale cancelled attempt.

## Alternatives considered

**Cancel on every pause, including the model's own.** Rejected: a model that pauses in response to a direct human request should finish its turn and report; aborting mid-tool-call cuts off that acknowledgment without adding control.

**Put the cancellation in the goal service's `pause`.** Rejected: `pause` is one shared entry point for host and model callers, so the service would still need the same initiator test. Keeping control handling in the round driver leaves the goal service a durable state and event owner.

**Scope the abort to a turn actually running a goal round.** Rejected: the live turn is the execution the user asked to stop, and the extra attempt-state check adds a subtle path without changing the outcome the issue asks for.

## Consequences

A Web "pause goal" now aborts the running turn, so the model cannot keep acting or resume the just-paused goal in that turn. A pause followed by an immediate resume keeps the resumed goal running. Model-initiated pauses are unchanged. The change is confined to the round driver and its tests; the goal domain, tool authority, and durable formats are unchanged.
