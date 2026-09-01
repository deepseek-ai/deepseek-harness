---
description: "Six model-facing persistent terminal tools with owner isolation, bounded results, and optional background sends for agents that need cross-call terminal state."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-terminal

English | [中文](README.zh.md)

## Summary

`dsh-tool-terminal` gives the model six tools over persistent terminal sessions: `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, and `terminal_list`. Every call is fenced to the exact agent that opened the session, so a model cannot operate another agent's terminal even if it learns the id. Sends run in the foreground (returning bounded output with a wait reason) or in the background through the jobs service (returning a job id collected with `job_output` and stopped with `job_kill`). Results are capped by `maxResultBytes` and stay in session history until compaction. A short guidance section tells the model to prefer one-shot tools unless a terminal's persistent state or interactive stdin is genuinely needed.

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

Enable these tools when the composition mounts a terminal backend and the model should be able to use terminal state across calls — stepping a debugger, exploring in a REPL, or returning to a shell after interrupting a foreground command. The guidance section steers the model toward the one-shot bash, read, write, and edit tools for bounded operations.

### The six tools

| Tool | What it does | Result |
|---|---|---|
| `terminal_open` | Creates an owner-scoped session from a backend type | Session id, name, type, pid, status, and bounded startup output |
| `terminal_send` | Writes text, optionally submitting Enter, and waits for readiness — or starts a background job | Bounded output plus wait and session status, or a job id |
| `terminal_read` | Reads a bounded page of retained output without sending input | Text with line pagination metadata |
| `terminal_signal` | Delivers one allowed signal to the foreground process group | `delivered` plus the target process group id |
| `terminal_close` | Closes a session and waits for its process tree to end | Closed or already-closing outcome |
| `terminal_list` | Lists the caller's live sessions | Owner-scoped session summaries |

### Composition

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

The tools need `ctx.terminals` — a backend must be mounted — and the system-prompt service for the guidance section. Background sends additionally require the jobs service and its model-facing controller (`@deepseek-ai/dsh-tool-jobs`).

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enableRunInBackground` | `true` | Expose and accept `run_in_background`; `false` removes the schema field and rejects the argument |
| `maxResultBytes` | `262144` | UTF-8 cap (minimum `64`) for each complete terminal result after wait, session, pagination, truncation, and job-status metadata |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-terminal) and [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-terminal) are the exhaustive sources for config fields and schemas.

### Background sends

`terminal_send(run_in_background: true)` returns a job id immediately instead of waiting. The job is collected with `job_output`, which waits and reads incremental output, and stopped with `job_kill`, which delivers a real `SIGINT` to the foreground process group. Background mode fails before writing input when the jobs surface is absent.

### Observable outcomes and failures

A foreground send returns the terminal's new output plus `wait: <reason>` and the session status; `session_exit` means the top-level shell exited, while `inferred_idle` or `timeout` never proves the foreground command exited. Opening a session with an unregistered backend type fails. Results larger than `maxResultBytes` are truncated at a UTF-8 boundary with a marker.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the tools and points at the code that realizes it; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The package is a thin adapter: the six tools forward to `ctx.terminals` with the executing agent as the owner, and the presentation layer renders bounded results. Background sends register the in-flight operation on `ctx.jobs` so the generic job surface owns waiting, incremental reads, and `SIGINT` delivery.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Six tool definitions, schemas, guidance section, background-job integration |
| [`src/render.ts`](src/render.ts) | Result rendering and the complete-result UTF-8 cap |

### Result bounding

Every terminal-owned single-text result is capped by `maxResultBytes` after normalized tool or pipeline errors, policy denials and short-circuits, replacements and blocks, and generic job-status text; cuts preserve UTF-8 boundaries and reserve room for a truncation marker. Structured multi-block policy results retain their shape. The minimum cap of 64 bytes keeps every registry-issued session or job id visible in its creation acknowledgement.

### UI render intents

Foreground sends use terminal call and result cards; background sends and the other five tools use generic `execute`, `read`, or `delete` cards. None of the tools emits source locations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the generated schemas to the service contract, the backend, and the background-job surface.

- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-terminal) — the six generated schemas and result shapes.
- [Terminal subsystem reference](../../../docs/subsystems/terminal.md) — the service contract and shared types behind the tools.
- [terminal service](../terminal/README.md) — session operations, owner fencing, and cleanup semantics.
- [terminal-bash backend](../terminal-bash/README.md) — the shipped shell backend that provides sessions.
- [jobs package map](../../jobs/README.md) — the background-job surface that collects and kills background sends.
- [Persistent PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the capability design and deferred boundaries.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The plugin contributes this fixed guidance section:

##### Terminal guidance

```markdown
Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.
```

#### Token effect

Small fixed input cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the registration scope and guidance text are unchanged.

### Tool schemas

#### What the model sees

The six generated schemas are listed in the [`dsh-tool-terminal` catalog section](../../../docs/tool-catalog.md#deepseek-aidsh-tool-terminal). Their fixed schema tokens are present whenever this plugin is active; agent-scoped tool filtering may hide them.

#### Token effect

Fixed schema cost on requests where the tools are visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results and task context

#### What the model sees

Spawn returns the id and bounded startup output. Send and read return bounded terminal text plus readiness and history markers. Background mode returns a generic job id. Every terminal-owned single-text result is capped by `maxResultBytes`; results remain in session history until compaction, and incremental task reads do not repeat consumed output.

#### Token effect

Terminal-owned results are data-dependent and bounded by `maxResultBytes`; each returned result stays in history until compaction.

#### KV Cache effect

Append-only; new results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the model-facing surface that is absent. They are current package constraints, not a task backlog.

- **No TUI or key-sequence surface** — named key sequences, full-screen TUI interaction, BEL, resize, and auto-start are not exposed in any schema.
- **Background mode requires the jobs surface** — `run_in_background` needs both `@deepseek-ai/dsh-jobs` and its model-facing controller (`@deepseek-ai/dsh-tool-jobs`); without them the argument is rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This stateless adapter contributes tools and prompt guidance, while PTY lifecycle and background-job relationships remain owned by the services it composes.
