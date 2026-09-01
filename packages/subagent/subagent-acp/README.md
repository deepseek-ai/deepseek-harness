---
description: "The out-of-process ACP subagent backend for users and maintainers choosing a delegation provider, configuring a child ACP agent command, or debugging remote child runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-acp

English | [中文](README.zh.md)

## Summary

`dsh-subagent-acp` runs each delegated child in a fresh subprocess and drives it as an Agent Client Protocol client: the child gets its own runtime, session, model configuration, and tools, and it can be any ACP-compatible agent, not just Harness. It is the out-of-process alternative to the in-process spawn and fork backends, sharing only the parent session's working directory with the child. Each run spawns a fresh process, initializes an ACP session, sends the task, and collects the streamed final answer; permission prompts are auto-answered by configuration, so no human is needed. The parent receives only the child's final answer or a safe error — no intermediate messages or tool traffic crosses the boundary. Choose it when the child must be fully isolated from the parent harness and can speak ACP.

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

Mount this provider when a composition needs a fully isolated, out-of-process child that speaks the Agent Client Protocol. The common path is explicit: mount the seam, mount this provider, and give it a command that starts an ACP agent.

### When to choose it

Choose this backend when the child must run with its own runtime, model, and tools in a separate process — for example an ACP agent from another project — or when you want delegation that cannot touch the parent harness. Choose an in-process backend when the child must share the parent's composition or honor parent-enforced capabilities: this provider advertises no optional start-time capabilities, so the seam rejects requests for `agentOptions`, structured output, depth caps, tool filters, or personas rather than silently omitting them.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `acp` | Registry name on `ctx.subagents` |
| `command` | required | Executable spawned for each run (the child ACP agent) |
| `args` | `[]` | Command arguments |
| `cwd` | parent session cwd | Working-directory override for the child process and its ACP session |
| `permission` | `reject` | Auto-answer permission requests by rejecting, or choosing the first `allow_once` or `allow_always` option (`allow`) |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before platform termination |
| `disposeGraceMs` | `3000` | Bound for observing structured process facts after failure and, on POSIX, the SIGTERM-to-SIGKILL grace |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-acp) is the exhaustive source for every accepted field and its JSDoc.

A DeepSeek Harness child uses the product launcher and an explicit absolute `DSH_HOME`. The isolated home prevents a nested runtime from discovering the launching person's profiles or credentials; the generic ACP provider does not impose this requirement on non-DSH agents.

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: dsh
    args: ['--profile', 'acp', '--patch', '/absolute/path/to/acp.patch.yml']
    permission: reject
    env:
      DSH_HOME: /absolute/path/to/isolated-child-home
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

### What you get

A successful run returns the child's final streamed assistant text as the result output. The child's session, model, and tools come from the child process itself — the parent supplies only the task and the working directory. The stop reason maps `end_turn` to `completed`, `max_tokens` to `max-tokens`, `refusal` to `refusal`, `cancelled` to `aborted`, and every other value to `error`. A failed published run preserves partial assistant text in `output` and returns safe structured detail separately in `diagnostic`.

### Failure and recovery

A spawn, initialization, or new-session failure rejects before publication, ordinarily after the child process is reaped. If cleanup also fails, the rejection preserves ordered safe startup and teardown facts without claiming whole-tree quiescence. Non-cancellation errors expose only fixed provider, stage, and category facts; the original failure stays on the internal cause chain and in Host diagnostics. After publication, a prompt, transport, or early-process failure resolves as `error` with a safe diagnostic, while local cancellation resolves as `aborted` without failure detail.

### Safe diagnostics

A generic diagnostic uses one fixed line: `Subagent failure (provider: ACP; stage: <stage>; category: <category>; ...)`. Optional stop reason, exit code, and signal come only from closed protocol or managed-process facts. Stderr, exception text, task content, tool input, paths, environment values, credentials, and protocol payloads never enter the diagnostic; the shared result boundary limits it to 4096 UTF-8 bytes. A non-completed run that requested permission can add one fixed policy, tool-kind, and decision line. Successful runs and local cancellation omit it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the backend drives a child over ACP and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **Full process isolation.** Each child runs in a fresh subprocess with its own session, model, and tools; only the resolved working directory crosses from the parent.
- **One process per run.** Every run spawns a new process; there is no process pooling.
- **The ACP wire is the serialization boundary.** Same-process subagent values are not defensively cloned; the protocol is where hostile input is validated.

### Start and ownership flow

A start resolves the child's working directory (the configured `cwd` override, else the parent session's cwd), spawns the command through the subprocess seam, performs the ACP `initialize` and `newSession` handshake, and only then publishes the run. Fulfillment means a remote session is ready and ownership has transferred to the caller. Disposal is idempotent: it closes stdin and waits a configured grace for cooperative quiescence, then escalates through SIGTERM to SIGKILL and awaits whole-tree exit. Cleanup failures remain observable as ordered safe facts and never claim quiescence.

### Stop-reason mapping

The run outcome maps the ACP terminal into the shared stop-reason vocabulary (`completed`, `max-tokens`, `refusal`, `aborted`, or `error`) in [`src/run.ts`](src/run.ts).

### Process boundary

The child spawns through the subprocess seam: credential-shaped ambient variables are scrubbed, then explicit `config.env` values merge after the scrub. Stderr is inherited to the parent's stream, and disposal applies this provider's EOF window before the shared termination escalation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this backend to the seam it plugs into and the protocol it drives.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Agent Client Protocol automation server](../../acp/acp/README.md) — the automation-only server this provider drives as a client.
- [dsh-subprocess seam](../../subprocess/subprocess/README.md) — the process-spawn and teardown machinery behind each run.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-acp) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The remote child receives the standalone task content through ACP plus its own process's configured system prompt, tools, and fresh session. It receives no parent conversation. This provider advertises no optional start-time capabilities, so the local service rejects requests for `agentOptions`, persona, tool filtering, depth enforcement, or structured output instead of silently omitting them.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each ACP child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final streamed assistant text or that consumer's exact stop-reason error, not intermediate messages or tool traffic. Non-completed results present the safe diagnostic before separately preserved partial assistant output. A request already cancelled before publication becomes exactly `Error: subagent request was aborted before the ACP child started`; another start failure contains only the fixed `Subagent failure (...)` line.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a general ACP comparison or a task backlog.

- **A fresh process per run** — there is no process pooling; each delegation pays the full spawn and ACP handshake cost.
- **Local workspaces only** — the resolved working directory is a local path handed to a child on the same machine; remote workspace mapping is not designed.
- **No optional start-time capabilities** — this provider cannot apply `agentOptions`, `outputSchema`, a depth cap, a tool filter, or a persona inside the remote process, so the seam rejects requests that require them.
- **Only committed `agent_message_chunk` text is collected** — the automation server keeps reasoning, tool activity, plans, and other trace data in the child session log rather than emitting them on ACP.
- **Permission prompts are auto-answered** (`permission: allow | reject`) — no human is surfaced a child's `session/request_permission`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Process pooling** — persistent-process reuse is a possible future optimization but changes the per-run isolation model.
- **Remote workspaces** — mapping a remote ACP agent's workspace would need its own backend capability.
- **Continuable ACP children** — would require persisting the remote session id and a per-child continuation advertisement.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
