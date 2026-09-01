---
description: "The model-facing persistent bash tool for users and maintainers choosing, configuring, or debugging owner-scoped shell state that survives across calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bash-persistent

English | [中文](README.zh.md)

## Summary

`dsh-tool-bash-persistent` gives the agent a `bash` tool whose shell state persists across calls for the owning agent: cwd, exported variables, functions, and background jobs survive between commands. Each agent gets its own shell backed by an owner-scoped PTY session from the terminal service, and commands for the same agent run one at a time. Configuration selects the PTY backend and the wall-clock limit for one command; a timeout or an explicit `exit` closes the shell, and the next call starts fresh. It complements the one-shot `dsh-tool-bash` tool — choose it when work needs cross-call state. Mount it together with a terminal backend such as `dsh-terminal-bash` and the `ctx.terminals` service.

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

Load this plugin in any composition where the agent should keep shell state between commands — for example long build sessions, activated environments, or scripts that export variables for later steps. It registers the `bash` tool and requires the `ctx.tools` and `ctx.terminals` services plus an owning agent session at execution time.

### When to choose it

Choose the persistent tool when work depends on cross-call state: a one-shot `dsh-tool-bash` call cannot remember a `cd` or an exported variable. Choose the one-shot tool when every command should start from a known, clean environment, or when the command is short and self-contained. Commands that need interactive stdin are unsupported here — a foreground child that reads input blocks until the command timeout — so interactive work belongs to the terminal tools.

### Minimal configuration

The default `shell` backend starts an interactive bash through `dsh-terminal-bash`; deployments may register another PTY backend and select it by name.

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-bash-persistent'
```

| Field | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Registered PTY backend used for each agent's shell |
| `timeoutMs` | `300,000` | Wall-clock limit for one command; timeout closes the shell |
| `maxOutputChars` | `16,000` | Maximum retained command-output characters; fixed diagnostics are added afterward |
| `description` | `Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.` | Model-facing environment contract; deployments may describe their environment |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-bash-persistent) is the exhaustive source for every accepted field and its JSDoc.

### What the agent can rely on

Commands share one shell per agent, so state persists until an `exit`, a timeout, or a reset — each of which closes the shell and tells the agent the next call starts from the workspace with a fresh directory and environment. Results exclude the private completion markers; a non-zero wrapped command appends `[exit code: N]`, and a shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]`, then resets. Long output keeps the earliest retained prefix plus a clipping notice; if the terminal has already dropped that prefix, the result says so explicitly rather than presenting a tail as complete output.

### What can go wrong

A call without an owning agent session fails with `bash requires an owning agent session`, and a composition without a PTY backend activates the tool but fails its first call with `no PTY backend registered for "shell"`. An interactive foreground child (for example a REPL) returns early with partial output only where the backend proves its stdin wait; elsewhere the call runs to `timeoutMs`, which closes the uncertain shell and reports the reset. Cancellation also resets and discards the result, even when a complete status marker is already observable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One shell per owner, nothing shared.** The shell registry keys every session by the calling `Agent`, so concurrent agents never share state, and commands for the same agent are serialized through a per-owner queue.
- **Marker-anchored extraction.** Each command is wrapped with unique start/end markers carrying the exit status; the tool polls the PTY scrollback and extracts the span between the real markers, so prompts and echoed input never leak into results.
- **Reset, never repair.** Any uncertain state — an explicit `exit`, a timeout, a send failure, an abort — closes the shell and starts the next call fresh, because a half-known shell is worse than a clean one.
- **Owner-scoped lifecycle.** Shells are created lazily on first use and killed on plugin disposal or owner teardown; the owner-scoped `ctx.terminals` service fences every operation to the owning agent.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: shell registry, command wrapping, scrollback polling, extraction and rendering |
| — | No runtime invariant companion is published; the adapter's private owner-to-shell cache has no observable event or data relation. Lifecycle tests prove its cleanup without adding a public API solely for an invariant. |

### Command flow

A first command spawns the shell through `ctx.terminals.spawn`, disables input echo (`stty -echo`), and waits for readiness. Each command is then wrapped into one physical line — a printf of the start marker, the command body escaped with `$'…'`, and a printf of the end marker plus `$?` — so embedded newlines cannot leak terminal prompts into the result. The tool polls the scrollback in 1,000-line pages until the end marker appears, extracts the span, and renders it with any status marker. A timeout aborts the deadline, captures the partial output, and resets the shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the terminal family to the seam, the backends, and the design note behind owner-scoped sessions.

- [terminal package map](../../terminal/README.md) — the persistent PTY capability family.
- [terminal seam](../../terminal/terminal/README.md) — the `ctx.terminals` service behind the tool.
- [terminal-bash backend](../../terminal/terminal-bash/README.md) — the default `shell` backend.
- [tool-terminal](../../terminal/tool-terminal/README.md) — six model-facing terminal tools for interactive work.
- [Persistent PTY sessions Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the owner-scoped session design and its rationale.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash-persistent) — the exact `bash` argument schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-bash-persistent) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`bash` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash-persistent), including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while `bash` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, exported variables, activated environments, functions, and background jobs persist across calls. Results exclude private completion markers. When the shell reads stdin again without having printed the completion marker — after `exec`, an interrupt, or an interactive foreground child whose stdin wait the provider proves — the call returns the captured partial output, which can end with the backend's own prompt text. A nonzero wrapped command appends `[exit code: N]`; a shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]` when the backend supplies neither, then resets and tells the model that the next call starts fresh. Long output keeps the earliest retained prefix plus a clipping notice. If the PTY has already dropped that prefix, the result says so explicitly instead of presenting a tail as complete output. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

#### Token effect

Data-dependent. `maxOutputChars` bounds retained command output; fixed clipping, lost-prefix, status, timeout, and reset diagnostics can extend the result.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **The tool requires an owning Agent and a real PTY backend** — agent-less calls and backends that cannot start an interactive shell fail.
- **An interactive foreground child returns early with partial output only where the subprocess provider proves its stdin wait** — elsewhere the call runs to `timeoutMs`.
- **Explicit `exit` and timeout discard shell state** — cancellation also resets and discards the result, even when a complete status marker is already observable; the next call starts a fresh shell.
- **Environment facts such as network access and package mirrors belong in the configured `description`** — not this package's default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
