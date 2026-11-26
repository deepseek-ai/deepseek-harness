---
description: "Run self-contained functions in provider-contributed execution environments, with typed origin callbacks."
kind: "package-reference"
---

# @deepseek-ai/dsh-environment

English | [中文](README.zh.md)

## Summary

Run a tool's file and process operations in a selected execution environment while its state and result formatting stay in the originating dsh. Providers contribute stable handles, display names and transports; one registry runs the same function protocol over every transport. SSH, SSH config discovery and local providers are available separately. Functions receive filesystem and process APIs plus typed callbacks to the origin. This capability is experimental and requires explicit composition; existing tools keep their current execution providers.

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

Mount the registry and one or more providers, then define each function once and run it with a provider-owned handle. Environment handles are opaque identifiers; display names are user-facing labels and may repeat.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh'
  config:
    handle: ssh-build
    displayName: Build machine
    host: build-box
```

The dependency-free `lib/daemon.js` bundle is exported as `./daemon.js` and requires Node `^24.22.3 || >=26.13.1`. The [single SSH provider](../environment-ssh/README.md) installs missing or older daemons at remote `~/.cache/dsh/environment/daemon.js` by default; optional `daemonPath` selects another absolute path. Its documentation defines verification and replacement rules. The [SSH config provider](../environment-ssh-config/README.md) and [local provider](../environment-local/README.md) contribute environments independently.

| Registry field | Default | Meaning |
|---|---|---|
| `maxFrameBytes` | 1 MiB | Largest frame; a larger message travels as several frames, which interleave with other messages' frames |
| `maxMessageBytes` | 64 MiB | Largest encoded message: a run's source, arguments and method names, its result, or one origin call or result; also bounds `exec` output |
| `maxPending` | 64 | Outstanding runs and outstanding origin calls per connection; a connection's runs occupy at most this many daemon worker threads |
| `cancelGraceMs` | 10000 | Time to answer a cancelled run before closing its connection; the daemon terminates a cancelled run still running after half of it |
| `killGraceMs` | 2000 | Time between SIGTERM and SIGKILL for remaining execution-process groups |
| `connectTimeoutMs` | 30000 | Connection and handshake deadline, excluding human trust confirmation |

Both byte limits are at least 1024, and `maxFrameBytes` is at most `maxMessageBytes`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-environment) owns the exhaustive field reference.

### Registry and execution

A provider registers `{ handle, displayName }` together with an `EnvironmentTransport`, using `ctx.effect(() => ctx.environments.register(info, transport))`. `ctx.environments.handle(value)` admits a non-empty identifier without interpreting its format. Duplicate handles fail; display names need not be unique. `list()` returns public metadata snapshots, and `get(handle)` returns the current registration's metadata. Connection details stay with the provider.

The payload-free `environments/change` event fires once per registration and once per effective unregistration, after `list()` and `get(handle)` reflect the change. Consumers that show environments, such as a host picker, re-read `list()` when it fires. A listener runs synchronously and may register or run environments; a failing listener is logged and does not undo the change.

`ctx.environments.define(fn, options)` binds a function, its result validation and its origin handlers and returns an `EnvironmentRunner`. The origin method names are the own property names of `options.handlers` when defining; names added to that object later are neither exposed nor served, while each origin call looks its handler up on the object when the call arrives. Calling the runner with an environment handle, arguments and `{ signal }` runs the function at most once in that environment. Defining contacts no environment and requires no registration, so a definition made when a plugin loads serves every later call in every environment. The registry reuses one connection per registration and opens different environments independently. Unregistering a provider removes its metadata and closes its connection. A later call of the same definition with the same handle resolves the handle's new registration; a run already in progress never switches to a replacement registration.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export const inject = ['environments', 'tools']

export function apply(ctx: Context): void {
  const readPaths = new Set<string>()
  const readFile = ctx.environments.define(async ({ path }: { path: string }, env) => {
    const text = await env.fs.readFile(path, 'utf8')
    const first = await env.origin.markRead(path)
    return { text, first }
  }, {
    result: z.object({ text: z.string(), first: z.boolean() }),
    handlers: {
      markRead: (path: string) => {
        const first = !readPaths.has(path)
        readPaths.add(path)
        return first
      },
    },
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_environment',
    description: 'Read a file in the build environment.',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, first: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: (args, exec) => readFile(ctx.environments.handle('ssh-build'), { path: args.path }, { signal: exec.signal }),
  })))
}
```

The registry and handlers run in the originating dsh process. Only the function's source and the handler names, which `define` reads and hashes once, and each call's arguments travel to the execution process. `EnvironmentContext` provides that process's `fs`, `path`, `cwd`, `platform`, shell-free `exec`, `signal`, `limits` and `origin`. A function must reference only its arguments, `EnvironmentContext` and the globals of its `node:vm` context. Each run gets a fresh context in a worker thread, without `require`, `import` or `process`; besides JavaScript built-ins, the context supplies `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`, `Buffer`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `structuredClone`, `AbortController`, `AbortSignal`, `atob`, `btoa` and `performance`. These utilities, the function's arguments and the values that `env` returns come from the worker's realm, so `instanceof` checks against the context's own intrinsics, such as `Uint8Array`, can be false for their objects. A worker serves its runs one at a time, and every run on it shares the same worker-realm objects, such as `Buffer`, `URL`, `env.fs` and `env.path`; a function that modifies them, for example by assigning a property, changes them for the worker's later runs. Timers that the run starts with `setTimeout`, `setInterval` or `AbortSignal.timeout` and that are still pending when the run ends never fire. The context also supplies a no-op `__name` for esbuild `keepNames`; other emitted helpers must be self-contained.

The type of the function's first parameter fixes each call's arguments; interfaces work as well as type literals, and an unannotated parameter accepts any `EnvironmentValue`. The own methods of `env.origin` come from the definition's `handlers`, which serve every call and receive only the parameters the function sends. Host state that belongs to one call, such as a tool call's background job, therefore needs a definition made for that call; defining per call only reads the handler names and hashes the function source with them, and definitions with identical source and handler names in the same order share a connection's definition cache. The methods' parameter and awaited result types are inferred; detached calls work without a receiver. Annotate every inline handler parameter, including `signal: AbortSignal` when used, so TypeScript can infer handlers before checking the function. A `void` return annotation permits discarded values in TypeScript, so its call result is `EnvironmentValue`. Handlers receiving untrusted input accept `unknown` and validate it themselves.

Arguments, results, origin parameters and origin results are `EnvironmentValue`s, copied by structured clone over the connection and between the execution process's threads. Besides plain objects, arrays and primitives other than symbols, they may contain `Uint8Array` and other typed arrays, `undefined`, `Date`, `RegExp`, `Map`, `Set`, `bigint` and errors, which keep only their message, stack, cause and a standard name such as `TypeError`. Class instances arrive as plain objects, and a `Buffer` arrives as a `Uint8Array`. Omitted parameters and undefined results remain `undefined`. A value that structured clone cannot copy, such as a function, fails its message before anything is sent: arguments fail the call with `ENVIRONMENT_REQUEST_REFUSED`, a result fails it with `ENVIRONMENT_RUN_FAILED`, and origin parameters or handler results reject the origin call inside the function.

Each encoded message must fit `maxMessageBytes`; a larger one is refused before sending, with the same failures as a value that cannot be copied, and the connection stays open. Callers split larger data across several runs or origin calls: `ctx.environments.limits.maxMessageBytes` reports the limit to callers, and `env.limits.maxMessageBytes` to functions. Binary data counts its byte length; strings count at most two bytes per UTF-16 code unit. The registry sends messages larger than `maxFrameBytes` as several frames, so callers never handle frames.

### Cancellation and failures

Aborting a call's signal aborts its origin handlers immediately and sends cancellation to the execution process, which aborts the function's context signal and terminates its `exec` process groups. Returning or throwing from the function aborts its context signal, ends remaining origin calls and terminates remaining `exec` process groups. Completed effects are never rolled back. If a cancelled function has not stopped within half of `cancelGraceMs`, the execution process terminates its worker thread and answers the cancellation, so the connection and its other runs continue. A daemon that does not answer a cancellation within `cancelGraceMs` loses its connection.

`exec` returns exit code, signal, stdout and stderr, including non-zero exits. Output over `maxMessageBytes` rejects the operation, and the run's result must also fit that limit. Each call validates the returned value through the definition's `result`. `EnvironmentError` codes distinguish unreachable environments, unknown outcomes after disconnection, refused requests, execution failures, invalid results and disposed registries. A connection lost before sending is reopened once; a sent run is never replayed. Provider `HarnessError`s pass through. A call's `confirm` option lets a waiting caller answer transport trust questions; confirmation time does not count toward the connection deadline.

When the function throws, the run fails with `ENVIRONMENT_RUN_FAILED`, the thrown error's message, and `remote` holding its `name`, `message` and string `code`, such as an errno name like `ENOENT` or a `HarnessError` code. A worker thread that fails or exits during the run, and a daemon that cannot send a result, report that failure in `remote` instead. An origin call whose handler throws rejects inside the function with an error carrying the handler error's `name`, `message` and `code`.

### Execution daemon

The standalone build starts with `// dsh-environment-daemon ` followed by JSON fields `version`, `protocol` and `node`, taken from the environment package version, protocol constant and repository Node engine range. Providers can inspect this first line without executing the daemon; the SSH provider also verifies the complete bundle's SHA-256 digest.

`node daemon.js serve --stdio` serves one connection on standard input/output. The entry accepts only `serve --stdio`, with optional `--auth-timeout-ms`. Both SSH and local providers start a fresh daemon for each new connection; reusing a live channel keeps the same process. The daemon has no resident listener or state shared across connections.

The daemon runs each connection's functions on a pool of worker threads. A run occupies one worker and returns it when the run settles, so the pool grows to the connection's peak concurrency, which `maxPending` bounds; a terminated worker counts until it exits, so the pool can briefly hold more. Closing the connection ends every worker. A function that blocks its thread therefore delays no other run. An exception that no code catches, such as one thrown in a timer callback, fails the run its worker is serving, which can be a later run when a finished run left code pending on that worker; between runs, the worker reports it on the daemon's standard error and keeps serving. A worker that fails or exits during a run fails only that run and is retired, and a run that finds no idle worker starts a new one. `exec`, its process-group cleanup and origin calls stay on the daemon's main thread. The daemon discards what a worker writes to `process.stdout`, because the daemon's standard output carries the protocol; code that writes to file descriptor 1 directly, for example through `/dev/stdout`, corrupts the connection.

Each run names its definition, which consists of the function source and its origin method names, by the SHA-256 hash of the JSON encoding of `[source, methods]`; equal sources with different handler names are therefore different definitions. The registry includes the definition in a connection's runs until the daemon has answered one of them; the daemon verifies the hash of every definition it receives, keeps the definition until the connection closes, and refuses a run that names an unknown hash. Each worker compiles a definition's source once and evaluates it in a fresh context for every run. A new connection, including one opened after a daemon exits, receives each definition again.

The `transport` authentication mechanism trusts the channel supplied by the provider. SSH authenticates the user and destination; the local provider owns the child process and its pipes. Callers must trust the provider, daemon files and execution machine. A network transport must authenticate its channel before using this mechanism.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Providers own discovery, daemon startup and shutdown, and any mechanism that keeps an execution process alive. The registry owns metadata, cached connections and the common symmetric request peer. Every connection authenticates before accepting runs. Every run sends a definition hash, the definition until the connection holds it, and arguments; a definition holds the function source and its origin-method names, and the execution process constructs those methods as RPC calls. Inside the execution process, values cross between the main thread and a worker by `postMessage` structured clone, and errors cross as their `name`, `message` and string `code`. Origin handlers are scoped to both their run and its owning connection.

Each frame is a 4-byte big-endian length followed by a `node:v8` encoding, validated after decoding. A request, result or error whose encoding exceeds `maxFrameBytes` travels as `part` frames carrying its request id, direction, total size and one slice. Every part but a message's last carries at least 1024 bytes minus the part frame's own fields. The sender queues each part after the previous one is written, so other messages' frames interleave; the receiver checks the total size against `maxMessageBytes` and decodes the reassembled message. A peer sends messages as parts only while their sizes together fit `maxMessageBytes`; a further one waits in order until earlier ones leave room, while messages that fit one frame never wait for room and queue only behind one part of each message in flight. The receiver keeps at most `maxMessageBytes` of partially received messages and closes the connection on a peer that sends more at once. Error frames carry the thrown error's `name`, `message` and string `code`.

Requests have per-peer identifiers and cancellation accounting. Cancelling a request stops sending its remaining parts and retains its pending slot until the peer answers. A peer that receives the cancellation drops the partial request and answers with an error, or stops sending its answer's remaining parts and reports the cancellation instead; the requester drops the answer's parts. Closing a connection drops every partially received message. Invalid frames, pending-limit violations or disconnected streams close the peer and reject its pending work. A result that cannot be encoded or exceeds `maxMessageBytes` fails its request visibly. A new connection starts a separate daemon; the registry never replays a sent run.

| File | Owns |
|---|---|
| [`src/index.ts`](src/index.ts) | Registry metadata, definitions, connections and origin dispatch |
| [`src/types.ts`](src/types.ts) | Execution-context and transport interfaces |
| [`src/handle.ts`](src/handle.ts) | Provider-owned branded handles |
| [`src/protocol.ts`](src/protocol.ts) | Symmetric request peer, frame splitting and validation |
| [`src/daemon.ts`](src/daemon.ts) | Worker pool, definition cache, `exec` and process cleanup |
| [`src/worker-loop.ts`](src/worker-loop.ts) | Run evaluation, timers and base utilities in a worker thread |
| [`src/daemon-entry.ts`](src/daemon-entry.ts) | One stdio connection and daemon options |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Environment subsystem](../../../docs/subsystems/environment.md) — public service reference.
- [SSH provider](../environment-ssh/README.md) — one configured destination.
- [SSH config provider](../environment-ssh-config/README.md) — concrete OpenSSH aliases.
- [Local provider](../environment-local/README.md) — a managed local execution process.
- [SSH filesystem/process providers](../../ssh/README.md) — Session-wide execution-provider replacement.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tools calling defined functions; those tools own model schemas, rendered output and logged results. This package adds no prompt section, model tool or Session event.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Execution processes are not sandboxes.** `node:vm` separates globals but grants the execution process's filesystem and process permissions. Direct `fs` and `exec` do not apply the originating Session's sandbox policy, including for the local provider.
- **No shipped tool or profile consumes this capability.** Existing tools keep their current filesystem and subprocess services.
- **No remote process supervisor.** The daemon uses Node standard-library APIs and ends its workers and `exec` process groups only after it observes its connection close. A network failure that SSH does not report to the remote daemon leaves them running; a daemon killed with `SIGKILL` leaves its `exec` process groups running.
- **Frames use the `node:v8` serialization format.** Node 24 and 26 write the same format version; a peer on a later Node release whose format the other cannot read fails the connection with an undecodable-frame error.
- **Split messages are sent in order.** A message close to `maxMessageBytes` makes every later message larger than one frame in the same direction wait until it is sent.
- **Definitions are cached per connection.** Every new connection receives each definition again, and its daemon keeps every definition it receives until the connection closes. There is no connection heartbeat. Callers supply cancellation for stalled work; completed effects are never rolled back.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Protocol tests launch erasable daemon source directly with Node over stdio. Published-path smokes launch the built, standalone `lib/daemon.js` bundle. Vitest coverage does not observe worker threads, so `tests/worker-loop.spec.ts` runs `runWorker` in the test process over a `MessageChannel`, while daemon and composition specs exercise real workers.

</details>
