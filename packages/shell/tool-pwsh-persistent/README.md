---
description: "The model-facing persistent pwsh tool for users and maintainers choosing, configuring, or debugging owner-scoped PowerShell state that survives across calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh-persistent

English | [中文](README.zh.md)

## Summary

`dsh-tool-pwsh-persistent` gives the agent a `pwsh` tool whose PowerShell state persists across calls for the owning agent: cwd, `$env:` variables, functions, and background jobs survive between commands. It is the Windows counterpart of `dsh-tool-bash-persistent` — the same persistent-state contract in PowerShell dialect. Each agent gets its own shell backed by an owner-scoped PTY session with a pwsh-dialect backend, and commands for the same agent run one at a time. Configuration selects the backend and the wall-clock limit for one command; a timeout or an explicit `exit` closes the shell, and the next call starts fresh. Mount it with a pwsh-dialect terminal backend (Windows ConPTY or a POSIX pwsh) and the `ctx.terminals` service.

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

Load this plugin in any composition where the agent should keep PowerShell state between commands — the persistent counterpart of `dsh-tool-pwsh` for work that needs cross-call state. It registers the `pwsh` tool and requires the `ctx.tools` and `ctx.terminals` services plus an owning agent session at execution time.

### When to choose it

Choose the persistent tool when work depends on cross-call PowerShell state, and choose `dsh-tool-pwsh` when every command should start from a known, clean environment. Commands that need interactive stdin are unsupported here — a foreground child that reads input blocks until the command timeout, which resets the shell — so interactive work belongs to the terminal tools.

### Minimal configuration

The default `shell` backend starts a PowerShell shell through a `dsh-terminal-bash` instance configured with `shellDialect: pwsh`; deployments may register another pwsh-dialect PTY backend and select it by name.

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellDialect: pwsh
- name: '@deepseek-ai/dsh-tool-pwsh-persistent'
```

| Field | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registered PTY backend used for each agent's shell |
| `timeoutMs` | `300,000` | Wall-clock limit for one command; timeout closes the shell |
| `maxOutputChars` | `16,000` | Maximum retained command-output characters; fixed diagnostics are added afterward |
| `description` | `Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.` | Model-facing environment contract; deployments may describe their environment |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh-persistent) is the exhaustive source for every accepted field and its JSDoc.

### What the agent can rely on

Commands share one shell per agent, so cwd, `$env:` variables, functions, and background jobs persist across calls. Results exclude the private completion markers, the shell prompt, and the echoed input line. A non-zero wrapped command appends `[exit code: N]` — the exact native exit code when the command ran a native program, `1` for a terminating PowerShell error. A shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]` (Windows forced termination reports exit 1 without a signal), then resets and tells the agent the next call starts fresh. Long output keeps the earliest retained prefix plus a clipping notice; if the terminal has already dropped that prefix, the result says so explicitly.

### What can go wrong

A call without an owning agent session fails with `pwsh requires an owning agent session`, and a composition without a pwsh-dialect PTY backend activates the tool but fails its first call with `no PTY backend registered for "shell"`. A model redefinition of the `prompt` function removes the readiness marker, and the shell then settles on the silence tier instead of the marker fast path. Raw ESC characters inside a command are consumed by PSReadLine before execution and are unsupported. A timeout or cancellation closes the uncertain shell, discards the result, and reports the reset.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **A deliberate twin of `dsh-tool-bash-persistent`.** The session registry, polling loop, and reset contract mirror the persistent bash tool by design ([pwsh persistent PTY Agent Note](../../../.agents/notes/archived/architecture/2026-08-11-pwsh-persistent-pty.md)).
- **Prompt-function readiness.** The tool installs its own `prompt` function that prints a BEL-terminated OSC marker plus a printable prompt; the OSC marker carries the last exit code and the printable prompt settles every command, so a model redefinition of `prompt` degrades readiness to the silence tier.
- **PSReadLine echo stripped by anchoring.** PowerShell renders submitted input back into the stream; the marker-anchored extraction and a wrapper-source strip remove the echo, and a wrapper that wraps across the terminal width may leave a partial echo in partial-output results.
- **Reset, never repair.** Any uncertain state — an explicit `exit`, a timeout, a send failure, an abort — closes the shell and starts the next call fresh.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: shell registry, prompt setup, command wrapping, scrollback polling, extraction and rendering |
| — | No runtime invariant companion is published; the adapter's private owner-to-shell cache has no observable event or data relation. Lifecycle tests prove its cleanup without adding a public API solely for an invariant. |

### Command flow

A first command spawns the shell through `ctx.terminals.spawn`, installs the `prompt` override, and waits for readiness. Each command is wrapped into one physical line — `Write-Output` of the start marker, the body escaped with backtick escapes into a double-quoted string, and `Write-Output` of the end marker plus the exit status — so PSReadLine's echo of a wrapped line cannot fabricate completion. The tool polls the scrollback in 1,000-line pages until the end marker or a completed prompt appears, extracts the span, strips the echoed wrapper and prompts, and renders it with any status marker. A timeout aborts the deadline, captures the partial output, and resets the shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the terminal family to the seam, the backends, and the design notes behind the persistent-shell design.

- [terminal package map](../../terminal/README.md) — the persistent PTY capability family.
- [terminal seam](../../terminal/terminal/README.md) — the `ctx.terminals` service behind the tool.
- [terminal-bash backend](../../terminal/terminal-bash/README.md) — the default backend, configured with `shellDialect: pwsh`.
- [pwsh persistent PTY Agent Note](../../../.agents/notes/archived/architecture/2026-08-11-pwsh-persistent-pty.md) — the pwsh-side session design and its rationale.
- [Persistent PTY sessions Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the owner-scoped session design and its rationale.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent) — the exact `pwsh` argument schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh-persistent) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent), including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while `pwsh` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, `$env:` variables, functions, and background jobs persist across calls. Results exclude private completion markers, the shell prompt, and the echoed input line (PSReadLine renders submitted input back into the stream; the marker-anchored extraction and the wrapper-source strip remove it). A nonzero wrapped command appends `[exit code: N]` — the exact native exit code when the command ran a native program, `1` for a terminating PowerShell error. A shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]` when the backend supplies neither (Windows forced termination reports exit 1 without a signal), then resets and tells the model that the next call starts fresh. Long output keeps the earliest retained prefix plus a clipping notice; if the terminal has already dropped that prefix, the result says so explicitly. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

#### Token effect

Data-dependent. `maxOutputChars` bounds retained command output; fixed clipping, lost-prefix, status, timeout, and reset diagnostics can extend the result.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **The tool requires an owning Agent and a real terminal backend with a pwsh dialect** — Windows ConPTY or a POSIX pwsh.
- **Input echo is unavoidable** — PowerShell's PSReadLine renders submitted input back into the terminal stream, and there is no `stty -echo` equivalent. The marker-anchored extraction excludes the echo in complete results; the wrapper-source strip covers fallback paths, but a wrapper that wraps across the terminal width may leave a partial echo in partial-output results, bounded by `maxOutputChars`.
- **Raw ESC characters inside model commands are unsupported** — PSReadLine consumes them before execution. The wrapper escapes the control bytes it needs (`[char]27`-built OSC markers, backtick escapes for the body).
- **A model redefinition of the `prompt` function removes the readiness marker** — the shell then settles on the silence tier instead of the marker fast path.
- **There is no interactive stdin during a command** — a foreground command that reads input blocks until the command timeout, which resets the shell.
- **SIGTSTP/SIGHUP are unavailable on Windows** (backend-rejected); SIGINT is delivered as a console-wide Ctrl-C input write, which at a prompt cancels the pending line instead of signalling a process.
- **Under the Windows ACL sandbox's read-only mode, pwsh starts in ConstrainedLanguage**, which may deny the bootstrap's `[Console]::` encoding pin and prompt marker. Commands can still settle through the printable prompt and silence tier, but non-ASCII output may follow the host code page.
- **The BEL-terminated OSC marker remains a readiness signal only** — a BEL event channel to the model stays deferred, aligned with the current implementation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
