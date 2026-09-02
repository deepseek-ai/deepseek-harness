# Agent Note: In-process subagent policy inheritance — the child starts under the parent's sandbox override

Status: implemented

English | [中文](2026-07-25-subagent-policy-inheritance.zh.md)

## Problem

Sandbox and approval overrides are per-session log folds. An in-process subagent gets a new session, so a spawn child once fell back to deployment defaults and a fork child saw only switches inside its completed-turn prefix. Delegation could therefore widen a parent that had switched to `read-only`.

## Decision

The delegation boundary snapshots `sandboxPolicy.overrideOf(parent.session)` before its first await, through the shared child-agent helpers (`captureDelegatedPolicyOverrides`/`appendDelegatedPolicyOverrides` in `dsh-subagent`), which the one-shot driver and the [continuable start](2026-08-10-continuable-subagent-policy-inheritance.md) both call. A later parent switch belongs to the parent's future; cancel-and-redelegate takes a new snapshot. The sandbox-policy service is optional, and only the explicit session override is copied, never deployment defaults or one-shot grants. The approval policy is not inherited: the same capture pins every child to `'never'` — the [approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md) supersedes this note's original approval-override inheritance.

Each captured value becomes a source-tagged `sandbox/mode` or `approval/policy` event appended during the child factory's unpublished setup. The session constructor has already fixed `Session.firstLiveSeq` after the constructor seed, while `Session.inheritedEventCount` keeps the exact fork-prefix length, so the inherited facts follow fork history and reach telemetry when the child is announced without changing its lineage cut. Existing last-event-wins folds therefore make the delegation snapshot beat stale fork history and let a later child switch beat the snapshot. A grandchild folds its parent's logged state, so the rule composes without another inheritance mechanism.

Ordinary session appends validate the inherited events before publication, and persistence captures the complete unpublished log when the session is announced. Any materialized child log therefore stores the inherited events with its first batch; there is no second policy store, schema field, or query index. The `source: 'delegation'` marker lets approval narration distinguish inheritance from a child-side user switch.

### What a blocked child experiences

A confined child gets the ordinary denial marker, and an escalation request is rejected deterministically by the child's pinned `'never'` policy; the `subagent:delegation` runtime-context statement tells the child to report the limitation instead of retrying, and a controller-owned parent may widen its own session and delegate again ([approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md)).

## Alternatives considered

- **Generic `SessionHeader` policy fields** — rejected: they duplicate an event-sourced fact in metadata and require propagation through core session types, persistence backends, query indexes, collision identity, and every policy consumer. Unpublished setup events have the required ordering and reuse the existing durable store.
- **Combining new policy facts with constructor history** — rejected: `Session.firstLiveSeq` classifies the complete constructor seed as replayed history, so telemetry would skip child-only facts. Unpublished setup keeps history and new facts on their existing sides of that boundary without another session option.
- **A first-prompt listener** — rejected: it introduces listener ordering and a later timing boundary even though the creation transaction already permits log appends before publication.
- **Copying deployment defaults** — rejected: defaults remain operator-owned and may change; an unswitched parent stamps nothing, so its child follows the current deployment.
- **Live resolution walking `parentSession` at each call** — rejected: it breaks the "two sessions never see each other's state" isolation invariant, requires the parent session to stay loaded for the child's lifetime, and makes a mid-run parent switch retroactively change a running child. Snapshot-at-delegation is the semantic: the child keeps the policy it was handed; cancel-and-respawn picks up a tightening.
- **Forcing `'never'`** — originally rejected here as inheritance behavior because a forced value forecloses a future child answerer; that verdict is reversed by the [approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md), which owns the current rationale. Routing asks to the root controller needs parent-chain ownership and the spawning `callId`, and remains deferred in [the approval-seam Agent Note](2026-07-06-approval-seam.md).

## Consequences

- Spawn, fork, and nested in-process children retain a parent's explicit sandbox override and are pinned to `'never'` approvals. The focused suite proves real filesystem denial, stale-fork precedence, delegation-time capture, the live-event boundary, default omission, and context disposal.
- The keyless headless snapshot is the assembled regression: only the parent is `read-only`, the deployment default is `workspace-write`, and the child's persisted event plus denied disk write both fail if capture is removed.
- Each delegation adds at most two log-only events. `dsh-subagent` owns the optional peer types for the two policy services — its shared helpers hold the `ctx.get` consumption; compositions without either service behave unchanged. Out-of-process children retain their own deployment policy, and a running child does not follow later parent switches.
