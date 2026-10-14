# Plan Mode

English | [中文](plan.zh.md)

Plan mode is logged per-agent collaboration state owned by [dsh-plan-mode](../../packages/plan/plan-mode) (`ctx.planMode`, `PlanModeController`): while active, a deployment-owned guidance section is included in each model request. Plan mode is **soft guidance**. [Sandbox mode](sandbox.md) and [approval policy](approval.md) enforce restrictions independently; neither reads or writes plan state, so deployments configure them separately. The package is optional, and the agent loop does not depend on it. It contributes the `plan:policy` prompt section and registers the `exit_plan_mode` tool and `/plan` command. The [design reference](../../packages/plan/plan-mode/README.md) owns the rationale; the [package README](../../packages/plan/plan-mode/README.md) owns the model-experience and limitation detail.

Source: [`packages/plan/plan-mode/src/index.ts`](../../packages/plan/plan-mode/src/index.ts)

## Logged state and recovery

`plan/mode` (`{ active: boolean }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript. The optionally registered `plan` unit folds committed mode, command settlement, and the mode recorded at the latest request header. `ctx.planMode` reads that state through `stateOf()`; the first dependent access fails if the registry, `plan` key, or `turnBoundary` key is absent. Clients receive only `{ active, pending }`; resume, fork, and compaction recover both from the log. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md).

## Pending selections and the pre-step append

Because every session event is turn-enclosed, a user selection remains pending until the next accepted in-turn pre-step appends it before request derivation, in whichever turn that occurs. A selection never forces continuation, so one made after a turn's final accepted pre-step is appended in a later turn. `set(agent, active)` records the pending selection (a no-op when the target equals the logged-or-already-pending state), and `get(agent)` returns `{ active: boolean; pending?: boolean }`: the logged state used to assemble the current step plus the selected state waiting to be appended.

The only append point while an agent is running is a prepended `agent/pre-step` listener. It observes every proposed request step, including turn 1 step 1 and request-recovery retries, calls downstream listeners first, and appends only after they accept the step. Prompt admission happens before a turn and cannot append `plan/mode`, so a selection made at the prompt is appended by the first accepted in-turn pre-step of the turn it starts. An append failure cannot block the turn, and the selection remains pending for a later accepted in-turn pre-step. An appended user selection also records one plugin-sourced `user/message` notice, but only when the last logged request header described the other state, so the model is told exactly when its context changed and never redundantly. A selection made after a turn's final accepted pre-step remains process-local and is lost if the process exits before another accepted in-turn pre-step ([README limitation](../../packages/plan/plan-mode/README.md#known-limitations-and-deferred-work)).

## Configuration

```ts type-equiv
/** Deployment-owned plan guidance. */
interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
}
```

A missing, blank, or non-string `section` and any unknown key fail at plugin load rather than being ignored. While plan mode is active, the exact `section` text renders as the `plan:policy` [system-prompt section](system-prompt.md) at order 50; inactive plan mode contributes no text.

## The exit tool and the `/plan` command

[`exit_plan_mode`](../tool-catalog.md#deepseek-aidsh-plan-mode) stays registered while plan mode is inactive, so entering or leaving plan mode changes only the prompt section, never the request tool catalog; execution outside plan mode fails. In plan mode it requires a complete markdown plan starting with a `#` heading and presents it for review through the [user-questions seam](user-questions.md). Approval returns `{ approved: true }` and records a silent (non-narrated) pending exit that is appended at the next accepted in-turn pre-step. Plan guidance therefore remains active for the rest of the assistant's current tool batch, and the tool result itself reports the transition. Keep-planning is a failed call carrying the user's feedback, so the model revises and presents again. A dismissed review returns `{ approved: false }` and concludes the turn, so plan mode stays active until the user's next message. A missing interaction channel and a service reload during review also fail the call rather than silently leaving plan mode.

When [`ctx.commands`](commands.md) is composed, the plugin registers `/plan [off|message]`: bare `/plan` selects plan mode, any other non-empty message selects it and then submits the text through `agent.steer()` so it becomes the next step's ordinary logged user message under plan guidance, and the exact argument `off` selects inactive, which also cancels a pending entry before it is appended and becomes visible to a request.

## The service

`ctx.planMode` owns the logged plan state, applies and narrates selected state at step start, and owns the `plan:policy` section, the `/plan` command, and the stable exit tool; `get`/`set` signatures are in the generated [service catalog](#ctxplanmode--planmodecontroller).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplanmode--planmodecontroller"></a>

### `ctx.planMode` — `PlanModeController`

`ctx.planMode`: owns logged plan state, applies and narrates selected state at step start, the `plan:policy` section, the `/plan` command, and the stable exit tool. Client carriers expose the projection's cropped `{ active, pending }` view.

```ts cordis-catalog
/**
 * Read the logged plan state and any selected state awaiting the next
 * accepted in-turn pre-step.
 *
 * @param agent The agent to read.
 * @returns Current logged state plus a pending selection, when present.
 */
get(agent: Agent): { active: boolean; pending?: boolean }

/**
 * Select whether plan mode should be active. Between turns the method
 * appends the change immediately because no in-turn pre-step will run until
 * another prompt starts a turn. The open-turn fold is the idle signal:
 * agent status stays `running` through post-turn checkpointing, when no
 * further in-turn pre-step runs. During an open turn the selection remains
 * pending until the next accepted in-turn pre-step. Repeated selection of
 * the current or already-pending state is a no-op.
 *
 * @param agent The agent to switch.
 * @param active Whether plan mode should be active.
 * @returns what happened: `committed` (logged now), `queued` (awaiting the
 * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
 * was cleared; the logged state already matches), or `noop` (already in that
 * state).
 */
set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
```

Types: [Agent](core.md)

Source: [`packages/plan/plan-mode/src/index.ts`](../../packages/plan/plan-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
