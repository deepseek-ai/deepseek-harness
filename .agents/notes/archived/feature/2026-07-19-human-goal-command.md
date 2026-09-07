# Agent Note: Human `/goal` command

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-19-human-goal-command.zh.md)

## Problem

The same-session goal domain and model tools provide the state machine and semantic natural-language path, but they are not a sufficient human UX. A user needs to inspect the exact current phase and round budget without asking the model, explicitly pause or clear work without spending a model turn, and rearm a restored active goal after the required post-resume human decision. Implementing those actions independently in each UI would duplicate parsing, let the surfaces drift, and risk routing an unknown or unavailable command into the model.

The command must also respect the goal design's two kinds of state. Durable phase, objective, revisions, and rounds come from the session log; process-local activation decides whether an active goal may continue automatically. Showing only “active” after a resume would be misleading when the restored goal is intentionally disarmed and waiting for human authorization.

## Decision

`@deepseek-ai/dsh-command-goal` in `packages/goal/command-goal/` is a command producer over `ctx.commands` and `ctx.goals`. It registers one `goal` definition in the Cordis scope where the producer is mounted, so every command adapter reading that agent's scope discovers the same command; an incompatible app or agent preset omits this producer rather than masking its registration at an adapter. The handler receives the exact target agent from command dispatch, reads or mutates that agent's goal through the domain service, and returns direct plain-text UI output. It does not import either adapter or the concrete agent loop.

The command follows the compact Codex shape in the [public OpenAI Codex TUI dispatcher at commit `678157a`](https://github.com/openai/codex/blob/678157acaa819d5510adfe359abb5d0392cfe461/codex-rs/tui/src/chatwidget/slash_dispatch.rs#L750-L805): bare status, a free-form objective, and `clear`, `edit`, `pause`, or `resume` controls. The commit permalink makes the researched grammar durable even as Codex evolves. This repository keeps its own event-sourced state, round-count policy, and post-resume activation rule rather than copying Codex's SQLite, token budget, or automatic-resume behavior.

### Grammar and lifecycle verbs

`/goal` reports the objective, human-readable durable phase, `roundsStarted/maxGoalRounds`, process-local `armed` or `disarmed` activation, and commands meaningful from that state. With no current goal it reports that fact plus complete usage. Reading status adds no session event.

`/goal <objective>` creates an active armed goal. A completed goal may be replaced, which creates a fresh goal identity through the existing domain rule. Any unfinished goal makes the command fail directly with instructions to use inline edit or explicit clear. The generic command service deliberately has no modal confirmation API, so silently clearing and creating two durable records would manufacture destructive consent and expose a non-atomic failure window.

`/goal edit <objective>` edits the current non-complete goal without changing phase or activation. On a completed goal it creates a fresh active goal because the domain does not permit completed state to resume and a new completion objective is a new goal identity. Bare `edit` is an error rather than an editor launch because the portable unstructured command contract has no modal editor.

`/goal pause`, `/goal resume`, and `/goal clear` call the matching compare-and-set domain verbs against the current view. Resume covers both stopped durable phases and an active-but-disarmed goal after session resume, fork, or driver replacement. Domain rules still reject exhausted round caps, redundant active/armed resume, invalid phase transitions, and stale identity. Clear removes the current pointer while the session log retains the revisioned tombstone and earlier snapshots.

Control words are ASCII-case-insensitive after outer whitespace trimming. They are controls only when they occupy the full suffix; any other non-empty text is an objective. This matches the predictable free-form command rule: `/goal pause after verification` is a goal objective, not a partially parsed pause command.

### Output and failure boundary

Status output omits branded ids and compare-and-set revisions because those are model/plugin coordination details rather than human controls. It includes activation because that fact changes whether work will continue, and a blocked goal includes its durable policy code and human-readable explanation. Command hints are derived from the exact state: an armed active goal offers pause, a disarmed active or paused/blocked goal offers resume, and a completed goal offers replacement or clear.

Expected `GoalError` failures become one stable, branded-id-free `CommandResult.error`, so domain diagnostics do not leak compare-and-set internals into the UI and invalid operations never enter model history. The current status supplies the actionable state-specific recovery. Other exceptions remain adapter-visible command failures; treating programmer faults as ordinary domain errors would hide defects. The command handler performs only synchronous domain mutations, so request cancellation is decided by the command registry before the mutation begins and there is no escaped asynchronous side effect to unwind.

Generic slash input, status text, and errors are not persisted. Successful goal mutations append the domain-owned `goal/change` event and do not queue model context. The command introduces no second audit record that could disagree with the domain event.

### App composition

`dsh-base` mounts the goal domain and model-tool owners as explicit rows, while the standalone `sdk-minimal` tree omits the complete stack. This explicit composition choice is important for SDK one-shot callers: their result API settles one correlated physical turn and must not silently become a long-running logical goal operation.

The TUI app bundle makes the opposite product choice. It defaults `goals` to the owner defaults and mounts the goal domain, model tools, same-session driver, command registry, and this producer; `goals: false` removes the stack coherently. The Web bundle keeps the goal domain and driver on the host for remote access, disables the host command producer, and mounts the producer in the `standard`, `code`, and `cordis` agent presets; `minimal` omits both the command and model goal tools. A preset switch does not mutate host-owned goal state, and the Web GoalBar retains direct edit, pause, resume, and clear controls. The [ACP automation app](../simplification/2026-07-23-acp-automation-only-protocol.md) also defaults the goal domain and model tools but deliberately omits command services. The Python SDK runtime closure ships this producer, commands, and the goal stack so an external `cordis.yml` can compose the same command.

## Testing

The producer suite uses the real command registry, goal service, agent registry, and session log. It covers Loader-safe exports, registry discovery, disposal, empty status, objective parsing, unfinished replacement refusal, inline edit, completed replacement, all missing-state controls, pause/resume/clear, every durable phase, blocked code/explanation presentation, armed/disarmed presentation, sanitized domain errors, unexpected failures, and persisted mutation records. App composition tests cover explicit spine opt-in, TUI defaults, coherent opt-out, forwarded domain/tool config, command discovery, the packaged-runtime closure, and the expanded model-tool assembly. Web composition tests cover preset-scoped command discovery, Minimal omission, disposal during preset switching, and the assembled browser command list. ACP backend snapshots continue to pin the goal tool schemas independently of this human command.

## Alternatives considered

- **Let the model handle `/goal` as ordinary text** — rejected because status and direct lifecycle actions would cost a model turn, could be reinterpreted, and would not provide deterministic command discovery.
- **Implement separate handlers in each UI** — rejected because grammar, error behavior, and goal-state formatting would drift and optional deployments could not add or remove the capability as one effect.
- **Add modal editing and replacement confirmation to `ctx.commands`** — rejected because the existing cross-UI contract is unstructured input plus direct output; a general interaction protocol needs more than this one producer.
- **Silently replace an unfinished goal** — rejected because it combines clear and create without atomicity or explicit destructive intent.
- **Expose goal id and revision in human status** — rejected because human actions always target the exact current view inside one synchronous handler; those fields add implementation noise without preventing another race.
- **Enable goals unconditionally in the UI-less spine** — rejected because one-shot SDK/CLI settlement is a physical-turn API, not a goal-operation API.

## Consequences

- TUI and non-Web base compositions expose one Codex-shaped `/goal` command supplied by a removable plugin; Web presets expose it only where they mount the producer.
- Human status distinguishes durable phase from live activation and reports the exact goal-round cap.
- Direct pause, resume, clear, creation, and edit consume no model turn while their accepted mutations remain reconstructable from the session log.
- Restored sessions wait for a human decision; `/goal resume` is the literal command path, while an ordinary prompt in any language may authorize the model tool path.
- Headless compositions retain one-turn behavior unless they explicitly opt into goals and define their own long-running settlement contract.

## Known limitations and deferred work

- The portable command contract has no modal editor or confirmation interaction; inline edit and explicit clear are intentional until a general cross-UI interaction primitive exists.
- `/goal` does not accept a per-command round cap. Deployment config owns the default, and the authorized model tool can edit a cap after direct human instruction.
- TUI renders portable plain text rather than a continuously updated goal status widget. Reconnectable command output and adapter-specific status indicators are deferred.
- The ACP automation server, headless CLI, and JSON-RPC entry points do not consume the command registry.
- The command observes and mutates state but does not certify completion or blockers. Evaluator-backed certification remains deferred to a separate policy layer with an explicit authority and isolation contract.
