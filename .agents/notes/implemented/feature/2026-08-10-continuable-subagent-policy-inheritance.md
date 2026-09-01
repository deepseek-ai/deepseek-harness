# Agent Note: Continuable subagent policy inheritance — the durable child log owns the delegation-time snapshot

Status: implemented

English | [中文](2026-08-10-continuable-subagent-policy-inheritance.zh.md)

## Problem

The one-shot in-process driver has seeded parent sandbox/approval overrides into its children since the [in-process policy-inheritance decision](2026-07-25-subagent-policy-inheritance.md), but the continuable path never did: `SubagentContinuationManager` materialization applied only child composition. The default bundle wires both delegation tools as `backgroundMode: continuable`, so in a default deployment every background child silently fell back to deployment defaults — a parent switched to `danger-full-access` produced children stuck at `workspace-write` whose every out-of-workspace operation raised an approval prompt, and a parent's unattended `'never'` approval stance reverted to prompting ([dsh-external/issues#334](https://github.com/dsh-external/issues/issues/334)).

## Decision

The capture/append pair moved from the one-shot driver into the seam's shared child-agent module (`dsh-subagent/src/child-agent.ts`), the declared one home for shared child composition: `captureDelegatedPolicyOverrides(parent)` snapshots `sandboxPolicy.overrideOf(parent.session)` through optional `ctx.get` and pins the child approval policy to `'never'` ([approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md)), and `appendDelegatedPolicyOverrides(childSession, overrides)` appends the `source: 'delegation'` events. The one-shot driver and the continuation manager both call them, so the two paths cannot drift.

`startContinuable` captures before its first await (`prepareContinuable`), the same "a later parent switch belongs to the parent's future" boundary as one-shot. The snapshot travels in `MaterializeInputs.create`, so only fresh materialization appends the events during unpublished setup, after any fork seed. A cold resume passes no `create` inputs and appends nothing: the persisted child log already carries the delegation events, and replaying the log IS the state. The durable child log — not the current Activation, not the resuming parent — owns the child's effective policy, so a parent switch between residency epochs never retroactively changes a durable child.

## Alternatives considered

- **A generic child-setup contribution** — rejected: a contribution receives only the child context, so it cannot capture the parent's overrides at the delegation boundary; applying it on cold resume as well as fresh creation would re-append or re-capture; and nothing ties its capture to the start call's synchronous prefix, so the pre-await capture guarantee would be lost.
- **Re-capturing the parent's overrides at cold resume** — rejected: a resumed child would silently change policy with the parent's later switches, breaking the snapshot-at-delegation semantic and making effective policy depend on resume timing instead of the child's own log. A parent that wants a resumed child under new policy re-delegates.
- **Importing the one-shot driver's inline logic from the continuation manager** — rejected: the Service Definition package cannot depend on its own provider package, and duplicating the capture/append pair in `continuation.ts` invites drift; `child-agent.ts` already holds every other shared composition step.
- **Seeding the events into the descriptor seed turn** — rejected: the capture value is not known when the seed is assembled for every caller, and the one-shot precedent already establishes unpublished-setup appends as the ordering that places inherited facts after fork history with `firstLiveSeq` intact.

## Consequences

- Default-bundle background delegation (`backgroundMode: continuable`) now inherits a parent's explicit sandbox override and pins the child to `'never'` approvals; compositions without either policy service behave unchanged.
- `dsh-subagent` gains optional peer types on `dsh-sandbox-policy` and `dsh-user-approval` (the `ctx.get` pattern the one-shot driver used); `dsh-subagent-in-process-driver` drops its policy-service peers and type imports entirely and delegates to the shared helpers.
- The continuable suite (`packages/subagent/subagent/tests/continuation-inheritance.spec.ts`) pins fresh-start seeding, pre-await capture, default omission, cold-resume snapshot stability, and fork-seed precedence; the ACP snapshot scenario `subagent-continuable-inheritance` pins the child's delegation event and read-only runtime context through the assembled app and fails when the capture is removed.
- Out-of-process providers (`acp`, `dsh-sdk`, `claude-code`, `codex`) support no continuable children (`prepareContinuable` absent), and their one-shot children keep their own deployment policy (`inheritsParentContext = false`); cross-process policy propagation remains out of scope.
