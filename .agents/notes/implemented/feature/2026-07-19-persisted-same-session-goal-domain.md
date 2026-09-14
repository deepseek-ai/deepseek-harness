# Agent Note: Persisted same-session goal domain

Status: implemented

English | [中文](2026-07-19-persisted-same-session-goal-domain.zh.md)

## Problem

A long-running objective outlives one prompt, turn, or model request. Treating that objective as an in-memory loop variable loses it on process restart, while putting it only in UI state makes model behavior impossible to reconstruct. Treating every session turn as progress also charges unrelated human messages against an automatic-work budget.

Durable lifecycle and permission to continue are different facts. A session may retain an active objective after restart or fork, but silently starting work when a user opens that session is surprising. The domain needs replayable state without persisted auto-execution authority, and it must remain a plugin on the public agent and session services rather than a special case in the concrete loop.

## Decision

`@deepseek-ai/dsh-goal` in `packages/goal/goal/` owns one current same-session goal through `ctx.goals`. A goal has a branded id, objective, durable phase, compare-and-set revision, and `maxGoalRounds`. `defaultMaxGoalRounds` is a validated deployment setting with default `256`; `create()` materializes it internally before mutation rather than exposing resolution as another service verb.

The durable phases are `active`, `paused`, `blocked`, and `complete`. A blocked snapshot includes a policy-owned lower-kebab-case code and a normalized free-form message, so usage limits, round caps, execution failures, and human-input dependencies share one lifecycle state without losing their cause. A separate live activation is `armed` or `disarmed`. Creation and explicit resume arm activation; pause, completion, blocking, and clear disarm it. Edits preserve activation and any blocker reason; resume and completion clear that reason. Activation is never part of the persisted snapshot.

### Durable record and replay

Every mutation appends a versioned `goal/change` session event containing a full snapshot or, for clear, a revisioned tombstone. The session log is the only durable source of truth, so persistence and fork inherit goal records without another database or header field. The [goal-owned durable event decision](../architecture/2026-07-31-goal-owned-durable-events.md) owns the separation from inbox state and model context.

The replay fold derives lifecycle mutations only from `goal/change` and validates JSON shape, fresh ids, revision continuity, lifecycle transitions, counters, and monotonic per-goal timestamps. Goal rounds advance only from positive sequential admitted `user/message` source numbers for the current active revision and cannot exceed `maxGoalRounds`; ordinary session turns do not affect the counter. A malformed current-format record fails replay rather than being ignored or repaired.

Incremental replay advances its cursor after each valid event and remains positioned at the first corrupt event, so later reads report the same durable fault. The durable log remains authoritative after restart.

### Lifecycle and live activation

At most one goal is current. Create requires no current non-complete goal and always generates a revision-one id not used earlier in the session; a completed goal may be replaced. Every other mutation carries the expected `GoalRef`, and stale ids or revisions reject. Resume accepts a paused or blocked phase, or a disarmed active goal, only when the round cap has remaining capacity. The domain validates blocker reason shape but deliberately leaves reason codes and the decision to block to policy consumers.

A cache built from any seed starts disarmed, and every `agent/created` edge disarms it again. `GoalService.disarm(agent)` also lets a lifecycle owner remove process-local authority without a session event, revision change, or `goal/changed` notification. Resume, fork, and continuation-driver replacement therefore preserve the durable objective and history but never initiate work on their own. A later human prompt can be interpreted by the model, whose policy API may explicitly call resume and arm the goal.

### Service boundary

The service accepts only the exact live `Agent` object registered under its id. A committed mutation emits the scoped `goal/changed` event with contained listener failures. Policy consumers use this service plus the public `Agent` interface and `agent/*` events; the goal domain does not import or modify `dsh-agent-loop`.

## Testing

Unit coverage pins creation defaults, exact-live-agent checks, compare-and-set rejection, every lifecycle transition, blocker reason validation and retention, cap enforcement on resume, clear/replacement, seeded replay and `SessionStore.fork()` inheritance, session-start and lifecycle-owner disarming, active-goal rearming, durable event folding, inbox independence, stable corrupt-event replay, service/listener disposal, listener containment, backward-clock clamping, strict record decoding, lifecycle continuity, and sequential round attribution. A keyless Loader/stdio process test mounts the service and a lifecycle consumer through test-only `cordis.yml`, then reads the persisted JSONL externally to verify the goal record and absence of an unrequested goal round. The package source is held to the repository's per-file 100% coverage gate.

## Alternatives considered

- **Store goals in a separate database or session header** — rejected because the session log already supplies ordering, persistence, fork prefixes, and reconstructability; a second store introduces atomicity and lineage questions.
- **Couple each durable mutation to queued model context** — rejected by the later [goal-owned durable event decision](../architecture/2026-07-31-goal-owned-durable-events.md): goal tools and scheduled continuation prompts expose state when needed, while domain persistence remains independent from queue outcomes.
- **Persist activation and restart automatically** — rejected because opening or resuming a session must wait for human input; durable phase records status, not fresh authority to spend resources.
- **Count all session turns as goal rounds** — rejected because one session can contain human clarification, inspection, and unrelated work; only goal-attributed continuation turns consume this budget.
- **Add goal state or a generic loop abstraction to `dsh-agent-loop`** — rejected because state and continuation policy can compose through existing plugins, `Agent` verbs, and events without privileging the shipped loop implementation.

## Consequences

- Goal history survives persistence, resume, compaction of unrelated nodes, and session fork as ordinary session data.
- Resume and fork expose the same durable phase while remaining operationally inert until an explicit resume mutation arms activation.
- Full snapshots simplify inspection, strict replay, and last-wins projection without adding mutation-only messages to model history.
- Revision and lifecycle validation reject tampered, partially written, or producer-inconsistent goal records early.
- Round caps bound continuation count only; policy consumers map round, token, currency, time, and provider limits to blocked reasons when they stop work.

## Known limitations and deferred work

- This domain records state but does not schedule goal rounds, cancel active turns, or classify abnormal stops.
- The actor that records `complete` or `blocked` is authoritative; an independent evaluator or completion certificate is deferred to a policy consumer.
- There is one current goal per session; parallel objective graphs and cross-session goal storage are absent.
- Plugins share one trusted process boundary. Direct session writers can counterfeit goal records; strict replay detects inconsistency and fails goal access at the offending record, but does not isolate plugins or repair the log.
- `GOAL_CHANGE_VERSION` has no pre-release compatibility promise or migration path.
