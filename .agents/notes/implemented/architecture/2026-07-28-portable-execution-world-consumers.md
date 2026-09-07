# Agent Note: Portable consumers over filesystem and subprocess execution worlds

Status: implemented

English | [中文](2026-07-28-portable-execution-world-consumers.zh.md)

## Problem

The filesystem and subprocess seams made file and ordinary process access replaceable, but PTY and LSP still reached host Node APIs directly. A remote execution provider therefore appeared to need separate PTY and LSP packages even though their domain behavior did not change. Those packages would be shallow adapters: each would duplicate an existing consumer merely to replace its file and process operations.

A remote coding world is useful only when file operations, commands, terminals, and language servers share one sandbox identity. Moving the complete harness into that sandbox would also entangle provider experimentation with plugin loading, credentials, model transport, session durability, supervision, and deployment.

Ordinary pipes do not cover one requirement. A persistent terminal needs PTY allocation, foreground-process-group inspection and signalling, and cleanup of the complete terminal session. Pretending those operations can be rebuilt in `dsh-terminal-bash` from an ordinary `spawn()` handle would either leak provider internals or weaken its lifecycle contract.

## Decision

`ctx.fs` and `ctx.subprocess` together define one execution world. Providers mounted together must describe the same path namespace, executables, processes, and terminal sessions; higher capabilities consume those two interfaces rather than name the provider.

The filesystem interface owns the path facts that another capability needs without exposing its opaque target identity: a canonical process path, canonical `file:` URI, and containment. Existing whole and streaming text operations remain filesystem-owned; protocol consumers enforce their own retention limits while consuming the stream.

The subprocess interface owns executable lookup and process primitives: ordinary raw or collected process spawning and `spawnTerminal()`. An ordinary handle keeps target identity private: `.done` reports the direct target, while `terminate()` and `waitForExit()` control and observe the same provider-managed range. The [native-containment decision](2026-08-28-subprocess-native-containment.md) owns local Linux scopes, Windows Jobs, and their disclosed fallbacks. The terminal operation is one deep primitive whose handle owns text I/O, foreground groups, signalling, and one awaited TERM-to-KILL operation that settles in-flight handle calls and reaches quiescence for every member of its provider-owned range; an observational fallback limits that range to identities it can still observe. Its signal cancels allocation only; the published handle owns its lifetime. Prompt detection, idle inference, scrollback, sandbox policy, and owner lifecycle remain in the PTY consumer.

Generic consumers use that execution world:

- `dsh-bash-local` continues to map Bash semantics onto ordinary `ctx.subprocess.spawn()`.
- `dsh-lsp-stdio` reads and contains source through `ctx.fs`, resolves and launches language servers through `ctx.subprocess`, and carries provider-owned file URIs through initialization and result rendering. One provider-lifetime signal aborts filesystem and protocol work during disposal, including workspace lookup before queue ownership; its JSON-RPC, pooling, synchronization, and normalization stay unchanged.
- `dsh-terminal-bash` maps persistent-shell semantics onto `ctx.subprocess.spawnTerminal()`. The local `node-pty` and process-inspection implementation moves into `dsh-subprocess-local`; another subprocess provider supplies the same primitive. `danger-full-access` needs no `ctx.sandbox`; a confined mode requires a same-world sandbox provider and fails before spawn when none is mounted. Prompt and silence evidence collected during asynchronous pre-write inspection is discarded when the provider write begins. Cancellation retains the send reservation while an in-flight write settles and then signals the foreground group, so late bytes or the signal cannot target a successor; an in-flight readiness poll cannot release that reservation, and a rejected write sends no signal. The absolute deadline remains armed throughout cancellation. A signal failure becomes terminal transport failure. Completion of a stale inspection resumes polling for the current send. Startup cancellation begins terminal rollback without waiting for a stalled readiness or signalling call. Close rejects new public signals and delegates provider-managed session quiescence to the handle's awaited termination operation.

## E2B POC boundary

The opt-in E2B realization has exactly three provider-specific packages under `packages/e2b/`: `dsh-e2b` creates one sandbox and deletes it on timeout or disposal, `dsh-fs-e2b` implements `ctx.fs`, and `dsh-subprocess-e2b` implements `ctx.subprocess` over E2B Commands, PTYs, and remote Linux process groups. The two adapters obtain the sole SDK handle from the owner and never create private sandboxes.

E2B owns the mutable filesystem, managed command and Bash processes, terminal allocation and terminal-session groups, language-server processes and source reads, and adapter-private files under `.dsh-e2b`. The host owns Cordis and plugin objects, the agent loop, agent/session/goal state, session logs and persistence, LLM calls, prompts and tools, authority, skills, subagent orchestration, PTY buffers and readiness, LSP protocol state, and E2B SDK/network buffers. The overlay neither uploads nor synchronizes the host workspace.

The adapters retain only substrate mechanics. Filesystem canonicalization crosses the SDK's decoded command transport as strict base64-encoded NUL framing; streamed reads leave byte ceilings with consumers. Subprocess command output and environment snapshots use ASCII/base64 where SDK chunk decoding would otherwise lose bytes, while private control shells isolate profiles and later launches blank discovered credential-shaped names. Process and terminal cleanup uses remote groups and proves quiescence before settlement.

Sandbox state is deliberately ephemeral: timeout and disposal delete the remote files and unmanaged state. The POC adds no reconnect or pause/leave retention, session-persistence backend, template builder, volume, snapshot, network-policy layer, sandbox catalog, workspace synchronization, durable remote handles, or whole-harness execution.

## Verification

Focused package suites pin sandbox lifecycle, canonical path framing, filesystem metadata and atomic versions, subprocess publication/rollback, terminal text I/O and session cleanup, output limits, cancellation, disposal, and invariant registration. A credential-gated Loader composition exercises the same three-package provider through source imports and built exports, including FS/Bash visibility, hostile login profiles, byte-split UTF-8 output, process and terminal cleanup, LSP queries, host-workspace isolation, and final sandbox deletion.

## Alternatives considered

**Keep one PTY and LSP package per remote provider.** Rejected because provider mechanics would be repeated above the existing seams. The deletion test exposes the problem: deleting those adapters should not scatter domain behavior into the remote provider; the generic consumers already own it.

**Create a separate sandbox per capability or tool.** Rejected because file and process operations would not share identity or state, defeating the coding use case and multiplying lifecycle owners.

**Model a terminal as an ordinary piped subprocess.** Rejected because pipes cannot allocate a controlling terminal, resolve the current foreground process group, or prove complete terminal-session cleanup. One terminal primitive is smaller and more honest than exposing substrate-specific escape hatches.

**Move PTY readiness and session policy into the subprocess service.** Rejected because those are persistent-terminal consumer semantics, not OS process mechanics. A subprocess provider owns what only its substrate can do; `dsh-terminal-bash` owns what a Harness terminal means.

**Expose separate terminal termination and quiescence operations plus a shared lifecycle controller.** Rejected because every terminal consumer needs the same single cleanup outcome. Separate operations export provider bookkeeping, bounded-observer, and retry semantics without a production consumer; one awaited provider operation is a deeper interface.

**Add a stable bounded-read primitive to the filesystem seam.** Rejected because only LSP needs a complete-document byte ceiling, which it can enforce while consuming the existing text stream. A second primitive forces every provider to implement stable-handle and no-follow mechanics, including a remote helper protocol, without an observed concurrent-replacement defect.

**Run the whole harness inside the remote environment.** Rejected as a different deployment model. Making execution capabilities portable does not move model calls, session state, plugin state, or the agent loop.

**Put every provider operation in one shared owner package.** Rejected because sandbox identity and lifecycle are the owner's only concerns. Filesystem and subprocess retain distinct contracts, tests, and consumers without turning the owner into a capability grab bag.

**Implement remote filesystem operations only through shell commands.** Rejected because that discards structured filesystem identity, errors, streaming, version guards, and atomic mutation semantics already consumed by the file tools.

**Add a generic distributed-runtime abstraction or reconnect live handles.** Rejected because the existing capability seams carry the demonstrated contracts, while remote identity alone cannot reconstruct callbacks, pending promises, authority, protocol state, or output cursors. A new layer would speculate about persistence and synchronization beyond the POC.

## Consequences

A remote execution provider implements only its shared sandbox owner plus filesystem and subprocess adapters. Bash, PTY, and LSP compose above them, so fixes to those capabilities remain provider-neutral.

The fundamental interfaces are wider, and a filesystem/subprocess pair must agree on one execution world. The added operations are limited to facts and lifecycle mechanics that current generic consumers require; model schemas, protocol framing, readiness policy, and presentation do not leak into the providers.

The local implementation absorbs `node-pty` and platform process inspection because it owns local terminal mechanics. On supported Linux hosts, the user-systemd scope retains descendants that call `setsid` or reparent, while process inspection continues to own foreground attribution and synchronous fallback evidence. Other hosts use the observational teardown: disposal sweeps descendants before and after terminating the top-level shell, waits for exact PID-identity-fenced descendants retained during foreground inspection, and retains Linux session members that survive top-level exit. macOS cannot enumerate a POSIX session after its leader exits, so a child that reparents between inspection snapshots remains an explicit local-provider limitation rather than a reason to move process mechanics back into the PTY consumer.

The E2B composition demonstrates that a shared sandbox owner plus filesystem and subprocess adapters are sufficient to move the mutable coding world off-host while leaving higher capabilities provider-neutral. Its POC limits remain explicit: the SDK retains complete command transport in host memory, remote startup cannot publish a PID synchronously, exact terminal stdin-wait and independent signal facts are unavailable, numeric PID/PGID operations are not identity-fenced, the initial environment probe cannot hide unknown sandbox-default secrets from already-running same-UID processes, and adapter artifacts remain until sandbox deletion. These are provider constraints, not justification for compatibility shims or more E2B packages.
