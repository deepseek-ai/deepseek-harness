---
description: "The model-facing bash tool for users and maintainers choosing, configuring, or debugging one-shot command execution, background jobs, and sandbox escalation."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bash

English | [中文](README.zh.md)

## Summary

`dsh-tool-bash` gives the agent a `bash` tool that runs commands through the mounted shell executor and returns stdout, stderr, and exit markers. Each call runs in a fresh shell — no cwd, variables, or functions survive — and `run_in_background` turns long-running commands into background jobs the agent collects with `job_output` and stops with `job_kill`. Every call runs with the managed `DSH_*` environment from `dsh-shell-env`, and under a sandboxing executor a denied command may be retried once with a wider `sandbox_permissions` mode plus a `justification` through user approval. Non-zero exits are reported, not failed, so the agent decides how to react. Mount it together with an executor provider such as `dsh-bash-local` or `dsh-bash-sandbox` and the `dsh-shell-env` plugin.

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

Load this plugin in any composition where the agent should run bash commands: it registers the `bash` tool once an executor provider and the `dsh-shell-env` registry are mounted, and stays pending until the `tools`, `shell`, `systemPrompt`, and `shellEnv` services exist.

### Minimal configuration

The common path is an executor provider, the environment registry, and this tool; add the job runtime when the agent may run commands in the background.

```yaml
- name: '@deepseek-ai/dsh-bash-local'
- name: '@deepseek-ai/dsh-shell-env'
- name: '@deepseek-ai/dsh-tool-bash'

# Optional: background jobs
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
```

The single config field toggles background support.

| Field | Default | Meaning |
|---|---|---|
| `enableRunInBackground` | `true` | Expose `run_in_background`; when `false`, forced background calls are rejected |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-bash) is the exhaustive source for every accepted field and its JSDoc; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash) carries the full argument schema.

### Running a command

The tool executes `bash -c <command>` and returns the combined output. Commands run in a fresh shell every call, so state never persists — pass `workdir` instead of `cd`. A non-zero exit is reported as `[exit code: N]` for the agent to interpret, not surfaced as a tool error. A `description` in active voice (5–10 words) labels the call in the UI; `timeoutMs` overrides the executor's default and cap. Output beyond the executor's stream caps is truncated to its tail, with the full output saved to a spill file whose path is reported.

### Running long commands in the background

Passing `run_in_background: true` returns a job id immediately and no timeout applies; the command keeps running while the agent works on something else. The agent reads its output with `job_output` (non-blocking unless `wait: true`), lists jobs with `job_list`, and stops it with `job_kill`; a finished job notifies the owning agent in-session. Background support needs the generic job runtime (`dsh-jobs-local`) and its control tools (`dsh-tool-jobs`) mounted.

### Sandboxed execution and escalation

When the mounted executor confines commands (for example `dsh-bash-sandbox`), a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a command failure. The model may then retry the exact same command once in the same turn with `sandbox_permissions` (the narrowest wider mode that suffices) and a one-sentence `justification`; the approval prompt raised by that retry is how the user consents. Escalation is never speculative: a request with no real prior denial, or one that is not strictly wider than the current mode, fails closed without running anything, and a rejected escalation is final for that command.

### What can go wrong

A composition with no executor provider never activates the tool. Background calls without the job runtime fail with `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`, and `sandbox_permissions` without a sandboxing executor fails with `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`. `enableRunInBackground: false` removes the parameter and rejects a forced background call at execution time.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Model-facing consumer of the shell seam.** The tool is the Consumer role of the bash capability: it registers the `bash` schema, renders results, and resolves per-call policy, while the executor seam owns process mechanics.
- **Request from named args only.** The tool never exposes `stdin`, `env`, or `stdoutMaxBytes`; it builds each request from command/workdir/timeout/signal fields plus the registry-collected `dshEnv`, so model-supplied keys cannot replace managed values.
- **Non-zero exits are reported, not errored.** Only infrastructure failures (spawn errors, aborts) surface as tool errors; the model interprets exit codes and markers.
- **Background work belongs to the job runtime.** A background call registers a process handle with `ctx.jobs`; ids, ownership, completion notices, and disposal are the runtime's, and this tool only maps bash exit and sandbox facts into job output.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, prompt section, arg validation, escalation, request assembly |
| [`src/background.ts`](src/background.ts) | Map a settled background process onto generic job outcome vocabulary |
| [`src/render.ts`](src/render.ts) | Model-facing result text: streams, markers, truncation notices |
| — | No runtime invariant companion is published; the environment registry validates ownership and collected values at each mutation/read; it publishes no independent snapshot that a companion could cross-check. |

### Request resolution

The tool resolves the workdir before `ctx.shell.resolve()` runs: an explicit relative `workdir` is resolved against the session cwd, and a sandbox policy's canonical workspace root wins so confinement and launch use the same identity. Sandbox policy resolves per call through `ctx.sandboxPolicy`; an escalation request goes through `ctx.approval` before anything executes, and the tool fails at load if the executor confines but no policy service is mounted.

### Rendering story

The result text is stdout, then a marked `[stderr]` section, then conditional markers: truncation notice, sandbox denial (plus the same-turn escalation hint when the composition advertises escalation), timeout, signal, and exit code — each on its own line. The exit marker doubles as the UI card's exit-status pill: the shared `parseExitStatus` from `dsh-shell` consumes it from the output body, so replay shows the pill without duplicating the marker.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shell family to the executor seam, the job runtime, and the decision notes behind the behavior.

- [shell package map](../README.md) — the bash capability family and its roles.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — request/spec vocabulary, results, and background processes.
- [shell-env](../shell-env/README.md) — the managed `DSH_*` environment every call receives.
- [tool-jobs](../../jobs/tool-jobs/README.md) — `job_output`, `job_list`, and `job_kill` controls for background runs.
- [sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — escalation and mode-switching rationale.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash) — the exact `bash` argument schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-bash) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the bash guidance below at first-party order 1000. The policy owner contributes current sandbox state through its cache-safe runtime context rather than changing this section. Scoped tool restrictions can hide the schema without removing this independently registered section.

##### Bash guidance

```markdown
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

#### Token effect

Small fixed input cost per request while the plugin is active, unchanged by sandbox mode or mode switches.

#### KV Cache effect

Prefix-stable while the registration scope and prompt text are unchanged. Plugin activation or disposal may invalidate reuse from this prompt section; sandbox mode switches do not.

### Tool schemas

#### What the model sees

The model sees the generated [`bash` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash). `run_in_background` appears only when this producer enables it; `sandbox_permissions` and `justification` appear only when the mounted executor advertises sandboxing. Agent-scoped tool restrictions can remove the definition for that agent.

#### Token effect

Fixed schema cost on every request where the tools are visible; sandbox support adds the escalation fields and its conditional description paragraph.

#### KV Cache effect

Prefix-stable while visibility, background support, and executor sandbox capabilities are unchanged. A restriction, config change, or executor change may invalidate reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The renderer emits the data-dependent stdout tail, then optional `[stderr]` and the stderr tail. With no output it emits exactly `(no output)`. Conditional lines are exactly `[output truncated; full output: <path-or-(unavailable)>]`, `[sandbox: file access denied under <mode> mode]`, `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]`; the sandbox escalation and runner-failure lines are quoted in [`dsh-bash-sandbox`](../bash-sandbox/README.md).

#### Token effect

Zero result tokens before a call. Output is bounded per stream, while each emitted line remains in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background job context and results

#### What the model sees

Start returns exactly `started background job <jobId>`. This producer supplies incremental process output, optional `[some output was dropped from memory; full output: <paths-or-(unavailable)>]`, sandbox facts, and terminal detail such as `exit code: <exitCode>` or `signal: <signal>` to the generic job runtime. [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md) owns the visible status line, completion notice, listing, and cancellation response.

#### Token effect

The start acknowledgement is small and retained; collected output is data-dependent and bounded by the executor's stream buffers. Consuming reads do not repeat prior output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Validation and policy failures are normalized as `Error: <message>`. This package's stable messages are `invalid command: expected a non-empty string`, `invalid description: expected a non-empty string`, `invalid timeoutMs: expected a positive number, got <value>`, the escalation pairing failures, `run_in_background is disabled for this deployment (enableRunInBackground: false)`, `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`, `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`, the approval availability/rejection/cancellation variants, and `tool call aborted`.

#### Token effect

Only the failing call adds these retained tokens; a rejected escalation does not add command output because the command does not run.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Replay exit pills parse from result text** — output whose final line happens to be exactly `[exit code: N]` / `[killed by signal: …]` shows a wrong pill on session replay and loses that line from the card body, because the parse treats it as the marker it consumes; a display-only known residual.
- **The `bash` tool opts out of `timeout-policy` budgets** — it keeps the executor-owned `BASH_TIMEOUT` path, per [the tool-call timeout-policy Agent Note](../../../.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
- **Background processes have no executor timeout** — callers must use `job_kill`, or rely on owner/service disposal, when work no longer matters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
