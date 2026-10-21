---
description: "Run TypeScript programs in fresh Node processes with the session filesystem sandbox, managed cleanup, and configurable execution and output limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

English | [中文](README.zh.md)

## Summary

Execute model-written TypeScript with host-provided async functions. The default `per-call` mode starts a fresh Node process under the same platform sandbox policy as Bash. Opt-in `persistent-in-memory` mode retains a confined REPL across calls for each Agent. Both return captured logs, an exact JSON value, or a structured failure. Direct Node APIs remain available within the selected restrictions. Elapsed deadlines, output bounds and a V8 heap limit constrain execution; cancellation and per-call completion terminate the managed process range. A requested restricted mode fails when its sandbox backend is unavailable.

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

Mount this provider in a composition that supplies `fs`, `subprocess`, `sandbox` and `sandboxPolicy`. PTC mode in `dsh-tools` supplies the calling Session's directory and standing policy; direct runtime consumers resolve those options before execution.

### Configuration

Configure the provider row after its required services are available:

```yaml
- name: '@deepseek-ai/dsh-ptc-runtime-node'
  config:
    executionMode: per-call
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 67108864
    maxOldGenerationSizeMb: 512
    maxMessageBytes: 134217728
    maxPendingCalls: 128
    graceMs: 3000
```

| Field | Default | Meaning |
|---|---|---|
| `executionMode` | `per-call` | `per-call` starts fresh processes under file policy; `persistent-in-memory` retains a confined REPL per owner |
| `timeoutMs` | `120,000` | Default elapsed execution deadline, including nested tool and approval waits |
| `maxTimeoutMs` | `600,000` | Elapsed deadline ceiling applied by the resolver |
| `maxOutputBytes` | `67,108,864` | Combined serialized logs and completion or diagnostic budget |
| `maxOldGenerationSizeMb` | `512` | V8 old-generation heap limit in MiB |
| `maxMessageBytes` | `134,217,728` | Limit for a control message, outstanding binding-argument bytes and queued control writes |
| `maxPendingCalls` | `128` | Maximum simultaneous host binding calls |
| `graceMs` | `3,000` | Managed termination and output-drain grace |
| `launch` | Local carrier | Explicit `{ kind: "node-script", executable, bootstrapPath? }` or `{ kind: "embedded", executable }` in the subprocess world |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-ptc-runtime-node) defines accepted config fields. `resolve(request)` defaults cwd to the sandbox policy workspace root and supplies the numeric or null deadline choice and execution policy; `run(spec)` accepts those resolved inputs and does not fill missing values.

### Execution and results

In `per-call` mode, programs are async function bodies: top-level `await` and `return` work, and only erasable TypeScript is accepted. A successful call returns its lossless-JSON value as `result.value` and captured text as `result.logs`. `result.sandbox` reports the selected mode, observed denial and the backend's full or partial enforcement independently of the program outcome.

Direct filesystem, network and subprocess operations remain Node operations, subject to the selected OS sandbox. Nested host bindings cross the control channel; PTC tool calls retain the registry's visibility, ordering, logging and approval rules. Running a program does not change the Session's standing policy or automatically replay it after a denial.

<a id="persistent-repl"></a>
### In-memory mode

Set `executionMode: persistent-in-memory` on the existing `@deepseek-ai/dsh-ptc-runtime-node` plugin to retain state. Both modes require `fs`, `subprocess`, `sandbox` and `sandboxPolicy`; both apply the selected file sandbox policy. Enable it deliberately with a profile patch:

```yaml
- id: ptc-runtime
  config:
    executionMode: persistent-in-memory
```

Save the patch and pass its path to `dsh headless --patch <path>` in a composition with PTC tool presentation. The default `per-call` mode retains no program memory between calls. Changing the configuration reloads the provider and releases its execution resources. Packaged single-executable hosts require a `node-script` launch with `launch.executable` pointing to Node and `launch.bootstrapPath` pointing to this package's built `persistent-process.js` for in-memory execution.

Each live Agent keeps its own process and top-level variables, functions, and imported modules across `run_code` calls and turns. Use `await import(...)`, `console.log(...)`, and a final JSON expression; top-level `return` is not supported. Assignments to undeclared names create retained globals under Node REPL’s non-strict evaluation. `_` and `_error` are ordinary retained globals, without interactive REPL result setters. Node REPL declaration rules apply, including errors on redeclaring existing `let`, `const`, or `class` names; assign to a mutable binding or choose a new name. A leading `{ ... }` is a statement block and can contain top-level await and temporary declarations; parenthesize an object expression to return it. Retained functions and saved tool methods call the current evaluation's bindings. All tool calls must be awaited; callbacks from a completed evaluation cannot invoke tools in a later evaluation.

Memory is best-effort and never saved to disk. Restart, Agent disposal, provider unload, cancellation, timeout, protocol failure, output overflow, or process exit clears it. Missing variables raise normal reference errors; reacquire handles and recreate declarations. Exceptions in the active evaluation settle once and preserve earlier mutations. Exceptions thrown by callbacks from a completed evaluation are not reported in a later result; await asynchronous work before completing an evaluation. The Session still records programs, tool dispatches and visible results; restoring a Session or forking an Agent starts with empty memory. Each evaluation resets the process working directory to its resolved cwd; program calls to `process.chdir()` do not persist across evaluations. Direct Node access follows the resolved file policy. A retained owner cannot change mode, workspace root, additional writable roots, or Session identity until its environment is released.

Service consumers pass an object as `stateOwner` to reuse its environment and await `release(owner)` when finished. Requests without an owner run in temporary processes. Permission setters record the new mode synchronously. The runtime immediately invalidates affected processes and begins cancellation when the Session mode changes, including idle environments. The next program waits for their cleanup before starting; cleanup failure blocks that program and remains retryable. Permission-setting success does not mean old processes have finished stopping. A one-time approved escalation uses a separate environment and awaits its cleanup before returning; it cannot read the standing environment's variables or retain new declarations. Concurrent runs for one owner reject until execution and required cleanup complete; distinct owners may run concurrently. An idle environment has no expiration timer and keeps its process until release or failure. Raw stdout/stderr have no evaluation identity: bytes received during an evaluation share its output budget, even when written by an earlier child process; idle stdout is discarded and idle stderr retains only the bounded diagnostic tail. Await child-process completion before ending an evaluation. Process-exit diagnostics include the exit code and retained stderr tail; idle failures are written to the host logger. If process observation fails during cleanup, releasing the owner retries termination; new runs remain blocked until cleanup succeeds. Pipes that fail to drain after confirmed process exit produce a diagnostic but do not prevent releasing the environment.

### Deadlines and cancellation

For calls carrying a Session policy, a mode change cancels admission even while waiting for cleanup or process startup. Restoring the previous mode does not revive a canceled call.

The PTC consumer exposes per-call timeout and approved sandbox choices as described in [dsh-tools](../../core/tools/README.md#ptc-mode). The runtime's readonly `timeout` descriptor reports its effective default and maximum to that consumer. The provider owns execution syntax, output syntax and state-retention guidance in `executionInstructions`. The tool consumer appends those mode-specific rules to its model-visible schema without inferring persistence from `programFormat`.

Omitting `timeoutMs` uses the configured elapsed default; numeric requests are validated and capped. Service callers can explicitly pass `timeoutMs: null` to omit the elapsed timer, as the workflow adapter does; `run_code` continues to accept only positive numeric overrides. An enabled deadline covers runtime setup and execution, including time awaiting nested tools or approval. It is not a CPU meter. Timeout or cancellation stops a synchronous loop through the host's managed process owner; successful per-call completion also cleans that managed range. The timer stops when an outcome is selected, before cleanup, so the returned call can take longer than its execution deadline while cleanup settles.

### Failures

Program parse errors and thrown exceptions are `exception`; deadline expiry is `timeout`; cancellation is `abort`; unparsable or oversized control traffic and invalid program messages are `protocol`; unavailable confinement is `sandbox-unavailable`; early process exit or failed managed cleanup is `worker-exit`. The substrate-independent failure name remains `worker-exit` for process providers. Lossy completions are `invalid-output`, and an oversized outer result is `output-limit`, retaining the fitting log prefix. Invalid or unsupported options and calls after disposal reject as caller misuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host owns policy, deadlines, binding lookup and process cleanup. The child owns program evaluation and binding proxies; model-written code is an untrusted peer even when its messages use the expected control descriptor.

### Launch and control

For per-call execution, the host strips erasable types, resolves the executable and bootstrap in the configured execution world, awaits argv confinement through `ctx.sandbox`, then spawns through `ctx.subprocess`. Cancellation is checked again after confinement, so a provider returning after cancellation cannot start the program. After adopting the inherited control channel, the child retains only executable-search, Windows system, and temporary paths in its OS environment and replaces the program-visible `process.env` with an empty dictionary. Windows ACL setup receives the parent's distinct `TEMP` and `TMP` values for shared grant locks, then replaces both with its private directory before starting the program. These native paths keep nested process creation and native temporary-file APIs functional. The host preserves `ELECTRON_RUN_AS_NODE` only for child startup so the Desktop executable runs the Node bootstrap; the bootstrap removes the selector before evaluating model code. The heap limit uses Node argv or a provider-created `NODE_OPTIONS` value for packaged executables; ambient loader and inspector flags are discarded.

The host calls the child’s `run()` method through birpc; injected bindings call the host’s `invoke()` method, and captured output uses notifications. birpc owns request correlation, remote results, and rejection delivery. Newline-delimited JSON travels over the inherited control pipe separately from stdout/stderr. The RPC adapter bounds each line and the native write queue and rejects pending calls when the pipe closes; birpc answers calls to methods an endpoint does not own with an error, and runs no method after the pipe closes. The host validates binding names and lossless JSON before dispatch; one pipe delivers each evaluation's messages before its result, so messages carry no evaluation identity. Execution deadlines remain host-owned, including calls that await approval.

Per-call completion leaves unfinished binding waits pending and stops binding calls and captured output notifications. The child keeps the control pipe open until the host receives its result and closes the pipe. Output capture meters serialized logs plus the completion or diagnostic; fixed result-envelope fields and sandbox metadata are outside that ledger.

### Source and built bootstraps

Source execution loads erasable TypeScript and its installed birpc dependency without relying on sibling built exports. Built process scripts bundle birpc so a preinstalled bootstrap needs no adjacent dependency installation. Built script execution uses `process.js` for per-call programs or `persistent-process.js` for retained REPL environments. Persistent mode requires a `node-script` launch. A remote script deployment supplies the matching `launch.bootstrapPath`. Embedded carriers launch their private worker through `launch.executable`. `resolveLaunch()` selects the local default during construction; an explicit remote invocation never depends on whether the client itself is packaged. A host path is never assumed to name the same remote file.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node provider: mode selection, per-call resolution, policy and managed execution |
| [`src/config.ts`](src/config.ts) | Execution mode, validated limits and defaults |
| [`src/persistent.ts`](src/persistent.ts) | In-memory process ownership, evaluation deadlines and cleanup |
| [`src/persistent-process.ts`](src/persistent-process.ts) | Child REPL, retained declarations and current binding dispatch |
| [`src/output-stream.ts`](src/output-stream.ts) | Bounded stream capture and process-output draining |
| [`src/launch.ts`](src/launch.ts) | Executable/bootstrap arguments and execution-world asset mapping |
| [`src/process.ts`](src/process.ts) | Child handshake, environment clearing and program lifecycle |
| [`src/bootstrap.ts`](src/bootstrap.ts) | Program evaluation, binding proxies and output capture |
| [`src/rpc.ts`](src/rpc.ts) | Typed birpc transport, message limits and connection lifetime |
| [`src/protocol.ts`](src/protocol.ts) | Host and program methods, and validation of untrusted program results |
| [`src/output-ledger.ts`](src/output-ledger.ts) | Host accounting for the outer result |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read the service contract before using the provider directly; the decisions explain policy and consumer ownership.

- [PTC runtime service](../ptc-runtime/README.md) — requests, resolved specs and results.
- [Sandboxed Node decision](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md) — security, lifecycle and timeout tradeoffs.
- [PTC foundation](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — registry presentation and nested tool dispatch.
- [Subprocess provider](../../subprocess/subprocess-local/README.md) — managed process ranges and platform limitations.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through PTC mode in `dsh-tools` and `dsh-workflow-ptc`, which present program outcomes through their own tool results. Intermediate binding traffic stays outside model history; the outer result follows the ordinary tool spill policy.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits qualify the execution guarantees and retained output.

- **Confinement inherits the selected backend's limits** — full and partial enforcement are reported separately; sandbox policy and managed-process containment are distinct guarantees.
- **The heap cap is not a process-tree memory limit** — native allocations and descendant memory are outside the V8 old-generation bound. No process-tree CPU meter is supplied.
- **Cleanup inherits subprocess observability** — escaped descendants on a fallback platform may remain outside the managed range; see the subprocess provider's stated limits.
- **Default execution is one-shot** — retained state requires `executionMode: persistent-in-memory`; neither mode offers a yield/wait API.
- **In-memory environments retain one process per live owner** — idle owners keep their process and heap until explicit release, owner disposal or failure. Fan-out can retain many processes; idle expiration remains deferred.
- **Output caps reject rather than retain every byte** — spill can preserve only the bounded result delivered by this provider.
- **Bindings are bounded at transport admission** — control limits do not bound the memory a host binding allocates while producing its result.
- **The control protocol has no version handshake** — a preinstalled `launch.bootstrapPath` or SSH helper must come from the client's release; another release's bootstrap fails at its first control message.
- **The console shim has five methods** — `log`, `info`, `warn`, `error` and `debug`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [timeout discussion](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md#deferred-timeout-design) records open choices about yielding, total lifetime, approval wait accounting and process-tree CPU/RSS limits. Those choices do not alter numeric deadline defaults or the explicit no-deadline service option.

</details>
