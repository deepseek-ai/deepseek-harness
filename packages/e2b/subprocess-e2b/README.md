---
description: "Shell commands and terminals inside the shared remote sandbox: what the agent can run there, how output is handled, and what to expect — for deployments and maintainers of the E2B family."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-e2b

English | [中文](README.zh.md)

## Summary

`dsh-subprocess-e2b` runs the agent's shell commands and terminals inside the remote sandbox: the agent can execute Bash, open interactive terminals, and read their output exactly as with local execution, while nothing runs on the host machine. Existing command, terminal, and language-server features keep working unchanged — no E2B-specific tools are needed. Secrets and host environment variables never leak into the sandbox: only environment entries the agent explicitly requests are passed along. Use it together with `dsh-e2b` and `dsh-fs-e2b` so commands, terminals, and files share one remote world. The main cost is remote latency — each command starts with a short asynchronous setup instead of launching instantly.

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

Use this package when the agent's shell commands and terminals should run inside the remote sandbox rather than on your machine. It is the command half of the E2B family: commands, terminals, and files share one remote world.

### When to choose it

Choose it when a composition already uses the E2B sandbox and you want commands and terminals to run there. Choose the local subprocess package for host execution.

### Configuration

The only setting is how often the package checks a running command's status; the default suits most deployments, and raising it reduces remote requests at the cost of slightly slower exit detection.

| Field | Default | Meaning |
|---|---|---|
| `pollMs` | `20` | How often the package checks a running command's status, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subprocess-e2b) is the exhaustive source for every accepted field and its JSDoc.

### Running commands

The agent can run a command in the sandbox with a working directory and environment, choose how its output is delivered (streamed live, captured up to a size cap, or routed to the app's own output), and stop it if it hangs — a stop first asks the command to exit politely, then force-kills it after a short grace, so a stuck command cannot leak. Very large output can be saved to a file in the sandbox so the agent can read it later. The command's exit code is reported normally; if the sandbox vanishes while a command runs, the command is treated as ended rather than erroring.

### Using terminals

The agent can open an interactive terminal in the sandbox, send input, read output, and signal programs running in it — prompts, interactive tools, and full-screen programs behave as they do locally. Terminal features like scrollback and readiness detection are provided by the terminal tooling, which works unchanged.

### Keeping the environment clean

Commands run with a clean, sandbox-native environment: host variables and values that look like credentials are not passed in implicitly, and only entries the agent explicitly requests are set. This keeps secrets out of the sandbox.

### If the sandbox disappears

The sandbox is ephemeral: if it is deleted while commands or terminals are running — through expiry, shutdown, or removal elsewhere — the affected commands are treated as ended cleanly. Do not rely on work surviving the sandbox.

The default sandbox image ships with the runtime and utilities command work needs: `node`, `bash`, `setsid`, `ps`, `awk`, `tr`, `env`, `base64`, `chmod`, `tee`, `head`, `rm`, `kill`, `id`, and `getent`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Provider-private remote identity.** The synchronous seam never blocks on the network. Private wrapper files asynchronously publish a process-group identity for stdin, observation, termination, and quiescence checks, together with the direct exit code and spill validity; that identity is not the requested target PID.
- **One teardown ladder.** Termination, rollback, and disposal share one process-group signal path — `SIGTERM`, then `SIGKILL` plus the SDK kill fallback — and treat proven quiescence as final.
- **Environment is explicit.** Nothing from the host and nothing credential-shaped enters the sandbox implicitly; every ambient value is scrubbed and every `spec.env` entry is an explicit opt-in.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `E2BSubprocessRuntime`, `Config`, spawn and spawnTerminal, disposal |
| [`src/process.ts`](src/process.ts) | `E2BSubprocessHandle`: remote wrapper, publication, termination, output projection |
| [`src/terminal.ts`](src/terminal.ts) | `E2BTerminalHandle`: PTY allocation, session teardown |
| [`src/environment.ts`](src/environment.ts) | Remote environment probe, scrubbing, serialization |
| [`src/output.ts`](src/output.ts) | Base64 decoder and bounded output readers |
| [`src/remote.ts`](src/remote.ts) | Shared control-shell helpers: option shaping, poll ticks, group signalling |
| — | No runtime invariant companion is published; live remote handles are private teardown ownership, and the E2B command event stream is the sole outcome authority. |

### Remote wrapper

The bootstrap resolves its own tools from the sandbox PATH, refuses any missing or non-executable path, execs through `env -i` and `setsid --wait`, publishes the process-group id and exit code to private files beneath `ctx.e2b.runtimeRoot/processes`, and redirects stdout and stderr through base64 encoders that emit a reserved completion frame; `tee` and `head -c` bound optional spill files.

### Private process identity and publication

The synchronous seam returns a handle immediately while the command starts asynchronously. The wrapper publishes a private process-group ID for stdin, observation, termination, and quiescence checks, but that ID is not the requested target PID. A startup signal aborts environment and private-state preparation before allocation; once allocation begins, cancellation waits for a provisional SDK handle it can clean.

### Environment boundary

One trusted control-shell probe resolves the sandbox user's login home from its passwd entry and transports the sandbox environment as base64 ASCII for one strict UTF-8 decode; the wrapper then removes ambient `DSH_*` and credential-shaped (`*KEY*`, `*SECRET*`, `*TOKEN*`) names and restores every valid `spec.env` entry as an explicit caller opt-in. Empty names, `=`, and NUL framing violations reject before launch; subsequent command and PTY login shells receive a fresh randomized root-level `HOME` plus empty overrides for every scrubbed ambient name before user profiles can run. Private environment files are removed after consumption.

### Output handling

The remote wrapper branches raw bytes into optional bounded spill files and frames each live chunk as newline-delimited base64 ASCII; the host restores bytes across arbitrary SDK callback boundaries. Pipe mode writes to host Node streams, inherit mode to the harness process streams, and collect mode retains a bounded host tail with offset reads. For collect or inherit output, an incomplete SDK stream is disconnected after `graceMs` with its partial spill withheld; natural raw-pipe completion awaits lossless transport and preserves backpressure. Batch and streaming stdin use the SDK handle.

### Termination ladder

Termination and rollback share one tolerant signal path (`signalRemoteGroups`), escalate `SIGTERM` to `SIGKILL` on grace expiry, use the SDK kill as a fallback, and prove quiescence with a bounded process-table probe before reporting success; zombie-only groups count as empty, and a `SandboxNotFoundError` is treated as quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the family composition to the subprocess seam surface and the consumers that render it.

- [E2B provider family map](../README.md) — the sandbox owner and the three-package composition.
- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — the subprocess seam contract and the generated Cordis surface.
- [Subprocess seam package](../../subprocess/subprocess/README.md) — the abstract contract this provider implements.
- [Bash executor](../../shell/bash-local/README.md) — the consumer that renders spawned commands to the model.
- [PTY terminal backend](../../terminal/terminal-bash/README.md) — the consumer that renders terminal sessions.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subprocess-e2b) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumer seams such as the bash executor family, which render remote output, exit facts, background deltas, and spill paths.

#### KV Cache effect

No direct invalidation: the consumer seams own any request-prefix changes; this backend's transport never reaches a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **The SDK still retains complete command output in host memory** — E2B `CommandHandle.stdout` and `.stderr` accumulate the base64 transport even when this adapter exposes bounded raw-byte tails, so the subprocess seam's normal host-memory bound is not achieved and transport retention is larger than the source stream.
- **Private state lives for the sandbox lifetime** — process directories and valid spill files remain under `.dsh-e2b` until the owner deletes the sandbox; this POC supplies no in-sandbox sweep.
- **Control state shares the sandbox user's UID** — E2B runs every command as the same default user, so `0700`/`0600` modes cannot isolate `.dsh-e2b` control files from concurrently running sandbox processes; real isolation needs an E2B per-command user or an out-of-band control channel.
- **Numeric process identities are not reuse-fenced** — E2B exposes numeric PID/PGID input, signalling, and cleanup operations but no atomic identity-bound alternative; replacement is deferred until E2B adds an identity primitive or a failure demonstrates a narrower protocol.
- **The initial environment probe inherits sandbox defaults** — E2B merges command overrides with default environment entries, so the probe cannot blank unknown credential-shaped names before enumerating them; this POC therefore does not support secrets in sandbox-default environment variables.
- **E2B exposes no signal fact** — an adapter-requested `SIGTERM` or `SIGKILL` is reported only when no wrapper-published direct exit code wins; every unrequested SDK exit remains an exit code, including values equal to `128 + signal`.
- **Exact terminal stdin-wait inspection is unavailable** — E2B exposes the foreground process group but not the syscall evidence needed to prove it is waiting on fd 0, so the generic PTY backend falls back to controlled prompt markers and bounded silence.
- **Linux utility and E2B transport semantics are assumed** — there is no Windows, escaped-session recovery, or network-partition fidelity layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

#### Open: numeric process identities

E2B exposes numeric PID/PGID input, signalling, and cleanup operations without an atomic identity-bound alternative. The adapter minimizes host round trips and defers a replacement until E2B adds an identity primitive or a failure demonstrates a narrower protocol (TODO(e2b-pgid-identity)).

#### Open: replacement environments and status observation

The initial environment probe inherits sandbox defaults because E2B merges command overrides, and collect/inherit command status needs control-plane polling because E2B cannot observe direct-command exit independently of descendant-held output. Both close only with new E2B primitives (TODO(e2b-replace-environment), TODO(e2b-status-watch)).

</details>
