# Agent Note: Execution environment - tool I/O and the original resident-daemon decision

Status: implemented

English | [中文](2026-11-04-environment.zh.md)

## Problem

A tool that needs files or programs on another machine can only run against a Session-wide remote world: the [SSH provider family](../../../../packages/ssh/README.md) replaces `ctx.fs` and `ctx.subprocess` for everything. Each filesystem or process operation then costs one network round trip, so a tool that walks a directory or reads many files pays for every step. A remote environment should also stay small: adding, removing or updating Harness plugins must not require installing anything new on the remote machine.

## Decision

[`dsh-environment`](../../../../packages/experimental/environment/README.md) (`ctx.environments`) splits one tool call into three parts:

1. **Remote I/O**: the tool sends the source text of a self-contained function to the execution daemon, which evaluates it in a fresh `node:vm` context on one of its worker threads, with the remote machine's `fs`, `path`, a shell-free `exec` and basic JavaScript utilities such as timers, `Buffer` and `URL`.
2. **Host state**: the function reaches host handlers supplied with its definition through `env.origin`, an RPC back to the main runtime, or the tool changes state after the call returns.
3. **Formatting**: the tool's `output.render` produces model content on the host.

The daemon has no plugin system and no tool-specific code. Each definition ships its own function, so plugin changes never require a daemon update; the daemon is one bundled file needing only Node. The original resident-process decision used a Unix listener, an exclusive startup lock and one replaceable worker per host connection to permit reconnection after a dropped path or blocked run. That process-lifecycle decision is superseded by [transport process ownership](2026-11-23-environment-transport-process-ownership.md); the function-I/O and origin-callback decisions remain active. Runs in flight when a connection ends fail and are never replayed.

Providers choose opaque, stable handles and user-facing display names. The registry stores metadata separately from transports and uses one execution protocol for all environments; SSH configuration discovery composes the single-SSH provider, while local execution uses a managed process. Origin callbacks belong to the originating dsh and to the connection that owns each run.

### Registry changes carry no payload

The registry emits `environments/change` after each registration and each effective unregistration, once `list()` and the connection cache reflect it. The event carries no handle or kind: a listener may register or remove environments itself, which emits nested events before the outer event reaches later listeners, so consumers re-read `list()` instead of applying deltas that could arrive out of order. SSH configuration discovery follows changes to the files it reads. It removes an allowlisted alias that is no longer declared, because OpenSSH would resolve the undeclared name as a host name, and keeps the previous aliases when a changed configuration cannot be read, because such a state is usually an edit in progress.

### A definition binds everything except the environment and the arguments

`ctx.environments.define(fn, { result, handlers })` fixes the function source, its result validation, its origin handlers and their names, and returns a runner that takes an environment handle, arguments, a signal and an optional trust confirmation. [Runner handle selection](2026-11-26-environment-runner-selects-handle.md) supersedes this note's original binding of the handle to the definition. The names are the handlers object's own property names when defining; a name added later is neither exposed nor served, while each origin call looks its handler up on the object when it arrives, so replacing a handler's function needs no new definition. A caller keeps one definition for every later call. Handlers belong to the definition and receive only the parameters the function sends, so a caller whose handlers need host objects of one call defines per call.

`define` reads the origin method names once and hashes the source with them: the hash is the SHA-256 digest of the JSON encoding of `[source, methods]`. The host serves only those names, so the methods the hash covers are the only ones a run can call. A run carries the hash, and carries the definition, its source and method names, only until the connection's daemon has answered a run that carried it; definitions with identical source and handler names in the same order share the entry, while identical source with other handler names, or the same names in another order, is another definition. The daemon verifies each received definition against its hash and keeps it for its connection, and each worker compiles a definition's source once while still evaluating it in a fresh context per run, so caching changes no caller. The cache lives only as long as its connection because every connection starts a fresh daemon. The registry omits a definition once the daemon has answered a run that carried it, with a result or an error: the daemon keeps a verified definition before it runs the function, so only a defect leaves an answered definition unknown, and the daemon refuses a run that names an unknown hash; there is no retry exchange.

### Each run occupies a worker thread

One host connection carries the runs of every Session that uses an environment. A function that blocks its thread, such as a backtracking regular expression or a CPU loop, would otherwise stall every run on that connection, and the host would close the connection and with it the other runs and their `exec` processes. The daemon therefore keeps a pool of worker threads per connection: a run occupies one worker and returns it when the run settles, so the pool grows to the connection's peak concurrency, which `maxPending` bounds, and closing the connection ends every worker. Cancellation aborts the function's `env.signal`; if the function has not stopped within half of `cancelGraceMs`, the daemon terminates its worker and answers the cancellation before the host's deadline, so the connection and its other runs continue. `exec`, its process-group cleanup and origin calls stay on the main thread, which owns every process the connection starts. The daemon is installed as one file, so each worker starts from the source text of one self-contained function.

Values cross between the main thread and a worker as `postMessage` structured clones. That algorithm accepts the values the connection's frames accept but copies a `Buffer` as a `Uint8Array`, so a `Buffer` in arguments, results or origin values arrives as a `Uint8Array`. Errors cross the thread boundary and the connection as their name, message and string code, because structured clone keeps only standard error names and drops `code`.

An exception that no code catches, such as one thrown in a timer callback, fails the run its worker is serving instead of ending the worker and with it a run that may not have caused it. Between runs, the worker reports such an exception on standard error and keeps serving. A run's timers, including those of `AbortSignal.timeout`, end with the run, and its abort listeners run as it ends, so only continuations of a finished run's own pending operations can still run during a later run, and an exception they leave uncaught fails that later run.

### Transports are plugins

The daemon only needs a byte stream. Providers register environment metadata and a transport with `ctx.environments.register(info, transport)`; each `open` returns a channel with its security facts and end reason. The shipped [SSH transport](../../../../packages/experimental/environment-ssh/README.md) runs `daemon.js serve --stdio` directly through OpenSSH; the local transport starts the same entry in a managed Node process. Each new connection starts a fresh daemon, while the registry reuses a live channel and never replays a sent run. Transports own process startup and shutdown; the registry owns the protocol and connection cache. A provider may register several environments, and each run names one contributed handle.

### Trust comes from the transport, and the handshake leaves room for more

Anyone who can connect can run code as the daemon user, so channel access determines who can execute. Every connection starts with `auth`, which negotiates a mechanism and sets the connection's limits. The only mechanism is `transport`: SSH authenticates user and host, with host keys checked strictly and an unknown key, fetched through ssh so proxies apply, trusted only by a pinned fingerprint or a person's confirmation. The local provider owns its child process and pipes. The original socket-permission trust model is superseded by [transport process ownership](2026-11-23-environment-transport-process-ownership.md). There is no network listener. A network transport must authenticate the channel and bind that authentication to it before accepting execution requests.

Requests flow in both directions with cancellation and per-direction `maxPending` slots. A cancelled request keeps its slot until the other peer answers it, so both peers count the same work; a peer that does not answer a cancellation within `cancelGraceMs` loses the connection, and the next run reconnects.

### Values cross as structured clones in split frames

Each frame is a 4-byte length followed by a `node:v8` serialization, so arguments, results and origin values are structured clones. Both peers run supported Node releases, so tools pass file bytes as `Uint8Array` without base64, keep `undefined`, `Date`, `Map` and `bigint`, and type arguments with interfaces, while zod still validates every decoded frame. A message larger than `maxFrameBytes` travels as `part` frames that the receiver reassembles within the negotiated `maxMessageBytes`. Parts of different messages interleave, so a cancellation or small origin call waits for at most one frame of a large transfer, and a cancelled transfer stops sending its remaining parts. Error frames carry the thrown error's name, message and string code, so an errno or `HarnessError` code survives the connection in both directions.

Callers see only the message limit. The registry exposes it as `ctx.environments.limits` because it is one registry-wide value, negotiated identically for every connection, and functions read the same value as `env.limits`.

A peer sends messages as parts only while their sizes together fit `maxMessageBytes`; further ones wait in order, and messages that fit one frame never wait for room. The receiver enforces the same total and requires every part but a message's last to carry at least what a minimum-size frame holds, so reassembly holds at most `maxMessageBytes` per direction in a bounded number of parts. A request cancelled while it waits has sent nothing and frees its slot at once. A receiver stops counting the answer of a request it cancelled, so a sender can return the room of a stopped answer before its error frame arrives.

### Shared peer code

The request peer's cancellation bookkeeping matches the [SSH helper](../../../../packages/ssh/ssh/README.md) peer and carries a `jscpd:ignore` exception. The SSH peer uses JSON payloads in its length-prefixed frames, UUID ids, per-request-class management limits and SSH-specific diagnostics, and does not split messages, so sharing it would move SSH behavior into a generic package or SSH wording into this one. Extract one peer package when a third consumer needs the same request semantics.

## Alternatives considered

- **Remote `ctx.fs` and `ctx.subprocess` only.** Rejected for tool I/O: every primitive is a round trip, and a tool cannot keep a multi-step operation on the remote machine.
- **A subset of the Harness runtime on the remote machine.** Rejected: plugins would need to be installed on the host, the remote machine or both, and the remote runtime would need updating with them.
- **A native daemon with its own plugin interface, restarted on every plugin change.** Rejected: it needs a second plugin system, and restarts would interrupt every remote run.
- **A daemon tied to one SSH session's standard input and output.** Originally rejected because it exits on disconnection and each transport needs a launch path. This rejection is superseded by [transport process ownership](2026-11-23-environment-transport-process-ownership.md), which assigns launch and persistence to transports.
- **Reusing the `dsh-ssh` helper as the transport.** Originally rejected because its connection- or lease-scoped cleanup conflicted with the resident-process decision. [Transport process ownership](2026-11-23-environment-transport-process-ownership.md) supersedes that resident requirement; a `ctx.ssh.connectStream` provider remains an independent transport choice.
- **Refusing a second host connection.** Originally rejected because a lingering or blocked connection could prevent reconnection. The per-connection process model in [transport process ownership](2026-11-23-environment-transport-process-ownership.md) supersedes the shared listener's admission decision.
- **Per-call handlers.** Handlers could close over the host objects of each call. Rejected by the author: callers with per-call host state define per call. The same rejection originally covered per-call handles; [runner handle selection](2026-11-26-environment-runner-selects-handle.md) supersedes that part.
- **Evaluating functions on the daemon's main thread.** Rejected: the `node:vm` `timeout` option bounds only synchronous evaluation, and a blocked main thread stops the protocol and every other run of the connection.
- **A new worker or child process per run.** Rejected: each run would pay thread or process startup, and a child process would add a second process tree to supervise. A pool reuses workers while every run still gets a fresh context.
- **A definition cache that outlives its connection.** Rejected: every connection starts a fresh daemon, so a longer-lived cache would need daemon-side storage and invalidation.
- **Origin method names in every run.** Rejected: `define` fixes the handler names, so they are part of the definition the connection caches; repeating them in each run adds bytes without adding information.
- **Newline-delimited JSON with base64 for bytes.** Rejected: base64 enlarges binary payloads by a third, JSON loses `undefined`, dates and maps, JSON types reject interfaces, and tools would hand-roll codecs and chunking against a frame limit they cannot see.
- **The message limit in `list()` or `EnvironmentInfo`.** Rejected: the limit is registry configuration, identical for every environment, while `EnvironmentInfo` holds provider-contributed metadata.
- **Bounding partially received messages only by pending slots.** Rejected: `maxPending` requests and as many answers of `maxMessageBytes` each reach 8 GiB per direction with the defaults, and a receiver limit below what senders may send would close connections that follow the protocol.
- **Application-level keys over authenticated channels.** Deferred: channel access already permits execution as the daemon user. The original Unix-socket argument also relied on filesystem permissions; [transport process ownership](2026-11-23-environment-transport-process-ownership.md) removes that deployed mechanism while retaining channel authentication and the extensible `auth` exchange.

## Consequences

- Tools keep one Harness runtime and one plugin installation; remote code is ordinary JavaScript shipped per run.
- The shipped source must be self-contained after the host's transpiler runs. The daemon defines a no-op `__name` for esbuild `keepNames` output; other transpiler or instrumentation helpers fail at run time.
- The utilities a run's context supplies, its arguments and the values its `env` returns come from its worker's realm, so `instanceof` checks against the context's own intrinsics, such as `Uint8Array`, can be false for their objects.
- `node:vm` separates globals between runs but is not a security boundary: remote code runs with the daemon user's permissions and bypasses `ctx.sandbox`.
- `EnvironmentValue` accepts interfaces and therefore also functions at compile time; structured clone rejects such values when their message is encoded, before anything is sent.
- Both peers must read each other's `node:v8` format version; Node 24 and 26 share version 15.
- No shipped tool uses the service yet; Bash, file tools and PTC still use the mounted `ctx.fs` and `ctx.subprocess` providers.
