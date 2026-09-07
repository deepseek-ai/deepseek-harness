---
description: "The default POSIX Bash executor for deployments and maintainers choosing, configuring, or debugging unconfined command execution over the shell seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-local

English | [中文](README.zh.md)

## Summary

`dsh-bash-local` is the default Bash executor for POSIX: every command runs as a fresh, non-login `bash -c` process with no rc files, so no shell state survives between calls. It applies configured budgets — working directory, timeout, output caps — to each command, classifies timeouts and cancellations, and returns bounded output with spill-file recovery when a stream overflows. Commands run with the harness process's own authority: this executor confines nothing, so compose `dsh-bash-sandbox` when commands need the sandbox capability. The model-facing `bash` tool talks to it once it is mounted.

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

Mount this executor when a composition needs Bash command execution on POSIX without confinement. It registers as `ctx.shell`, and the model-facing `bash` tool works over it immediately: an agent calls the tool, and the command runs as a fresh `bash -c` process with the budgets below.

### Minimal configuration

Load the executor with the budgets you want; every field has a default, so the smallest composition is the plugin entry alone. The settings provider (when composed) layers a user section over this entry, so budgets can change at runtime without a reload (see [Adjusting budgets at runtime](#adjusting-budgets-at-runtime)).

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace
    timeoutMs: 120000
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | Default working directory for commands |
| `timeoutMs` | `120,000` | Default foreground timeout, in milliseconds |
| `maxTimeoutMs` | `600,000` | Cap for per-call timeout overrides |
| `maxOutputBytes` | `64,000` | Per-stream in-memory output cap; overflow spills to a temp file |
| `maxSpillBytes` | `67,108,864` | Per-stream full-output spill cap |
| `graceMs` | `3,000` | Grace period for kill escalation and post-exit pipe draining |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-bash-local) is the exhaustive source for every accepted field and its JSDoc.

### Running commands

Run a command with `run` and read its output from the result. A nonzero exit, a timeout, or a cancellation resolves with a descriptive result — only infrastructure failures reject. Per-call `timeoutMs` overrides are capped by the configuration, while `workdir` falls back to the configured default when unset; a trusted foreground caller can also raise the stdout capture budget for one call, while stderr and background runs keep `maxOutputBytes`. The environment is model-friendly by default: `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` keep pagers and ANSI colors from garbling output, and an explicit caller-provided entry still wins.

```text
const result = await ctx.shell.run(ctx.shell.resolve({ command: 'ls -la' }))
if (result.timedOut) console.log('timed out after', result.timeoutMs)
```

### Background processes

Call `start` to run a command in the background; it returns a handle immediately and no timeout applies. `readOutput()` merges the stream deltas into one consuming read, marking stderr under a `[stderr]` section; `kill()` terminates the provider-managed range; `done` settles when the direct command closes and never rejects. Job ids, ownership, polling, and notices belong to the generic `ctx.jobs` runtime, which the tool layer registers the handle with.

<a id="adjusting-budgets-at-runtime"></a>
### Adjusting budgets at runtime

When a settings provider is composed, this executor registers the capability's shared `shell` settings namespace with the composition entry as its base, so a user section in `settings.yaml` layers over it and the next command runs with the new budgets. Values the schema cannot judge — positive and finite numbers, and the `graceMs` timer bound — are refused at the write, leaving the running executor on its last good section; without a provider, the composition entry is what runs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the executor and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The executor is a Service Provider for the `ctx.shell` seam built on the subprocess capability: it owns everything bash-shaped — command defaulting and caps, deadline fusion and cause classification, the model-friendly terminal environment, and the background read merge — while managed-range mechanics (bounded spill-backed output, credential scrub, termination escalation, quiescence, and disposal) belong to the subprocess service. Every call spawns a fresh non-login `bash -c` with no rc files, so commands are deterministic and shell state never leaks between calls.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LocalBashExecutor`, `Config`, settings-section wiring |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |
| `tests/executor.spec.ts` | Exercised behavior: budgets, classification, background handles, ownership |
| `tests/settings.spec.ts` | Settings layering over the composition entry |

### Main flow

A call runs through three steps: `resolve()` fills `workdir`/`timeoutMs`/`stdoutMaxBytes` from config (capping per-call overrides); `run` fuses the config-clamped timeout with the caller's abort signal into one deadline and spawns `['bash', '-c', command]` through `ctx.subprocess` with explicit byte caps and the `graceMs`; the settled subprocess outcome is classified — only the executor's own timeout reports `timedOut`, an upstream cancel reports `aborted`, a self-signaled command reports neither — and projected into a `ShellRunResult` with collected output.

### Invariants and ownership

- The `graceMs` budget must be positive, finite, and no greater than `MAX_TIMER_DELAY_MS` so Node can represent it with one timer; invalid values are refused where they are written.
- Environment layering is fixed: terminal overrides first, then the caller's `env`, then the trusted `dshEnv` snapshot last; the subprocess service scrubs ambient credentials and inherited `DSH_*` names independently.
- A background process belongs to the subprocess service: it survives an executor-only reload and is killed and joined when the service disposes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the executor contract is not enough. They move from the seam to the confining sibling and the mechanics underneath.

- [shell seam](../shell/README.md) — the executor contract this provider implements, including the request/spec split.
- [bash-sandbox](../bash-sandbox/README.md) — the confining executor to compose instead when commands need the sandbox capability.
- [tool-bash](../tool-bash/README.md) — the model-facing `bash` tool over this executor.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — request/spec vocabulary, results, and the service contract in full.
- [subprocess-local](../../subprocess/subprocess-local/README.md) — the managed-range mechanics behind this executor.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-bash`, which renders this executor's bounded stdout/stderr tails, background-process deltas, spill-file paths, and infrastructure failures.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this executor is a poor fit. They are current package constraints, not a roadmap.

- **Unconfined by itself** — commands run with the harness process's authority; deployments needing confinement compose `dsh-bash-sandbox`, while per-call allow/deny/ask policy belongs on the tools' `pre-execute` waterfall.
- **No persistent shell or PTY** — every call starts a fresh non-login `bash -c`; cwd-only persistence and interactive terminal sessions remain deferred until a real workflow requires them.
- **POSIX-only** — the `bash` binary is hardcoded and the underlying service's group semantics are POSIX; Windows is unsupported.
- **A background provider-failure note is single-delivery** — `SubprocessHandle.done` can reject before or after target execution begins, so the executor injects the stage-neutral `subprocess failed before reporting an outcome: …` into exactly one `readOutput()` delta; a reader that discards that delta cannot recover it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
