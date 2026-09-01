---
description: "Persistent terminal sessions for deployments and consumers choosing, composing, or extending the owner-scoped ctx.terminals service."
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal

English | [中文](README.zh.md)

## Summary

`dsh-terminal` provides persistent, owner-scoped terminal sessions to the harness: a session keeps shell or REPL state across tool calls, and every operation is fenced to the exact agent that created it. It provides the `ctx.terminals` service, which mints opaque session ids, routes session creation through registered backends, and waits for quiescent cleanup when an owner or the service disposes. It defines no terminal mechanics itself: backends such as the shipped `dsh-terminal-bash` own spawning and readiness, and the model-facing tools in `dsh-tool-terminal` own presentation. Sessions are process-local: they do not survive a harness restart.

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

Mount `@deepseek-ai/dsh-terminal` whenever a composition needs terminal sessions whose state survives across tool calls. The service alone does nothing useful: pair it with a backend such as `@deepseek-ai/dsh-terminal-bash` and a tool package such as `@deepseek-ai/dsh-tool-terminal`, and load all three in one composition.

### When to choose it

Choose persistent terminals for work whose state lives in the terminal rather than a file: stepping a debugger, exploring in a Python or Node REPL, or returning to a shell after interrupting its foreground command. Choose the one-shot bash, read, write, and edit tools for bounded operations — they keep stronger validation, approval, output-bound, and replay contracts. Sessions are process-local: they disappear when the harness process exits, so durable work belongs in files or another persistent system.

### Composition

Load the session service together with a backend and a tool package:

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

A backend provides one stable type — the shipped shell backend provides `shell` — and the tools open sessions by that type. The shell backend additionally requires the sandbox, sandbox-policy, and subprocess providers; see its [README](../terminal-bash/README.md) for the full composition.

### What sessions give you

Once a session exists, consumers can open a session and receive its id and bounded startup output, send text (optionally submitting Enter) and wait until the shell is ready again or the send times out, read bounded retained output, deliver one allowed signal to the foreground process group, close a session and wait for its process tree to end, and list the sessions a caller owns. Exactly one send can be active per session at a time; a second send fails until the first settles.

### Ownership and isolation

Every session is owned by the exact agent that opened it. Operations that name a session are rejected when the caller is not that agent, so the model cannot reach another agent's terminal even if it learns the id. An optional session `name` is owner-local display metadata — labels such as `main` or `gdb` — and is unique only within its owner.

### Observable outcomes and failures

A successful open returns the session id, type, pid when the backend has one, status, and a bounded startup message. Sends settle with a wait reason: `stdin_read` (the shell is waiting for input), `inferred_idle` (output silence), `timeout`, or `session_exit` (the top-level shell exited). Failures carry stable machine-routable codes: a missing backend type (`NO_BACKEND`), an unknown session (`NO_SESSION`), another agent's session (`FOREIGN_SESSION`), a second concurrent send (`SEND_ACTIVE`), or an owner that is no longer live (`OWNER_NOT_LIVE`). Backend setup failures reject the open before anything is published, and a failed cleanup rejects the close rather than claiming success.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the service and points at the code that realizes it; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The service owns everything except terminal mechanics: session identity, publication, authorization, and cleanup. Backends own how a session starts, detects readiness, retains output, and shuts down; the service publishes a session only after backend setup succeeds. The split keeps one registry usable with different terminal substrates.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `TerminalSessionService`: backend registry, spawn/send/read/signal/kill/list, owner cleanups, disposal |
| [`src/types.ts`](src/types.ts) | Shared contracts: backend interface, session types, wait reasons, signal set, error codes |
| — | No runtime invariant companion is published; backend and owner-scoped session registries are private mutable state, and the service exposes neither an independent lifecycle stream nor an unscoped snapshot. |

### Data model and lifecycle

Each published session is a record of its id, owner, optional name, backend type, and backend session, plus the one active send. Unpublished spawns are tracked per owner as reservations with a service-owned abort signal. Disposal aborts pending spawns, awaits their settlement and rollback, then closes every owned session and awaits quiescence before running owner detachers; a cleanup failure rejects the lifecycle instead of claiming success.

### Ownership and cleanup rules

- Fencing uses the exact `Agent` object: `hasOwnerActivity(owner)` spans unpublished setup through final close with no publication gap, so lifecycle policy can fence the owner precisely.
- A backend that cannot clean partial startup resources rejects with `TerminalBackendCleanupError`; the service retains that failure as tracked owner activity until owner or service disposal consumes and reports it.
- Caller cancellation keeps its exact `AbortSignal.reason`; `kill()` and disposal resolve only after the backend's captured process tree is quiescent.

### Send reservation

The service reserves a session synchronously for one active send before returning the operation, including before a background job id becomes visible; a second send fails with `SEND_ACTIVE`, so output and cancellation never cross operation ownership.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared terminal model to the shipped backend, the tools, and the design evidence.

- [Terminal subsystem reference](../../../docs/subsystems/terminal.md) — shared types, backend and session contracts, and the generated `ctx.terminals` surface.
- [terminal/ package map](../README.md) — the three-package family and how it composes.
- [terminal-bash backend](../terminal-bash/README.md) — the shipped shell backend that provides the `shell` type.
- [tool-terminal tools](../tool-terminal/README.md) — the six model-facing tools that operate sessions.
- [Persistent PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — design rationale, alternatives, and deferred boundaries.

-----

<a id="model-experience"></a>
## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt or tool; `@deepseek-ai/dsh-tool-terminal` owns visible schemas and result text.

#### Token effect

None directly. Live session state stays process-local until a consumer returns a bounded result.

#### KV Cache effect

No direct invalidation; `@deepseek-ai/dsh-tool-terminal` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the service is a poor fit. They are current package constraints, not a task backlog.

- **Process-local sessions** — sessions and raw scrollback live only in this process and do not survive a harness restart; durable work must be committed to files or another persistent system.
- **No cross-agent sharing** — sessions are intentionally single-owner, with no path to share or transfer a session.
- **No declarative auto-start** — sessions are created only during agent tool calls.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative: shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Undecided directions

- A shared-session design would need a separate authority contract.
- A declarative auto-start feature would compose through unpublished agent setup.

</details>
