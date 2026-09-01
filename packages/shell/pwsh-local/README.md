---
description: "The local PowerShell executor for deployments and maintainers choosing, configuring, or debugging unconfined PowerShell command execution over the shell seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-pwsh-local

English | [中文](README.zh.md)

## Summary

`dsh-pwsh-local` is the PowerShell executor: every command runs as a fresh, non-interactive `pwsh -Command` process with no profile files, so no shell state survives between calls. It mirrors `dsh-bash-local`'s semantics call-for-call and adds PowerShell-shaped concerns: executable resolution, UTF-8 output pinning, and the model-friendly terminal environment. Commands run with the harness process's own authority — this executor confines nothing; compose `dsh-pwsh-sandbox` when commands need the sandbox capability. The model-facing `pwsh` tool talks to it once it is mounted.

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

Mount this executor when a composition needs PowerShell command execution — typically on Windows — without confinement. It registers as `ctx.shell`, and the model-facing `pwsh` tool works over it immediately: an agent calls the tool, and the command runs as a fresh `pwsh -Command` process with the budgets below.

### When to choose it

It is the Windows counterpart of `dsh-bash-local`: choose it where `pwsh` is the platform shell, so a composition can swap the POSIX rows for the pwsh rows and keep the same semantics. The executor resolves the `pwsh` executable from an explicit `pwshPath`, well-known Windows install locations, PATH entries, or Windows PowerShell 5.1 as a last resort. For unconfined execution it is the default; compose `dsh-pwsh-sandbox` when commands need the sandbox capability.

### Minimal configuration

Load the executor with the budgets you want; every field has a default, so the smallest composition is the plugin entry alone. The settings provider (when composed) layers a user section over this entry, so budgets can change at runtime without a reload (see [Adjusting budgets at runtime](#adjusting-budgets-at-runtime)).

```yaml
- id: bash
  name: '@deepseek-ai/dsh-pwsh-local'
  config:
    cwd: C:\path\to\workspace
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
| `pwshPath` | resolved | Explicit pwsh executable; else well-known locations, then PATH |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-pwsh-local) is the exhaustive source for every accepted field and its JSDoc.

### Running commands

Run a command with `run` and read its output from the result; a nonzero exit, a timeout, or a cancellation resolves descriptively, and only infrastructure failures reject. The command string rides as one argument to `-Command`: PowerShell parses the text itself and no intermediate shell exists, so there is no shell-quoting layer to escape and native Win32 paths pass through unchanged. Every command pins UTF-8 output first, so non-ASCII output is not garbled even on the Windows PowerShell 5.1 fallback. The environment is model-friendly: `NO_COLOR=1 PAGER=cat GIT_PAGER=cat` (no `TERM=dumb` — a POSIX concept), with explicit caller-provided entries still winning.

```text
const result = await ctx.shell.run(ctx.shell.resolve({ command: 'Get-ChildItem' }))
if (result.timedOut) console.log('timed out after', result.timeoutMs)
```

### Background processes

Call `start` to run a command in the background; it returns a handle immediately and no timeout applies. `readOutput()` merges the stream deltas into one consuming read, marking stderr under a `[stderr]` section; `kill()` stops the process tree; `done` settles when the process closes and never rejects. Job ids, ownership, polling, and notices belong to the generic `ctx.jobs` runtime, which the tool layer registers the handle with.

<a id="adjusting-budgets-at-runtime"></a>
### Adjusting budgets at runtime

When a settings provider is composed, this executor registers the capability's shared `shell` settings namespace — the same one the POSIX family uses, because a host composes exactly one provider of `ctx.shell` — so a user section in `settings.yaml` layers over the composition entry and the next command runs with the new budgets. Values the schema cannot judge — positive and finite numbers, and the `graceMs` timer bound — are refused at the write, leaving the running executor on its last good section.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the executor and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The executor is the PowerShell Service Provider for the `ctx.shell` seam built on the subprocess capability: it owns everything pwsh-shaped — executable resolution, command defaulting and caps, deadline fusion and cause classification, UTF-8 output pinning, the model-friendly terminal environment, and the background read merge — while process-tree mechanics (bounded spill-backed output, credential scrub, kill escalation, disposal) belong to the subprocess service. Every call spawns a fresh non-interactive `pwsh -Command` with `-NoLogo -NoProfile -NonInteractive`, so commands are deterministic and profile state never leaks between calls.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `PwshLocalExecutor`, `Config`, settings wiring, argv seam |
| [`src/resolve.ts`](src/resolve.ts) | Pure `resolvePwshPath`/`candidatePwshPaths` executable resolution |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |
| `tests/` | Exercised behavior: budgets, classification, resolution, background handles |

### Main flow

A call runs through three steps: `resolve()` fills `workdir`/`timeoutMs`/`stdoutMaxBytes` from config (capping the per-call `timeoutMs` override); the executor builds the pwsh argv — `pwsh -NoLogo -NoProfile -NonInteractive -Command <encoding preamble + command>` — fuses the config-clamped timeout with the caller's abort signal into one deadline, and spawns through `ctx.subprocess` with explicit byte caps and the `graceMs`; the settled outcome is classified and projected into a `ShellRunResult`. Windows reports forced termination as exit 1 without a signal, so signal-stamped facts are POSIX-only there; the timeout/abort classification is platform-independent.

### Invariants and ownership

- The `graceMs` budget must be positive, finite, and no greater than `MAX_TIMER_DELAY_MS` so Node can represent it with one timer; invalid values are refused where they are written.
- Environment layering is fixed: terminal overrides first, then the caller's `env`, then the trusted `dshEnv` snapshot last; the subprocess service scrubs ambient credentials and inherited `DSH_*` names independently.
- Executable resolution is a pure function of `(configured, env, platform)` and re-probes the filesystem only when the stored `pwshPath` differs from the one the current executable was resolved from.
- A background process belongs to the subprocess service: it survives an executor-only reload and is killed and joined when the service disposes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the executor contract is not enough. They move from the seam to the confining sibling and the PowerShell tool.

- [shell seam](../shell/README.md) — the executor contract this provider implements, including the request/spec split.
- [bash-local](../bash-local/README.md) — the POSIX counterpart this executor mirrors call-for-call.
- [pwsh-sandbox](../pwsh-sandbox/README.md) — the confining executor to compose instead when commands need the sandbox capability.
- [tool-pwsh](../tool-pwsh/README.md) — the model-facing `pwsh` tool over this executor.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — request/spec vocabulary, results, and the service contract in full.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-pwsh`, which renders this executor's bounded stdout/stderr tails, background-process deltas (through the generic job runtime), spill-file paths, and infrastructure failures.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this executor is a poor fit. They are current package constraints, not a roadmap.

- **Unconfined by itself** — commands run with the harness process's authority; deployments needing confinement compose a sandboxing executor or policy instead.
- **No persistent shell or PTY** — every call starts a fresh `pwsh -Command`.
- **The command string is PowerShell text** — the `-Command` domain has no shell-quoting layer, but a model-facing command is parsed by PowerShell itself, so PowerShell syntax errors are command failures, not launch failures.
- **A background spawn-failure note is single-delivery** — the subprocess service buffers no output for a process that never ran, so the executor injects `spawn failed: …` into exactly one `readOutput()` delta; a reader that discards that delta cannot recover it.
- **Windows termination reports no signal** — a force-killed process settles as exit 1 with `signal: null`, so signal-based status classification does not apply on Windows; `kill()`-initiated stops still stamp `killed` directly.
- **The encoding preamble precedes the command** — PowerShell requires `param(...)`, `#requires`, and `using` statements at the very top of a script, so a command whose first statement is one of those cannot run under the UTF-8 output preamble; wrap a `param(...)` script in `& { … }`, and run `using`/`#requires` scripts from a file instead.
- **Non-ASCII stdin under Windows PowerShell 5.1 may be mis-decoded** — the preamble pins output encoding only; `[Console]::InputEncoding` stays at the host default because setting it under redirected stdin throws; pwsh 7 defaults to UTF-8 and is unaffected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
