---
description: "The model-facing background-job controls for users and maintainers choosing, configuring, or debugging job_output, job_list, job_kill, and completion notices."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jobs

English | [中文](README.zh.md)

## Summary

`dsh-tool-jobs` gives the agent three kind-independent tools for background work — `job_output`, `job_list`, and `job_kill` — so any job the agent started, whether a background command, a PTY send, or a subagent, is read, listed, and cancelled through the same controls. When a job finishes, the owning agent is told in-session: a busy agent gets the notice in its next step, an idle agent is woken with a follow-up turn, bounded per owner. Loading the plugin also attaches the job controller that lets producers start background work. The tools are generic UI cards over `ctx.jobs`; configuration tunes wait timeouts and completion delivery.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition where the agent should start, observe, and stop background jobs: it registers the three tools, attaches the controller producers need, and delivers completion notices. It requires the `ctx.tools`, `ctx.jobs`, and `ctx.systemPrompt` services from the composed harness.

### The three tools

- `job_output(job_id, wait?, timeout_ms?)` — Read a job's output. Stream jobs return only the output since the previous read; final-output jobs return their result after settlement. Every response ends with `[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap and leaves a still-running job alive on timeout.
- `job_list()` — List your background jobs with their ids, kinds, and statuses, one per line: `<id> [<kind>] <status> — <label>`.
- `job_kill(job_id, reason?)` — Request cancellation of a running job immediately; the job settles as `killed` once its work actually stops. A terminal job returns its current snapshot, and the optional reason is recorded and forwarded to the job.

The three tools return `{ text, job }`, `PublicJobSnapshot[]`, and `{ outcome: 'cancellation-requested' | 'already-finished', job }` respectively. A public snapshot carries id, kind, label, status/detail, and start/finish times and omits ownership and notification bookkeeping. All three render through generic UI cards: `read` for output and list, `execute` for kill.

### Completion notices

When a job finishes, the owning agent receives `background job <id> (<kind>: <label>) finished [status: ...]. Read its output with job_output.` as an in-session message. A busy agent has the notice injected into its next step — the turn cannot close while the inbox holds it, so several jobs settling together cost one step rather than one turn each. An idle agent is instead woken with a follow-up turn, because an unclaimed notice is a completion the model never learns about. A kill or a terminal read/wait marks the completion reported and suppresses the redundant notice, as does the teardown cancel that drains an owner or the service.

Waking is bounded: each owner may be woken `maxConsecutiveWakes` times before further notices degrade to injection, and claiming any user-authored message restores the budget. The bound exists because the chain is self-exciting — a woken turn may start the background job whose completion wakes it again. `completionDelivery: quiet` keeps even idle owners on the injection lane, which deterministic transcripts need.

### Minimal configuration

Loading the plugin with no config is the common path; a `waitTimeoutMs` above `maxWaitTimeoutMs` fails at load.

```yaml
- name: '@deepseek-ai/dsh-tool-jobs'
```

| Field | Default | Meaning |
|---|---|---|
| `waitTimeoutMs` | `30,000` | Wait used when `wait: true` omits `timeout_ms` |
| `maxWaitTimeoutMs` | `600,000` | Cap for model-supplied waits; larger values clamp down to it |
| `completionDelivery` | `wakeup` | `wakeup` opens a turn on an idle owner; `quiet` leaves the notice pending |
| `maxConsecutiveWakes` | `3` | Turns one owner may open by wake before notices degrade to injection |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-jobs) is the exhaustive source for every accepted field and its JSDoc.

### What can go wrong

An agent whose composition loads no `tool-jobs` cannot start background work: this plugin's controller is what arms producers' `ctx.jobs.start()`. A model-supplied wait longer than `maxWaitTimeoutMs` is clamped down to the cap, and a timed-out wait returns `[status: running]` and leaves the job alive rather than failing. A completion notice pending on an idle owner does not survive that owner's disposal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tools and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Kind-independent controls.** The same three tools read, list, and cancel jobs of every producer kind — bash, subagent, PTY — because all of them register through the generic `ctx.jobs` runtime.
- **Delivery is owned here; recipients are the registry's.** The plugin decides how an unreported completion reaches the owner — injected into a busy step, or a woken turn on an idle owner — while the registry routes each settlement to the listeners its owner's scope chain reaches, so a mount under one preset never sees another preset's agents, and an agent reads exactly one notice per completion however many presets are mounted.
- **Producer-owned output bounds.** When a producer supplies `outputLimitBytes`, the complete model-facing result — output read, terminal kill snapshot, or completion notice — is capped after status and notice metadata are added; producers that omit it keep unbounded behavior.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registrations, completion listener, prompt section, output capping |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls. |

### Output capping

`job_output` and `job_kill` capture the caller-visible job in a prepended pre-execute listener before policy runs, so the producer's cap applies to the complete rendered result. `job_output` preserves its output/status split when policy left the default rendering intact, bounding the output tail and the `[status: ...]` suffix; other single-text results — denials, short-circuits, normalized tool or pipeline failures, replacements, and blocks — are bounded as one text, while structured multi-block policy results keep their shape. A bounded completion notice reserves the stable `background job <id>` prefix and the `job_output` collection instruction before spending remaining bytes on variable kind, label, status, detail, and truncation marker, so the notice stays actionable at the PTY's supported 64-byte minimum; an existing producer truncation marker is reused rather than duplicated.

### Notice delivery lanes

`onJobDone` skips jobs already reported or unowned. A `wakeup` delivery opens a turn on an idle owner while the budget lasts, tracked per exact `Agent` in a `WeakMap`; claiming a user-authored message (`agent/inbox/claimed`) resets that owner's budget. A busy owner — or any notice past the budget, or `quiet` delivery — is injected into the next-step inbox instead. Teardown settlements arrive already `reported`, so disposal never spends a model request announcing a notice nobody can read.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the job types to the registry contract and the generated schemas.

- [Background task runtime subsystem](../../../docs/subsystems/jobs.md) — the job types, snapshot fields, and `ctx.jobs` cordis surface.
- [jobs group map](../README.md) — the sibling group page and its package table.
- [Registry contract](../jobs/README.md) — the abstract `ctx.jobs` service behind the tools.
- [Process-local registry](../jobs-local/README.md) — where jobs run in this process.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jobs) — the exact `job_output`, `job_list`, and `job_kill` schemas.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-jobs) — every accepted config field and its source declaration.
- [job-registry seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md) — the owner-fenced registry contract and its rationale.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains this guidance. Agent-scoped tool filtering may hide the tools without removing the independently registered prompt section.

##### Background-job guidance

```markdown
Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.
```

#### Token effect

Small fixed input cost per request while active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The generated [`job_output`, `job_list`, and `job_kill` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jobs) while this tool set is visible.

#### Token effect

Fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results and notices

#### What the model sees

Reads return output or `(no new output)` followed by `[status: <status>]` and optional detail. An empty list returns `(no background jobs)`. Kill returns `requested cancellation of job <id>` or the existing terminal status. An unreported owned completion uses the notice above.

#### Token effect

Results and notices remain in parent history until compaction. Stream reads do not repeat consumed output; a producer-supplied `outputLimitBytes` bounds each complete read or notice. Under `wakeup`, a notice reaching an idle owner also buys a model request the user did not ask for, capped per owner by `maxConsecutiveWakes`; a notice reaching a busy owner adds a step to the turn it is already paying for.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **A settlement inside the driver's retirement window still strands its notice** — between the turn loop's last inbox check and the driver committing its idle phase the owner still reads as busy, so the notice is injected and nothing wakes. Steering has the same hole; closing it belongs to `agent-loop`.
- **A spent wake budget is not restored by time** — only user-authored input refills it, so an unattended agent whose budget ran out collects its remaining notices on the next turn something else opens.
- **A notice pending on an idle owner does not survive that owner's disposal** — the disposal cancel clears the unclaimed inbox, and the log keeps the insert/cancel pair as the record.
- **Stream reads are single-consumer** — independent observers need another runtime API.
- **Unowned jobs have no session fence** — external callers must supply policy or avoid them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
