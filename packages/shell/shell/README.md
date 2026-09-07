---
description: "The bash executor seam for developers and maintainers choosing, composing, or implementing command execution over ctx.shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-shell

English | [中文](README.zh.md)

## Summary

`dsh-shell` defines the executor service (`ctx.shell`) that runs shell commands for the harness: foreground commands that resolve with bounded output when they finish, and background processes that return a handle immediately. Every shell executor in the repository — local Bash, sandboxed Bash, local PowerShell, sandboxed PowerShell — implements this one contract, so the model-facing `bash` and `pwsh` tools work unchanged over any of them. Callers pass a request and receive a fully-resolved spec with explicit defaults and caps before any command runs. The service itself never renders anything to a model; the shell tools own all model-visible output and sandbox guidance.

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

Use `ctx.shell` when an agent or an in-process plugin needs to run a shell command and read its output, or start a background process and poll it. It is the contract every shell executor and the model-facing `bash`/`pwsh` tools build on, so code written against it works over any executor implementation.

### Foreground commands

Call `run` with a resolved spec to execute a command in the foreground. The promise resolves when the command finishes: a nonzero exit, an executor timeout kill, or a caller abort kill is a result, never a rejection. `run` rejects only for infrastructure failures such as an unusable working directory or a missing shell. The result carries the exit code or signal, whether a timeout or an abort cut the run short, and the collected stdout/stderr with spill-file paths when a stream overflowed its budget.

```text
const result = await ctx.shell.run(ctx.shell.resolve({ command: 'ls -la' }))
console.log(result.exitCode, result.stdout.text)
```

### Background processes

Call `start` with a resolved spec to launch a background process; it returns a handle immediately and no timeout applies. Read output incrementally with `readOutput()` — consecutive reads never repeat output, and lossy reads point at full-stream spill files. Terminate the provider-managed range with `kill()` (returns `false` once the direct command has finished) and await `done` for direct-command settlement. Job ids, ownership, polling, and notices belong to the generic `ctx.jobs` runtime, where the tool layer registers the handle.

### Requests and resolved specs

Every execution starts from a `ShellExecRequest` with optional fields; the executor's `resolve()` turns it into a fully-resolved `ShellExecSpec` with explicit defaults and caps before anything runs. This request/spec split is the repository's template for explicit resolution at package boundaries: callers never rely on hidden defaults inside `run` or `start`. `resolve()` fills the working directory and timeout from the executor's configuration, caps per-call overrides, and carries optional inputs — `stdin`, ordinary `env`, and the trusted `DSH_*` snapshot — through verbatim.

### Choosing and composing an executor

The seam is not an executor: mount exactly one provider per composition, and the tools work unchanged. On POSIX, `dsh-bash-local` runs commands as fresh `bash -c` processes and `dsh-bash-sandbox` confines every command through the sandbox capability; on Windows, `dsh-pwsh-local` and `dsh-pwsh-sandbox` are the counterparts. The `bash` and `pwsh` tools advertise escalation fields only while a sandboxing executor is mounted. The smallest composition is the executor alone:

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace
```

### The shared exit-status contract

Tool results end with a machine-readable exit marker — `[exit code: N]` or `[killed by signal: X]` — so the model can always tell how a command ended. The seam owns that marker format and the `parseExitStatus` helper that splits a rendered result back into its output body and structured exit status, keeping the `bash` and `pwsh` tools from drifting on it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the seam and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is one role of a standard capability seam: the Service Definition that names the executor contract, with Service Providers and Consumers split so each role evolves independently (see the [capability-seams note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)). Two decisions anchor the contract:

- **Explicit resolution at the boundary.** `resolve(request)` is the single place defaults and caps are applied; `run` and `start` accept only resolved specs and never re-default, so no hidden fallback lives inside an implementation.
- **Task-free background handles.** `start` returns a `ShellProcess` with no id or owner; job identity, ownership, and lifecycle belong to the generic `ctx.jobs` runtime, keeping executors independent of sessions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `ShellExecutor` service and the shared settings namespace |
| [`src/types.ts`](src/types.ts) | Request/spec vocabulary, `ShellRunResult`, `ShellProcess`, and sandbox facts |
| [`src/render.ts`](src/render.ts) | `parseExitStatus`: the exit-status marker contract the shell tools share |
| — | No runtime invariant companion is published; this stateless Service Definition owns request/result types, while executors and policy own observations. |

### Settings namespace

`SHELL_SETTINGS_NAMESPACE` is exported here rather than by a provider because it names the capability, not an implementation: a host composes exactly one provider of `ctx.shell`, so the providers share one namespace without colliding, and a settings document carried between platforms keeps resolving on both.

### Background lifecycle and ownership

A background process belongs to the subprocess service, not to the executor: it survives an executor-only reload and is killed and joined when the composition tears down. Implementations must honor the seam's semantics — `run` rejects only for infrastructure failures; `start` returns immediately with no timeout and its `done` never rejects (a subprocess provider rejection settles as `killed` with a stage-neutral error on stderr); `readOutput` is consuming and lossy reads report spill files.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the seam contract is not enough. They move from the shared subsystem reference to the concrete executors and the model-facing tools.

- [Bash executor subsystem](../../../docs/subsystems/shell.md) — the request/spec vocabulary, results, and service contract in full.
- [bash-local](../bash-local/README.md) — the default POSIX executor: fresh `bash -c` processes, budgets, and deadlines.
- [bash-sandbox](../bash-sandbox/README.md) — the confining executor: sandbox modes, denials, and escalation.
- [tool-bash](../tool-bash/README.md) — the model-facing `bash` tool over this seam.
- [Capability seams note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Provider / Consumer split this seam follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-bash`, which turns executor output and sandbox facts into guidance and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the seam does not provide. They are current package constraints, not a roadmap.

- **No interactive-input vocabulary** — `stdin` is written once at spawn and closed; the seam has no channel to feed a running task and no PTY session concept.
- **Foreground timeouts are always executor-owned** — a caller-owned-deadline mode on the seam is explicitly deferred by the [tool-call timeout-policy note](../../../.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
