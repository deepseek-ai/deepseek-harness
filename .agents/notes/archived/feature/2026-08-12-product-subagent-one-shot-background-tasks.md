# Agent Note: Product one-shot subagents use generic background Jobs

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-product-subagent-one-shot-background-tasks.zh.md)

## Problem

The Codex and Claude Code providers already run one self-contained task and return one final answer, while `dsh-tool-subagent` already adapts any one-shot provider to the generic background Job runtime. The shipped product-tool rows disabled that route, so an agent could only wait for the product answer even when the delegation was independent of its next action.

Exposing background execution must not add a product session, product-specific job state, another cancellation owner, or another result protocol. The same provider run must remain responsible for one native process or query and one final answer, while the existing Job registry remains responsible for ids, collection, cancellation, owner cleanup, and completion notices.

## Decision

Production `dsh` does not install the optional product providers. A Profile that opts in installs the needed `dsh-subagent-codex` or `dsh-subagent-claude-code` packages and mounts the required provider instances on the host plane. The `standard`, `code`, and `cordis` Agent Presets configure the corresponding dormant tool rows with `backgroundMode: one-shot`; removing a row's `disabled` field exposes the existing optional `run_in_background` argument to agents composed from that preset. Omission or `false` waits in the foreground; explicit `true` returns a parent-owned Job id after synchronous Job preflight and registration, without waiting for provider startup or completion.

The [named-instance decision](2026-08-18-product-subagent-named-instances.md) allows multiple rows for either product. Each additional host provider row has its own `providerName`, and each exposed preset tool row binds that exact name through `provider` while keeping a unique `toolName`; the foreground/background scheduling choice does not constrain the number of instances.

The [generic one-shot background adapter](2026-07-08-background-subagent-tasks.md) owns background registration and settlement. It starts the same [`SubagentRun`](2026-06-21-subagent-capability-seam.md), uses a Job-owned cancellation signal across provider startup and execution, waits for `run.result` and `run.dispose()`, maps the terminal result and optional safe diagnostic into the Job, and lets `job_output`, `job_list`, `job_kill`, and the existing completion notice expose that state. The [product provider decision](2026-08-04-claude-code-and-codex-subagent-backends.md) continues to own native protocols, answer selection, local cancellation, and process-tree quiescence; the [non-interactive permissions decision](2026-08-15-product-subagent-noninteractive-permissions.md) owns each product Provider's Profile configuration and diagnostic production.

This scheduling decision adds no provider configuration, service interface, event, wire field, persistence format, or product identifier. A Provider may define its own Profile configuration independently; foreground and background still differ only in which existing consumer waits for the same one-shot run.

### Ownership and lifecycle

```text
product tool call
  -> omitted / false: tool call waits -> final answer or error -> run disposal
  -> true: Job preflight + owner cleanup
           -> starter begins provider startup under Job-owned signal
           -> Job record/id published and returned (startup remains pending)
           -> provider result + run disposal -> Job settlement + notice
                                              -> job_output reads / job_kill cancels
  -> parent disposal: Job owner cleanup cancels -> run disposal -> process exit
```

| Fact or resource | Owner | Product-tool responsibility | Observable result |
| --- | --- | --- | --- |
| Product provider installation and registration | Explicit Profile | Install the optional provider package and mount the required named instances on the host plane | The provider names are available without adding the package to every production `dsh` install |
| Product selection and exposure | Agent Preset | Bind one fixed tool name to one fixed provider | Enabling one row exposes only that product tool |
| Foreground or background choice | `dsh-tool-subagent` | Resolve `run_in_background` under `one-shot` policy | Omission is foreground; explicit `true` returns a Job id |
| Job id, state, output, cancellation, and notice | `ctx.jobs` and `dsh-tool-jobs` | Register and present the existing one-shot run | Generic job tools collect or stop the run for the exact parent |
| Native result, optional diagnostic, and process quiescence | Product provider and `dsh-subprocess` | Produce one final result and release one process tree | Job settlement and foreground return consume the same result and both wait for disposal |

## Published composition

The production base keeps both optional product providers out of its dependency closure. An opting-in Profile installs the needed packages and mounts the required provider instances on the host plane. Each full preset keeps both product-tool rows disabled and contributes the generic Job controls to its own agent scope, while the base host owns the shared Job registry. A user copies a preset and removes `disabled` from the matching product rows after the Profile providers are present; no product process starts during composition.

A standalone custom composition that enables one-shot background execution must provide the product provider plus the complete generic Job capability: `dsh-jobs-local` as the Job provider and `dsh-tool-jobs` as the model-facing consumer. A Profile based on `dsh-base` already has the Job capability and adds only the optional product provider before enabling the preset tool row. A product tool without the Job runtime can still execute in the foreground, but an explicit background request fails the existing Job preflight instead of publishing an uncollectable id.

The ACP product compositions use the same fixed product rows and generic job controls. Their keyless schema snapshots expose `description`, `prompt`, and optional `run_in_background` for each enabled product tool without invoking Codex, Claude Code, or an external model.

## Verification

The Web composition test explicitly mounts both optional providers from the repository examples dependency anchor, then boots four user-preset variants—neither product, Codex, Claude Code, and both—and checks that each enabled product tool exposes `run_in_background` alongside `job_output`, `job_list`, and `job_kill`. The two package-owned Loader compositions run with an empty `PATH`, inspect the same schemas and controls, and prove that explicit provider loading starts no product process. ACP keyless snapshots pin the assembled explicit product schemas, while the existing `dsh-tool-subagent` and job suites pin foreground defaulting, Job registration, final-output collection, shared diagnostic presentation, cancellation, completion notices, owner disposal, and provider disposal. The two real product-provider suites independently prove that their native permission failures enter that same shared result before either scheduling path consumes it.

## Alternatives considered

**Keep the product tools foreground-only.** This preserves the smallest schema but prevents agents from scheduling independent product work even though the generic one-shot Job adapter already owns the required lifecycle.

**Make product delegations background by default.** A one-shot Job requires later collection, unlike a continuable child with its own durable conversation id and settlement delivery. Foreground remains the compatible default, and background remains an explicit scheduling choice.

**Use Codex or Claude Code native session state as the background owner.** That would create provider-specific ids, status, cancellation, and recovery semantics beside the generic Job registry. The providers remain one-shot result producers and keep native ids private.

**Add product-specific output, wait, or kill tools.** Separate controls would duplicate the generic job protocol and teach a different collection workflow for each provider. The existing `job_*` tools already cover the required operations.

**Add continuable product sessions at the same time.** Resume, follow-up, progress, and persisted product sessions require new product contracts and lifecycle ownership. This decision exposes only the already implemented one-shot background route.

## Consequences

Agents can continue useful work while Codex or Claude Code handles an independent one-shot task, then collect the final answer or cancel it through the same Job controls used by other background producers. Foreground and one-shot background consumers present the same safe Provider diagnostic when a failed result supplies one.

Every product delegation still starts a fresh native process or query, produces final assistant text as its only assistant payload, and ends with provider disposal and whole-tree exit. A failed result may separately carry a safe diagnostic. A background call additionally exposes the generic Job id, status, completion notice, and collection or cancellation results. Background Jobs are process-local and parent-owned: they do not survive parent disposal, do not expose intermediate product activity, and do not make a product conversation resumable. Production installs do not pay for either product integration unless a Profile explicitly installs it; any composition that exposes the background argument must also keep the generic Job provider and controls available.
