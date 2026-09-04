# Agent Note: Plan-specific collaboration state

Status: implemented

English | [中文](2026-07-22-plan-specific-collaboration-state.zh.md)

## Problem

The first plan-mode implementation introduced a generic named-mode registry even though the product shipped only `plan`. `ModeConfig.modes`, definition-name validation, `ctx.modes.list()`, retired-definition fallback, and a synthetic `review` mode in tests existed only to support hypothetical future collaboration modes. The production-specific behavior—plan guidance, `/plan`, and `exit_plan_mode`—still lived in the same package, so the generic API did not isolate a reusable mechanism from plan policy.

The word “mode” also spans unrelated domains. Sandbox mode is an enforcing policy owned by `ctx.sandboxPolicy` and logged as `sandbox/mode`; plan mode is a collaboration stance that contributes guidance and a reviewed exit. Treating both as instances of one named-mode abstraction would obscure their independent ownership. A transport's generic vocabulary is not evidence that the harness needs a generic mode domain.

Plan mode also needs a durable stance, a reviewable plan artifact, an explicit human boundary, and request reconstruction across resume and fork. Those requirements belong to the plan feature even after the generic registry and interactive ACP projections are removed.

## Decision

Plan mode owns a plan-specific product package: `@deepseek-ai/dsh-plan-mode` at `packages/plan/plan-mode/`. The durable fact is `plan/mode: { active: boolean }`, folded by the package's `plan` projection unit — `planProjectionDefinition.apply` over committed events, with the empty log folding to inactive (`active: false`) — and every projection unit is now persisted uniformly, the `persist` option having been removed. Host logic reads the fold through `ctx.sessionProjections.stateOf(session, 'plan')`; the client view is `{ active, pending }`. `ctx.planMode.get(agent)` returns `{ active, pending? }`, and `set(agent, active)` records the boundary-applied selection. The pre-step, retry, append-failure, and disposal fences preserve the same state-transition ownership.

Configuration is exactly `{ section: string }`. The package registers the fixed `plan:policy` section, `/plan [message]`, the exact `/plan off` direct-exit form, and `exit_plan_mode` itself. Bare `/plan` selects active; another non-empty argument selects it first and then sends the trimmed text through `agent.steer()`, making the text an ordinary logged user message in the affected step. `/plan off` selects inactive without model input and can cancel an entry that is still pending at the boundary. The exit tool remains registered while plan mode is inactive so the request tool catalog stays stable.

Human-facing compositions own plan selection and review. This note originally kept ACP's protocol-level `default`/`plan` picker as an adapter over the boolean service; [ACP as an automation-only protocol](2026-07-23-acp-automation-only-protocol.md) supersedes that wire projection, so the ACP composition now mounts neither plan mode nor a mode-selection protocol.

Sandbox mode and approval policy remain separate enforcement axes. Plan mode neither reads nor writes them, and the simplification introduces no shared base type, registry, or preset abstraction across those concepts.

### Boundary and model contract

`plan/mode` is log-only and non-surface, so resume, fork, and compaction recover the state without a live mirror. A spawned agent begins inactive because there is no creation-time plan option. Pending user selections flush before the affected request assembly at initial or continuation pre-step, or on a request-recovery retry; a failed durable append leaves the intent pending for a later boundary.

The active state contributes the deployment's section at first-party prompt order 500. Inactive state contributes no section, while `exit_plan_mode` remains registered in both states, so a transition changes the logged request header but not native tool schemas or the PTC mode SDK. A user-driven transition appends one plugin-sourced notice only when the last request header described the opposite state; a pre-first-request or net-zero selection adds none, and an approved tool exit relies on its tool result instead of a second notice.

### Reviewed exit

`exit_plan_mode` requires a calling agent in active plan mode and a non-empty markdown plan beginning with a heading. The user-questions question carries that exact plan as detail and offers `Approve` or `Keep planning` plus free-text feedback. Only one `Approve` selection with no custom text consents; every other answer stays in plan mode and returns corrective feedback to the model. An approved exit becomes a silent pending selection, leaving plan guidance active for the rest of the current tool batch and removing it before the next request.

The tool renders the submitted plan as a generic card titled by its first heading. An absent or failed user-questions provider, a failed review, or plugin disposal while review is pending fails closed and leaves manual `/plan off` as the human escape path.

## Deleted API

- The arbitrary definition map, mode-name regular expression, reserved-name rules, and per-definition command loop.
- `ModeDefinition`, the resolved definition map, `ctx.modes.list()`, string-valued get/set state, and unknown or retired mode handling.
- Test-only `review` mode cases and claims that additional modes can be added through configuration.
- Generic `mode/set` and `mode:policy` names; the plan package now owns `plan/mode` and `plan:policy`.

## Alternatives considered

**Keep a private generic registry and expose only plan.** Rejected because the unused name/config machinery would still be maintained and tested without a second production consumer. A future collaboration state can establish the right shared seam from two concrete cases.

**Fold sandbox or approval policy into plan state.** Rejected because collaboration guidance, execution confinement, and permission decisions have different owners, lifecycle semantics, and consumers. A mode-owned sandbox cap also makes a user's explicit sandbox selection appear to succeed while silently doing nothing.

**Let one presentation transport own plan state.** Rejected because TUI, Web, resume, fork, prompt assembly, and the exit tool need the same logged fact independently of any one transport. Presentation adapters own only their projections.

**Split a capability-seam trio or put the state in the agent loop.** Rejected because plan mode has no swappable backend, while existing session, prompt, tool, command, and lifecycle extension points already provide every required hook.

**Put flips in surface messages or store plans in files.** Rejected because the stance is a log-only fact and the tool argument already records the reviewable plan. Surface duplication spends model context, while a plan directory creates a second durable home.

**Filter tools by a per-plan name allowlist or a global policy stack.** Rejected because mutability is a property of each tool, including future and MCP tools, rather than a list that every plan deployment must maintain. Effects metadata can establish a shared policy only when a concrete consumer exists; until then plan mode is guidance, not a security boundary.

**Review through the approval seam or prose.** Rejected because a plan review is not a permission decision, needs the exact artifact and corrective free text, and must have a logged tool call as its structured transition. The user-questions seam supplies that contract.

## Verification

- Package tests retain boundary ordering, retry, append-failure, HMR disposal, prompt assembly, stable native and PTC mode schemas, review outcomes, and invariant coverage through the boolean service.
- Command tests cover bare `/plan`, `/plan <message>`, active `/plan off`, pending-entry cancellation, inactive idempotence, absence of `/mode` and `/review`, and effect-scoped removal.
- The keyless TUI scenarios enter through `/plan <message>`, leave through `/plan off`, and prove that each committed `plan/mode` precedes the request header it changes, the entry message is logged under plan guidance, and the post-exit request omits that guidance.
- The complete `exit_plan_mode` review arc is package-tested but has no assembled-application snapshot after the interactive ACP scenarios were retired; current keyless TUI scenarios cover command entry and direct exit only.

## Consequences

The implementation has one vocabulary for one shipped feature. Adding another collaboration stance is an explicit design decision instead of a config entry, and automation clients do not acquire human mode controls through ACP. The frozen v0-to-v1 Session edge explicitly refuses old `mode/set` events; configuration parsing independently refuses the retired `modes.plan.section` form.

Plan state remains reconstructable and tool schemas remain stable, but an idle pending selection is lost if the process exits before the next boundary. Entering or leaving plan mode changes the prompt from first-party order 500 onward, and a model that ignores the guidance can still mutate unless the deployment independently configures sandbox, approval, or filesystem policy.
