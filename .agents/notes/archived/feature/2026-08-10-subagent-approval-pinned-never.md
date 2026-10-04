# Agent Note: Delegated subagents run with approvals pinned to `'never'`

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-10-subagent-approval-pinned-never.zh.md)

## Problem

A delegated child that asked for approval had no one to ask. Under an interactive parent (`'ask'`), a background child's escalation became a pending question no product surface showed — subagent sessions are omitted from the Web sidebar, the parent's `list_agents` reports plain `running`/`idle`, and the catalog rows show only activity — so a permission-blocked child was indistinguishable from a working one; headless and unanswered compositions failed the same ask closed as `'unavailable'`. The rejection audit landed only in the child's own log, and no tool parameter or Web control can adjust a running child session's sandbox mode or approval policy (Issue #1723). The mechanism-heavy fix — a durable blocked-state projection, parent notices, catalog badges, and a permission write path through the subagent ownership fence — was disproportionate directly before release.

## Decision

A delegated child acts only within the permission scope fixed at delegation, and approval prompts are removed from its world entirely: `captureDelegatedPolicyOverrides(parent)` (`dsh-subagent/src/child-agent.ts`) still snapshots the parent session's explicit sandbox override, but pins `approvalPolicy: 'never'` whenever the approval capability is composed — it no longer reads the parent's own approval policy. `appendDelegatedPolicyOverrides()` writes the pin as the durable `approval/policy { policy: 'never', source: 'delegation' }` event on the child's log, through the same one-shot and continuable delegation paths as the sandbox snapshot, so cold resume replays it and a fork seed's stale parent policy loses to it.

Enforcement is the existing `ApprovalService` `'never'` semantics at the one operation that decides asks: every child ask — a `sandbox_permissions` escalation from bash or fs, a hook-driven permission question, any future asker — resolves `'rejected'` deterministically before any answerer is consulted, still leaving the `approval/asked`/`approval/decided` audit pair on the child log. The child's whole permission story is therefore its sandbox scope: a `danger-full-access` parent delegates children that need no approvals, a `read-only` parent delegates children with no escape hatch, and a widening decision always belongs to the parent side (widen the parent session, then delegate or follow up again).

Every in-process child is told, not trapped: `applyChildComposition` registers the scoped `subagent:delegation` runtime-context statement (order 120, after the `sandbox:policy` and `approval:policy` sentences) stating that the scope was fixed at start, approval-requiring operations are rejected automatically, and a task needing wider access ends with a reported limitation instead of retries. The statement is a runtime-context contribution rather than a system-prompt section, so the deployment's system prompt stays uniform across parents and children (the snapshot suite pins that uniformity) and the fact rides the same durable snapshot as the policy sentences.

This supersedes the approval half of the [in-process delegation-policy decision](2026-07-25-subagent-policy-inheritance.md) and reverses its "forcing `'never'` forecloses a future child answerer" verdict: approval inheritance shipped, produced the invisible blocked states above, and a future child answerer now requires reversing this note first.

## Alternatives considered

- **Inheriting the parent's approval override** (the prior behavior) — rejected: only a parent already at `'never'` produced deterministic children; an interactive parent seeded children whose asks waited on a prompt no one was watching or failed closed `'unavailable'`, and the outcome depended on which surfaces happened to be attached.
- **Blocked-state visibility and per-child permission adjustment** (the original #1723 acceptance) — deferred, not rejected: a `list_agents` blocked annotation, parent notices over the settlement-delivery seam, catalog badges, and a subagent-routed permission channel remain the richer design, but each needs its own seam work and none is required once children cannot enter a blocked-waiting state.
- **Routing child asks to the parent controller** — still deferred in the [approval-seam Agent Note](2026-07-06-approval-seam.md): it needs parent-chain ownership and the spawning `callId`.
- **Pinning inside `ApprovalService` by session origin** — rejected: it couples the approval package to delegation vocabulary and duplicates a decision the delegation boundary already owns; the delegation-seeded event is enforceable because no current write path can switch a child session's policy (the `/permission` command requires generic Host routing, which the subagent ownership fence denies to child sessions).

## Consequences

- The child's sandbox inheritance is the complete delegation permission model; the `DelegatedPolicyOverrides.approvalPolicy` field narrows to `'never' | undefined` (`undefined` only without a composed approval capability).
- Model-visible: each child's runtime-context snapshot carries the `subagent:delegation` statement plus the standing disabled-approvals sentence; parent requests are unchanged. The executor-boundary test proves a child escalation is rejected without consulting a root answerer that would have granted it, with the audit pair logged.
- Boundaries: in-process one-shot, continuable, and workflow-spawned children are enforced through the shared helpers; `subagent-acp` children keep that provider's explicit machine `permission` policy; `claude-code`, `codex`, and `dsh-sdk` children run in external processes under their own composition.
- Children persisted before the pin fold to the deployment approval default on cold resume; pre-release, no migration is added.
- Snapshot fixtures record the pin: every in-process child log gains the delegation `approval/policy` event, and `subagent-published-run-failure` now persists a one-event child log where the child previously left no durable events.
