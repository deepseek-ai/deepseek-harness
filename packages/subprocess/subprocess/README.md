---
description: "The subprocess service (ctx.subprocess) for composition authors and capability consumers starting, observing, and terminating managed child processes and terminal sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess

English | [中文](README.zh.md)

## Summary

Any composition that runs child processes can start a fully specified child process or a real terminal session through `ctx.subprocess`, receive a live handle with streams and exit facts, and terminate the whole process tree on demand. The service provides executable lookup, the shared environment scrub, and bounded output capture, while every default — argv, deadlines, shell semantics — stays explicit on the request, so the consuming capability seams decide what a process means. A composition mounts one provider implementation (such as `dsh-subprocess-local`) that registers the service; the seam package itself is an abstract contract, not a loadable plugin. Nothing here reaches a model directly: process output and lifecycle are rendered by the consuming tools.

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

Mount a subprocess provider in any composition that must run child processes, and call `ctx.subprocess` from the capability that owns the command. The common path is explicit: resolve the executable, spawn with a fully specified request, read the output you asked for, and terminate the tree when the work is done.

### Mounting the service

One provider registers `ctx.subprocess` per composition; load it beside the consumers that spawn through it — the bash executors, the LSP host, the PTY shell backend, or an out-of-process subagent backend. Loading a second provider fails loudly (one service per context, cordis standard).

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-bash-local'
```

### Starting a managed process

The request is fully explicit: the program and arguments, the working directory, one stdio disposition per stream, a termination grace, an optional abort signal, and optional environment overrides. `done` resolves with exit facts (`exitCode` and `signal`) when the process closes and rejects only for spawn-level failures; collected output stays readable after exit.

```text
const executable = await ctx.subprocess.resolveExecutable('bash')
const handle = ctx.subprocess.spawn({
  argv: [executable, '-c', 'echo hello'],
  cwd: '/workspace',
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: 'inherit' },
  graceMs: 5000,
})
const { exitCode, signal } = await handle.done
const output = handle.collected.stdout?.readFrom(0)
```

### Choosing how output is delivered

- `'pipe'` hands you the raw stream for your own protocol framing — JSON-RPC for the LSP host, ndjson for the ACP backend.
- `'inherit'` lets the child write to the parent's own stream, for pass-through diagnostics.
- A collect object buffers a bounded in-memory tail; add a `spill` cap and the complete stream is also recoverable from a spill file.

Reads are offset-based and non-consuming: a background reader and a final batch read can share one stream without stealing each other's bytes.

### Managing process lifetime

Termination is tree-scoped everywhere: `terminate()` escalates SIGTERM → grace → SIGKILL (Windows force-terminates immediately), is idempotent, and is a no-op once the tree is gone. The request's abort signal starts the same escalation, so a consumer-owned deadline can cancel a whole tree. `waitForExit()` resolves only when the entire tree has exited, not just the direct child, so a still-running helper is observable before teardown returns. Callers own deadlines and cause classification; the service only reacts.

### Running a terminal session

For interactive programs, `spawnTerminal` allocates a real PTY: write text, read UTF-8 output, inspect and signal the current foreground process group, and await one `terminate()` that settles every session member the provider can still observe. Readiness, scrollback, and prompt policy stay with the PTY consumer.

### Environment every child starts from

Children never inherit the harness's ambient secrets: credential-shaped names and ambient `DSH_*` facts are scrubbed, and the caller's explicit `env` merges after that scrub. A deliberately forwarded credential or a current `DSH_*` deployment fact still reaches the child; an explicit `undefined` tombstone removes an ordinary ambient entry.

### What can go wrong

An executable that cannot be resolved fails loud with a stable error. A spawn that never starts rejects `done`; there is no buffered output for a process that never ran. A daemonized child that leaves its tree or session can outlive termination — provider READMEs document their observability limits. When a transport owns its own spawn (the SDK client, MCP), route around the service and import `scrubbedParentEnv` directly so environment policy stays single-sourced.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The seam is built on one separation: the service owns process coordinates and lifetime; consumers own what a process means and every default that shapes one. That is why the spawn request is fully explicit — no hidden subprocess-service default — and why `SubprocessOutcome` carries exit facts only: callers own deadlines, teardown ladders, and cause classification. The `dsh-shell` request/spec split is the owning template.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `SubprocessRuntime`, `ctx.subprocess` registration, the shared `scrubbedParentEnv` scrub |
| [`src/types.ts`](src/types.ts) | Vocabulary: spawn spec, stdio modes, handles, readers, outcomes, `DSH_*` namespace |
| — | No runtime invariant companion is published; this stateless Service Definition owns spawn-spec/handle types, while Service Providers own observations. |

### Data model and flow

A spawn returns a live handle immediately; the request's abort signal drives the same termination escalation as `terminate()`. Collected readers are cursor-free: offsets are whole-stream byte coordinates the caller owns, so independent readers cannot consume one another's output, and a read whose offset slid out of the in-memory tail is `lossy` and points at the spill file when one exists. `spawnTerminal` is one deep primitive because ordinary pipes cannot allocate a controlling terminal or clean terminal-session members.

### Lifecycle and invariants

One implementation registers per context; loading a second throws (cordis standard). Disposal of the service terminates every still-running managed process and awaits its exit, so process lifetime survives consumer reloads. `argv` is never shell-interpreted; a consumer that wants a shell passes `['bash', '-c', command]` itself. Terminal allocation cancellation (the spec signal) is separate from the published handle's lifetime.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the exhaustive type reference to the providers and the decision evidence behind the seam.

- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — spawn specs, output readers, outcomes, and the `DSH_*` environment in full.
- [dsh-subprocess-local](../subprocess-local/README.md) — the local host provider that implements this contract.
- [dsh-subprocess-e2b](../../e2b/subprocess-e2b/README.md) — the remote E2B provider for the same seam.
- [dsh-bash-local](../../shell/bash-local/README.md) — the largest consumer: bash commands over this service.
- [Subprocess seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md) — why the process half became its own seam and what moved with it.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumer seams such as the bash executor family, which own all model-facing rendering of process output and lifecycle.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or leaves work to its consumers. They are current package constraints, not a comparison or a backlog.

- **SDK-managed spawns remain outside** — a transport that owns its internal spawn (the SDK client, MCP) cannot route that call through this service; it can still import `scrubbedParentEnv` so environment policy stays single-sourced.
- **Teardown ladders are consumer-owned** — the seam ships signalling verbs and the whole-tree wait, not a canned quiesce sequence; each out-of-process consumer encodes its child's cooperation shape itself (the ACP backend's stdin-EOF-first ladder is the in-repo template).
- **Observability is provider-specific** — a daemonized child that leaves its tree or session can outlive termination; providers document their substrate limits, and the seam adds no continuous process-table monitor.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

Future: non-shell runners. The seam was split so a direct-argv executor or worker supervisor could consume it without reaching into bash internals; none is shipped yet, and the terminal primitive keeps readiness policy in its consumer.

</details>
