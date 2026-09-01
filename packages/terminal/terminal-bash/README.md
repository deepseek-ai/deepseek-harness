---
description: "The shipped shell backend for persistent terminal sessions: interactive bash or pwsh under the shared sandbox policy, with readiness detection and bounded line-oriented output."
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal-bash

English | [中文](README.zh.md)

## Summary

`dsh-terminal-bash` starts a persistent interactive shell under the deployment's sandbox policy: the session stays alive across tool calls, readiness for input is detected, and bounded line-oriented output is retained for reads. It provides the `shell` backend type and supports bash on POSIX and pwsh on Windows through a `shellDialect` setting. The same backend composes with local or remote execution worlds through the mounted subprocess provider. Full-screen terminal applications are outside its line-oriented contract.

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

Mount this backend when a composition needs persistent shell sessions — state such as cwd, exported variables, functions, or running interactive children must survive across tool calls. It is the default `shell` type: a composition that mounts `@deepseek-ai/dsh-terminal` without it has no sessions to open.

### When to choose it

Choose this backend when work needs an interactive shell or REPL whose state persists: stepping a debugger, exploring in a Python or Node REPL, or returning to a shell after interrupting a foreground command. Choose the one-shot bash tool for bounded commands that should start and end in one call. The bash dialect targets POSIX; the pwsh dialect targets Windows hosts where `dsh-pwsh-local` can resolve a pwsh executable.

### Composition

Mount the terminal service, a subprocess provider, the sandbox and policy services, this backend, and a tool package:

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-sandbox-local'
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-terminal'
```

`danger-full-access` starts the shell directly. Confined modes require a same-world `ctx.sandbox` provider: without one, the spawn fails before the shell starts.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Backend type registered on `ctx.terminals` |
| `shellDialect` | `bash` | Interactive shell stack: `bash` or `pwsh` |
| `shellPath` / `shellArgs` | per dialect | Shell executable and arguments; empty selects the dialect defaults |
| `maxReadBytes` | `262144` | Maximum UTF-8 bytes returned by one read or settled send |
| `timeoutMs` | `30000` | Absolute bound on one send wait |
| `disposeGraceMs` | `3000` | Grace before teardown escalates to `SIGKILL` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-terminal-bash) is the exhaustive source for every field, including the readiness timings (`pollIntervalMs`, `exactProbeAfterMs`, `idleSilenceMs`, `handoffGraceMs`), terminal size (`rows`, `cols`), and scrollback bounds (`scrollbackLines`, `scrollbackMaxBytes`).

### Shell dialects and readiness

Both dialects expose the same readiness contract, so consumers are dialect-agnostic. A send settles when the shell is ready again: after the controlled prompt is verified, after the foreground process group provably waits on stdin (Linux), after output silence (`inferred_idle`), or at the absolute `timeoutMs`. An `inferred_idle` or `timeout` result does not prove the foreground command exited.

### Sandboxing and safe operation

The shell runs under the effective sandbox boundary for its whole life. Changing the effective sandbox mode is rejected while the owner still has open sessions or a spawn in progress — wait for creation to settle and close the sessions first, so a terminal opened with wider access cannot survive a downgrade. The backend supplies only terminal-specific environment overrides; the subprocess provider applies its shared credential scrub.

### Observable outcomes and failures

An open returns the session id and a bounded startup message. Sends settle with one of the four wait reasons and a session status; `session_exit` means the top-level shell exited. Setup failures reject the open: a missing sandbox provider in a confined mode, a shell that exits during startup, a shell that fails to reach readiness before the startup timeout, or caller cancellation. Cleanup failures reject the close instead of claiming success.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the backend and points at the code that realizes it; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One backend serves both dialects: bash and pwsh share the same session machinery — sanitizer, bounded buffers, readiness polling, cancellation, and teardown — and differ only in argv, environment, and prompt installation. Bash receives a private marker through `PS1` plus `PROMPT_COMMAND`. Pwsh writes a prompt function, pins UTF-8 console encoding, and publishes startup only after the backend reports `stdin_read`; echoed setup text cannot publish the shell. A zero-scrollback `@xterm/headless` instance consumes raw PTY data and returns terminal-protocol replies through the same handle, while the line sanitizer remains the only output projection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Backend registration, sandbox-mode fence, argv and environment assembly, startup sequence |
| [`src/config.ts`](src/config.ts) | Dialect resolution, defaults, and validation of every timing field |
| [`src/session.ts`](src/session.ts) | `LocalPtySession`: send lifecycle, readiness polling, scrollback, signals, close |
| [`src/sanitize.ts`](src/sanitize.ts) | Streaming control-sequence sanitizer and line normalization |

### Readiness model

Three bounded tiers settle a send: exact stdin-wait evidence from the subprocess provider (Linux only), the verified private prompt marker with an exact printable tail, and output silence (`inferred_idle`); an absolute timeout always bounds the wait. Pwsh startup uses one deadline across its complete setup loop, so an `inferred_idle` follow-up does not restart the bound. Evidence collected before the provider write is discarded at the write boundary, a stdin wait that predates the write is not post-write readiness, and unknown foreground state is never a positive exact-idle signal.

### Send cancellation and teardown

Cancellation marks queued input as canceled, then signals the current foreground process group with a real `SIGINT` after any in-flight provider write settles; it never emulates interruption by writing `\x03`. Closing stops readiness polling, terminates the provider-owned process tree, awaits quiescence, and settles the active send as `session_exit`.

### Sandbox-mode fence

A write that would change the effective sandbox mode is rejected before the `sandbox/mode` event commits while that owner has an open session or a spawn in progress. The fence is attached to the exact owner and outlives a provider reload that retains existing sessions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared terminal model to the service, the tools, and the execution-world substrate.

- [Terminal subsystem reference](../../../docs/subsystems/terminal.md) — the service contract this backend implements and the generated `ctx.terminals` surface.
- [terminal service](../terminal/README.md) — backend registration, owner fencing, and cleanup semantics.
- [tool-terminal tools](../tool-terminal/README.md) — the model-facing tools that operate sessions.
- [Subprocess seam](../../../docs/subsystems/subprocess.md) — the terminal primitive that owns PTY allocation and process-tree cleanup.
- [Persistent PTY Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the capability design and deferred boundaries.
- [Persistent pwsh Agent Note](../../../.agents/notes/implemented/architecture/2026-08-11-pwsh-persistent-pty.md) — the Windows substrate and the pwsh dialect.

-----

<a id="model-experience"></a>
## Model Experience

### Indirect consumer

#### What the model sees

This package registers no prompt or tool. Through `@deepseek-ai/dsh-tool-terminal` or another PTY consumer, the model may receive bounded startup output, send deltas, scrollback pages, readiness reasons, and cleanup errors.

#### Token effect

Retained PTY scrollback is not placed in model history until a consumer returns bounded output.

#### KV Cache effect

No direct invalidation; consumer results remain append-only.

### Sandbox policy context

#### What the model sees

While this backend is composed, the `sandbox-policy` owner contributes the capability-neutral `sandbox:policy` runtime-context clause to prompts.

#### Token effect

The policy clause is present on requests while the backend is mounted.

#### KV Cache effect

A standing-policy change appends a superseding runtime-context snapshot after retained history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the backend is a poor fit or needs special operational care. They are current package constraints, not a general shell comparison or a task backlog.

- **Line-oriented output only** — a headless xterm maintains control-sequence state only for terminal-protocol replies. Returned output remains normalized to lines, and full-screen alternate-buffer interaction is unsupported.
- **Readiness is heuristic without an exact tier** — exact stdin-wait detection depends on the mounted subprocess provider; providers that cannot prove it (macOS, Windows) settle on prompt-marker and silence/timeout readiness.
- **pwsh bootstrap in a constrained sandbox** — the prompt function and UTF-8 pin write through `[Console]::`, which the Windows ACL sandbox's read-only mode may deny. When that prevents marker readiness, startup rejects at `timeoutMs` instead of publishing an incomplete shell.
- **Cleanup guarantees belong to the provider** — process-tree teardown is the `SubprocessTerminalHandle` contract, not this backend's.
- **Sessions do not survive process exit** — a harness restart destroys every session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Readiness, terminal buffers, and process-tree state are private per-session implementation state, and the backend publishes no independent lifecycle stream or snapshot.
