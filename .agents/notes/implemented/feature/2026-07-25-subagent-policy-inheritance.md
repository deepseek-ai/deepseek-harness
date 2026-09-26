# Agent Note: In-process subagent policy inheritance — the child starts under the parent's sandbox override

Status: implemented

English | [中文](2026-07-25-subagent-policy-inheritance.zh.md)

## Problem

The Auto or Full access preset identity plus sandbox and approval overrides are per-session log folds. An in-process subagent gets a new session, so a spawn child once fell back to deployment defaults and a fork child saw only switches inside its completed-turn prefix. Delegation could therefore widen a parent that had switched to `read-only` or silently retain a stale identity when Auto and Full access shared the same knob bundle.

## Decision

The delegation boundary calls the shared child-agent helpers (`captureDelegatedPolicyOverrides`/`appendDelegatedPolicyOverrides` in `dsh-subagent`) before its first await; the one-shot driver and the [continuable start](../../../../packages/subagent/subagent/README.md) both use them. The capture copies the current `permission/preset` identity when `permissionPresets.current(parent.session)` is `auto` or `danger-full-access`, snapshots `sandboxPolicy.overrideOf(parent.session)`, and pins the child approval policy to `'never'`. A later parent switch belongs to the parent's future; cancel-and-redelegate takes a new snapshot. The permission-preset and sandbox-policy services are optional: only the Auto or Full access identity and the explicit sandbox session override are copied, never deployment defaults or one-shot grants. The approval policy is not inherited — the [approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md) supersedes this note's original approval-override inheritance.

An inherited Auto or Full access identity becomes a `permission/preset` event, while captured sandbox and pinned approval values become source-tagged `sandbox/mode` and `approval/policy` events during the child factory's unpublished setup. The session constructor has already fixed `Session.firstLiveSeq` after the constructor seed, while `Session.inheritedEventCount` keeps the exact fork-prefix length, so the inherited facts follow fork history without changing its lineage cut. Lifecycle-local telemetry starts at `firstLiveSeq`, so it excludes the constructor seed and includes these unpublished-setup events. Existing last-event-wins folds therefore make the delegation snapshot beat stale fork history and let a later child switch beat the snapshot. A grandchild folds its parent's logged state, so the rule composes without another inheritance mechanism.

Auto review does not turn that inherited preset event into an authorization receipt. Each child call is classified again: ordinary project-local work is low risk and allowed, medium-risk work requires explicit authorization naming its action, exact target and scope in the child's creation prompt or an authenticated human/direct-parent message, with no unresolved conflict, while high-risk work is always denied. `parentSession`, the creation prompt, and existing `agent-message.senderSessionId` are sufficient to recover that context across one-shot, continuable, and cold-resume paths; no parent call id, parsed task metadata, delegation records, review receipt, or Session-format migration is introduced.

Ordinary session appends validate the inherited events before publication, and persistence captures the complete unpublished log when the session is announced. Any materialized child log therefore stores the inherited events with its first batch; there is no second policy store, schema field, or query index. The `source: 'delegation'` marker lets approval narration distinguish inheritance from a child-side user switch.

### What a blocked child experiences

A confined child gets the ordinary denial marker, and an escalation request is rejected deterministically by the child's pinned `'never'` policy; the `subagent:delegation` runtime-context statement tells the child to report the limitation instead of retrying, and a controller-owned parent may widen its own session and delegate again ([approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md)).

The [Auto review decision](2026-08-28-auto-review.md) extends this inheritance rule for the shared Auto/Full access bundle; this note remains the owner of delegation-time policy capture.

## Alternatives considered

- **Generic `SessionHeader` policy fields** — rejected: they duplicate an event-sourced fact in metadata and require propagation through core session types, persistence backends, query indexes, collision identity, and every policy consumer. Unpublished setup events have the required ordering and reuse the existing durable store.
- **Combining new policy facts with constructor history** — rejected because it would classify child-owned delegation policy as inherited history and blur the lifecycle ordering that makes the child snapshot override a stale fork value. Unpublished setup keeps history and new facts on their existing sides of the construction boundary without another session option; telemetry captures the child-owned side.
- **A first-prompt listener** — rejected: it introduces listener ordering and a later timing boundary even though the creation transaction already permits log appends before publication.
- **Copying deployment defaults** — rejected: defaults remain operator-owned and may change; an unswitched parent stamps nothing, so its child follows the current deployment.
- **Live resolution walking `parentSession` at each call** — rejected: it breaks the "two sessions never see each other's state" isolation invariant, requires the parent session to stay loaded for the child's lifetime, and makes a mid-run parent switch retroactively change a running child. Snapshot-at-delegation is the semantic: the child keeps the policy it was handed; cancel-and-respawn picks up a tightening.
- **Forcing `'never'`** — originally rejected here as inheritance behavior because a forced value forecloses a future child answerer; that verdict is reversed by the [approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md), which owns the current rationale. Routing asks to the root controller needs parent-chain ownership and the spawning `callId`, and remains deferred in [the approval-seam Agent Note](2026-07-06-approval-seam.md).

## Consequences

- Spawn, fork, and nested in-process children retain a parent's Auto identity when selected, retain its explicit sandbox override, and are pinned to `'never'` approvals. The focused suite proves Auto identity, real filesystem denial, stale-fork precedence, delegation-time capture, the live-event boundary, default omission, and context disposal.
- Under Auto, those children still receive a fresh per-call low/medium/high decision. Human instructions outrank direct-parent task adjustments for medium actions, and neither source can authorize a high-risk action.
- The keyless headless snapshot is the assembled regression: only the parent is `read-only`, the deployment default is `workspace-write`, and the child's persisted event plus denied disk write both fail if capture is removed.
- Each delegation adds at most three log-only events. `dsh-subagent` owns the optional peer types for permission presets, sandbox policy, and approval — its shared helpers hold the `ctx.get` consumption; compositions without those services behave unchanged. Out-of-process children retain their own deployment policy, and a running child does not follow later parent switches.
