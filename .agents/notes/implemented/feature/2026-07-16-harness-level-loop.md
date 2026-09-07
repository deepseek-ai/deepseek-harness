# Agent Note: Harness-level goal-based execution

Status: implemented

English | [中文](2026-07-16-harness-level-loop.zh.md)

## Problem

The concrete agent loop owns one turn: it drains admitted input, performs one or more model-and-tool steps, and stops. Substantial objectives often need an outer policy that can begin another turn, retain progress, stop at a budget, and remain intelligible to humans. A timed prompt, a same-session continuation, and a fresh-agent Ralph attempt all repeat work, but they do not share the same state, authority, memory, or lifecycle.

Treating every repeated action as one generic “loop” obscures those differences. Same-session work must persist the human objective in the existing transcript while preserving conversation context. Ralph work must intentionally discard conversation context and use the workspace plus a bounded handoff. Human-facing status must not imply that reopening a session silently authorizes more work. Completion and blocker claims also need an explicit trust boundary rather than being smuggled into a scheduler abstraction.

The repository therefore needs goal-based execution above the turn/step loop, but it does not need a speculative universal loop service that combines persistence, evaluation, budgeting, scheduling, handoff, background jobs, and UI.

## Decision

Two explicit plugin policies over existing seams:

1. **Same-session goals** retain one durable objective in the current session and admit goal-attributed continuation turns only while live activation is armed.
2. **Fresh-agent Ralph runs** execute a fixed foreground workflow whose rounds each spawn a new structured child with no conversation seed.

There is no `packages/loop/` family, `LoopDriver`, `LoopId`, universal `StopCondition`, or model-facing generic `loop` tool. The two policies share the repository's ordinary agent, session, tools, workflow, subagent, and UI extension points, but they do not pretend that one lifecycle fits both.

### Vocabulary and policy boundary

The same-session hierarchy is **Goal → Goal Round → Turn → Step**. A goal round is one continuation cycle admitted for the current goal and materialized as one goal-sourced turn. Human or unrelated turns in the same session do not consume the goal-round cap, and a turn may still contain multiple model/tool steps.

The fresh-agent hierarchy is **Ralph Run → Ralph Round → fresh child Turn → Step**. One Ralph round creates one child session. The parent transcript and prior child transcripts are not seed context; the shared workspace and one bounded structured report carry cross-round state.

“Round” is therefore an outer policy iteration, not a synonym for every session turn. The concrete `dsh-agent-loop` remains the turn/step engine. The same-session driver uses public agent and session events; its only core addition is the generic observe-before-cancel `agent/cancel-requested` notification needed by any lifecycle policy that must settle cancellation safely.

Time-based `/loop` or scheduled execution is a third policy and is not implemented by this decision. It belongs with a scheduler rather than either goal family.

### Package topology and owning verbs

| Package | Repository category | Owned structures and verbs |
|---|---|---|
| `@deepseek-ai/dsh-goal` | `packages/goal/goal/`, domain service | Owns `GoalId`, compare-and-set `GoalRef`, `GoalSnapshot`, four-state `GoalPhase`, structured `GoalBlockReason`, process-local `GoalActivation`, replay folding, and `get`, `create`, `edit`, `pause`, `resume`, `complete`, `block`, `clear`, and `disarm` verbs. |
| `@deepseek-ai/dsh-tool-goal` | `packages/goal/tool-goal/`, model-facing consumer | Registers exclusive `get_goal`, `create_goal`, and `update_goal`; requires a direct human message in a live root-agent turn and narrows autonomous-round authority to completion or blocking reports with machine-routable reason codes. |
| `@deepseek-ai/dsh-goal-round-driver` | `packages/goal/goal-round-driver/`, continuation policy | Reserves, fences, admits, attributes, settles, cancels, and quiescently drains same-session goal rounds without importing the concrete loop. |
| `@deepseek-ai/dsh-commands` | `packages/interaction/commands/`, UI registry | Owns `CommandDefinition`, discovery, scoped registration, direct dispatch, `CommandResult`, and request cancellation for human-only commands. |
| `@deepseek-ai/dsh-command-goal` | `packages/goal/command-goal/`, human-command producer | Registers `/goal` status, creation, edit, pause, resume, and clear over the goal domain for TUI. |
| `@deepseek-ai/dsh-tool-ralph` | `packages/workflow/tool-ralph/`, fixed workflow consumer | Registers `ralph({ objective, maxRounds? })`, validates the fresh structured provider and bounded `RalphRoundReport`, and returns `complete`, `blocked`, or `budget-limited`. |

The detailed contracts live in the [goal-domain](2026-07-19-persisted-same-session-goal-domain.md), [goal-owned event](../architecture/2026-07-31-goal-owned-durable-events.md), [model goal-tools](2026-07-19-model-facing-goal-tools.md), [goal-round driver](../../archived/feature/2026-07-19-same-session-goal-round-driver.md), [command registry](2026-07-19-plugin-command-registration.md), [human goal-command](../../archived/feature/2026-07-19-human-goal-command.md), and [Ralph workflow-tool](../../archived/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) Agent Notes.

### Durable goal state and live authority

One session has at most one current goal. Every mutation commits through a durable `goal/change` event carrying a full versioned snapshot or revisioned clear tombstone; inbox state does not participate. The session log is the only durable source of truth, so normal persistence, resume, and `SessionStore.fork()` carry the goal without a second database or an artificial cancellation record.

Durable phases are only `active`, `paused`, `blocked`, and `complete`. A blocked goal carries a required `GoalBlockReason` with a stable lower-kebab-case `code` and a non-empty human-readable `message`; usage limits, round exhaustion, model failures, and policy rejection are reason codes rather than extra lifecycle phases. Separate activation is `armed` or `disarmed` and is never persisted. Creation and explicit resume arm a goal; stop transitions, session start, fork replay, driver replacement, and driver teardown leave it disarmed.

This separation makes session restoration observable and unsurprising. Reopening a session never starts goal work by itself. A later human prompt such as “continue”, “resume the goal”, or an equivalent request in any language gives the runtime-root model a new turn in which it may read the goal and call `update_goal(..., action: 'resume')`. `/goal resume` is the direct human-command path. The runtime authenticates that the request came from a live direct-human turn; prompt policy lets the model interpret whether the wording semantically authorizes creation or resumption.

Forked sessions inherit the durable goal prefix because that is the natural replay result. The fork starts disarmed, so inheritance does not imply execution authority and no synthetic goal cancellation is inserted into history.

`defaultMaxGoalRounds` is configurable and defaults to `256`. The cap counts only admitted goal rounds. `blockedAfterConsecutiveRounds` is separately configurable in the model-tool policy and defaults to `3`; it is a mechanical lower bound before an autonomous round may report a repeated blocker, not an evaluator of semantic sameness.

### Same-session continuation

The goal-round driver owns at most one pending reservation per exact live agent. It admits a reservation only when the goal is active and armed, the agent is idle, no competing human work exists, the latest mutation has passed its durability checkpoint, the exact goal id/revision/round still matches, and downstream pre-step policy accepts it. Its `agent/pre-step` fence checks those facts both before and after downstream listeners, preventing an edit, pause, human message, or unload race from admitting obsolete work.

Only an admitted positive-round goal-sourced `user/message` charges a round. A stale reservation closes a blocked no-step turn without consuming the cap. A concurrent goal revision wins over settlement from an older round.

Normal turn completion schedules another round only while the goal remains active, armed, and below its cap. Cancellation pauses. Rate limiting or quota exhaustion blocks with code `usage-limited`; cap exhaustion blocks with `round-limit`; queue failure uses `queue-failed`; turn errors, max-token stops, policy rejection, and unknown terminal results use their corresponding blocker codes. An independently composed request-recovery plugin may retry transient provider failures within that same turn; the goal driver never invents another round after an abnormal terminal outcome. A human can later authorize resume through ordinary language or `/goal resume`.

### Human and model interactions

The human UX follows the compact Codex shape in the [public OpenAI Codex TUI dispatcher at commit `678157a`](https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/tui/src/chatwidget/slash_dispatch.rs#L750-L805): `/goal` shows status, `/goal <objective>` creates, and `edit`, `pause`, `resume`, or `clear` perform direct lifecycle actions. The commit permalink keeps the researched grammar verifiable as Codex evolves. Status includes durable phase, admitted/capped rounds, and live armed/disarmed activation. Direct status and command output do not enter model history; accepted domain mutations remain reconstructable because the goal service records them.

The model receives only `get_goal`, `create_goal`, and `update_goal`. It may create a goal when a direct human request clearly asks for substantial multi-round work, and it may infer that intent in any language. It must not turn routine one-turn work into a goal. Code requires a direct human message in the current live root-agent turn; semantic interpretation remains model judgment. An autonomous goal round may report `complete` or `blocked` for the exact current goal round but cannot edit, pause, resume, or replace the human objective.

Base-backed profiles mount the shared command registry and complete goal stack by default and expose `/goal` through one producer. ACP mounts the goal domain, model tools, and same-session driver but deliberately omits the human command plane. Every effective registered command is discoverable and invocable through every composed command adapter; a plugin incompatible with an application omits its command producer from that composition rather than relying on registry-level surface masks. The standalone `sdk-minimal` tree omits the complete goal stack so one-shot callers do not silently become multi-round operations. Headless CLI and JSON-RPC entry points do not consume the command plane; ordinary human text can still authorize model goal tools when that stack is composed.

### Fresh-agent Ralph execution

Ralph is a first-class model tool in its own plugin, demonstrating that a sophisticated fixed execution policy can be composed without a new loop core. The plugin owns a fixed workflow script over `ctx.workflowEngine` and `ctx.subagents`; it does not create session-goal state or add a branch to `dsh-agent-loop`.

Each round uses an explicit `WorkflowStartRequest.subagentProvider`, defaulting to `spawn`. The provider must exist, support structured output, and declare that it does not inherit parent context. Ralph also passes its resolved round cap as `WorkflowStartRequest.maxTotalAgents`; the worker engine validates both per-run policies before publishing work, so provider misconfiguration or an engine ceiling below the requested Ralph scale fails before a run exists. The child inherits cwd and lineage but receives only the immutable objective, round/cap, workspace-as-authority instruction, and previous normalized report.

A report contains status, summary, evidence, next steps, and blocker text. Status-specific invariants and serialized size are validated inside the fixed script and again at the consumer boundary. `maxRounds` is configurable, defaults to `256`, and is the ceiling for a call override. `maxHandoffChars` defaults to `16384`; oversized reports fail rather than being silently truncated. `maxResultChars` separately defaults to `16384` and bounds the complete successful parent-facing text, including its envelope and truncation marker.

An ordinary child failure ends the run without retry. The fixed script reports the failed round and last successful handoff when one exists, and the tool returns that state as an error instead of misclassifying it as a malformed report or budget exhaustion. Fatal workflow infrastructure failures can settle before the script returns that state; richer reason transport and retry policy remain deferred.

The tool is foreground and process-local. The parent tool call waits for the terminal result, propagates cancellation into the worker engine, and awaits `run.dispose()` so child work is quiescent before return. The model sees one call and one bounded successful terminal result or an error; completion and blocker envelopes explicitly say that a worker reported the outcome rather than presenting it as independent certification. Intermediate child conversations remain outside the parent transcript.

### External design lineage

Codex provides the minimal observable goal UX used here: a persistent chat-attached target with set, view, edit, pause, resume, and clear controls. This implementation adopts that discoverability while using this repository's event-sourced goal record, plugin scopes, and runtime authority checks.

Current [Claude Code goals](https://code.claude.com/docs/en/goal) reinforce the distinction between a goal that starts another turn after the previous turn and a timed `/loop`. Claude Code also uses a separate small-model evaluator after each turn. This implementation adopts the policy distinction but intentionally does not copy that evaluator: evaluator inputs, tool access, deterministic checks, provider choice, isolation, and authority need a separately designed plugin contract rather than an implicit self-certification layer.

External products are comparators, not compatibility targets. The local source studies informed the boundaries, while the shipped interfaces follow this repository's “everything is a plugin”, model-visible-is-logged, explicit default resolution, and quiescent teardown rules.

### Verification

The six owning Agent Notes record unit, integration, process, snapshot, cancellation, replay, and built-runtime coverage. The stack exercises strict goal-record folding, compare-and-set races, session fork inheritance, disarmed restoration, natural-language direct-human authority, configurable caps and blocked thresholds, exact goal-round attribution, adapter-wide command discovery, and transcript isolation. Shipped keyless snapshots cover model goal creation/inspection through the headless app, multi-round same-session lifecycle and cancellation through ACP, and two real Ralph rounds through the headless app; focused command tests pin direct `/goal` status without a model turn. The Ralph snapshot boots the worker-thread engine, spawn provider, structured-output runtime, and agent loop, then inspects distinct unseeded child logs and exact one-way bounded handoff while pinning the parent stream. Focused real-stack tests additionally cover completion, blocker and round-limit outcomes, malformed and oversized reports, ordinary child failure with the last good handoff, one phase event, and cancellation to child quiescence. Package sources remain under the repository's per-file 100% coverage gate, and built-binary tests cover installed-artifact resolution. The implementation experience is recorded in the root testing policy: every non-trivial model- or human-visible change must carry a real-example keyless snapshot in the same PR rather than relying on package-only or mock-only fixture coverage.

## Alternatives considered

- **Implement the original universal loop capability** — rejected because `Evaluator`, `BudgetPolicy`, `RoundHandoff`, `GoalReflector`, background job ownership, persistence, and scheduling do not form one coherent mandatory abstraction. Building all of them before their first concrete consumers would create broad speculative surface and duplicate existing session, workflow, subagent, and task machinery.
- **Implement only same-session goals** — rejected because fresh-context iteration is materially different and is a valuable demonstration of the plugin architecture. Ralph belongs as a fixed workflow consumer with explicit context reset.
- **Put Ralph inside the goal-round driver** — rejected because same-session goals deliberately preserve one conversation while Ralph deliberately removes it. Combining them would make activation, replay, handoff, and UI state ambiguous.
- **Treat a fork as a fresh Ralph child** — rejected because a fork carries a conversation prefix. Fresh children plus workspace state and one explicit report are easier to bound and replay without a synthetic cancel record.
- **Copy Claude Code's evaluator into the first goal implementation** — rejected because a transcript-only model evaluator is one useful policy, not a generally trustworthy completion certificate. Deterministic evaluation and isolation must remain possible, so the evaluator is deferred until its authority and provider contract are designed.
- **Automatically continue after session restore** — rejected because opening a session is observation, not authority to spend resources. Durable state is restored while activation waits for a new human prompt.
- **Route `/goal` through the model** — rejected because status and explicit lifecycle controls should be deterministic, token-free UI actions; ordinary natural-language prompts remain the semantic model path.
- **Modify the concrete agent loop with goal or Ralph modes** — rejected because public queue, prompt, session, cancellation, workflow, and subagent seams already support both policies. The generic cancel-requested observation is the only core coordination addition.

## Consequences

- Goal-based execution ships without one overloaded “loop” object: same-session continuation and fresh-agent iteration have explicit, separately testable contracts.
- Durable goal history is replayable and forkable, while process-local activation prevents accidental work on resume.
- Humans receive a small Codex-shaped UX; models receive a compact tool set whose mutating calls require a direct human message in the current live root-agent turn; deployments can remove either independently.
- Ralph demonstrates a nontrivial fixed policy entirely as a plugin over existing workflow and subagent primitives.
- Round limits are generous by default but remain deployment-controlled. They bound iterations, not tokens, price, elapsed time, or external side effects.
- The original proposal's evaluator, budget, reflector, background-job, CLI, and generic loop-session architecture is intentionally not part of the implemented public API.

## Known limitations and deferred work

- **Independent evaluation** — same-session completion/blocking and Ralph terminal status are model or worker declarations. A separate evaluator, evaluator-driven feedback round, completion certificate, deterministic checker, adversarial verifier, and criteria/executor/isolation contract remain deferred.
- **Aggregate budgets** — `maxGoalRounds` and Ralph `maxRounds` are the only aggregate effort limits. Token, currency, elapsed-time, provider-usage, and per-round price admission policies are absent.
- **No persistent autonomous runner** — same-session goal facts persist, but activation and scheduling are process-local and deliberately wait for human input after restore. Ralph runs are foreground and cannot resume after process loss. Background collection, restart recovery, and unattended resident execution are deferred.
- **No time scheduler** — interval `/loop`, cron, proactive maintenance, and cloud or desktop scheduling are outside this decision.
- **No generic loop journal or execution-world rewind** — session replay reconstructs goal history, not prior files, processes, environment, credentials, or external side effects. Ralph treats the current workspace as authority and carries no cross-run journal.
- **No goal reflector** — concern events, automatic no-progress heuristics, goal revision by an independent reflector, stuck-pattern detection, and `loop_split` are not implemented. Humans can edit, pause, clear, or resume the goal directly.
- **Ralph policy remains narrow** — one round creates one fresh child; within-round fan-out, evaluator/worker role separation, dynamic provider/model selection, and structural recursive-Ralph tool denial need separate policy APIs. Prompt guidance is not enforcement.
- **Ralph does not retry a failed child** — an ordinary failure preserves the failed round and last good handoff, while fatal workflow infrastructure failures can end before that state is available. Retry count, backoff, and richer failure transport need separate policy and boundary design.
- **Portable UI remains modest** — TUI renders plain-text goal status and generic Ralph cards. ACP carries only committed assistant text; there is no continuous status widget, reconnectable command output, modal goal editor, or command plane in ACP, the headless CLI, or JSON-RPC.
