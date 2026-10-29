---
description: "Run TypeScript programs in Node processes with optional retained memory, the session filesystem sandbox, and configurable execution limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

English | [中文](README.zh.md)

## Summary

Execute model-written TypeScript with host-provided async functions. The default `per-call` mode runs async function bodies in fresh Node processes; `vm-script` supports top-level await and optionally retains a context per Agent with `scriptPersistence`. Opt-in `persistent-in-memory` retains a REPL per Agent. All modes apply the selected file sandbox policy and return captured logs, lossless JSON, or structured failures. Elapsed deadlines, output bounds and a V8 heap limit constrain execution. Cancellation and one-shot completion clean up the managed process range; unavailable confinement fails execution.

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

Mount this provider in a composition that supplies `fs`, `subprocess`, `sandbox` and `sandboxPolicy`. `dsh-tool-executor-ptc` supplies the calling Session's directory and standing policy; direct runtime consumers resolve those options before execution.

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
| `executionMode` | `per-call` | `per-call` runs async function bodies in fresh processes; `vm-script` evaluates Scripts; `persistent-in-memory` retains a confined REPL per owner |
| `scriptPersistence` | `false` | With `executionMode: vm-script`, reuse a process and context per owner; `true` with another mode rejects at load |
| `timeoutMs` | `120,000` | Default elapsed execution deadline, including nested tool and approval waits |
| `maxTimeoutMs` | `600,000` | Elapsed deadline ceiling applied by the resolver |
| `maxOutputBytes` | `67,108,864` | Combined serialized logs and completion or diagnostic budget |
| `maxOldGenerationSizeMb` | `512` | V8 old-generation heap limit in MiB |
| `maxMessageBytes` | `134,217,728` | Limit for a control message, outstanding binding-argument bytes and queued control writes |
| `maxPendingCalls` | `128` | Maximum simultaneous host binding calls |
| `graceMs` | `3,000` | Managed termination and output-drain grace |
| `launch` | Local carrier | Explicit `{ kind: "node-script", executable, bootstrapPath? }` or `{ kind: "embedded", executable }` in the subprocess world |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-ptc-runtime-node) defines accepted config fields. `resolve(request)` defaults cwd to the sandbox policy workspace root and supplies the numeric or null deadline choice and execution policy; `run(spec)` accepts those resolved inputs and does not fill missing values.

Profile editors can import `resolvePersistentExecution` from `@deepseek-ai/dsh-ptc-runtime-node/configuration` to select retained execution from the effective program format. Merge both returned settings atomically: Script keeps its syntax, while function bodies switch to the REPL.

### Execution and results

In `per-call` mode, programs are async function bodies: top-level `await` and `return` work, and only erasable TypeScript is accepted. Node globals remain available, and a function body may declare a local `process`, including `const process = await import("node:process")`. A successful call returns its lossless-JSON value as `result.value` and captured text as `result.logs`. `result.sandbox` reports the selected mode, observed denial and the backend's full or partial enforcement independently of the program outcome.

Direct filesystem, network and subprocess operations remain Node operations, subject to the selected OS sandbox. Nested host bindings cross the control channel; PTC tool calls retain the registry's visibility, ordering, logging and approval rules. Running a program does not change the Session's standing policy or automatically replay it after a denial.

Set `executionMode: vm-script` to evaluate erasable TypeScript through `node:vm` Script. Top-level declarations and `await` work, for example `var fs = await import("node:fs/promises"); await fs.readdir(".")`. Top-level `return` and static `import`/`export` are not supported. The runtime awaits the final expression and returns its lossless JSON value; `console.log(...)` also emits output. Relative dynamic imports resolve from the supplied working directory. Script syntax is non-strict unless the program opts into strict mode; the context is not a security boundary, and Node access remains subject to the process sandbox.

`scriptPersistence: false` is the default: every call uses a fresh process and context, ignoring `stateOwner`. Set it to `true` to retain a context per owner under the lifecycle rules below. Top-level declarations, functions and object identities survive subsequent calls, including values initialized through top-level `await`. Function locals remain local. This option requires `executionMode: vm-script`; both settings accept the same syntax.

```yaml
- id: ptc-runtime
  config:
    executionMode: vm-script
    scriptPersistence: true
```

<a id="persistent-repl"></a>
### In-memory modes

The `persistent-in-memory` mode and Script mode with `scriptPersistence: true` retain state per owner. To select the REPL evaluator, set `executionMode: persistent-in-memory` on the existing `@deepseek-ai/dsh-ptc-runtime-node` plugin. All modes require `fs`, `subprocess`, `sandbox` and `sandboxPolicy` and apply the selected file sandbox policy. Enable it deliberately with a profile patch:

```yaml
- id: ptc-runtime
  config:
    executionMode: persistent-in-memory
```

Save the patch and pass its path to `dsh headless --patch <path>` in a composition with PTC tool presentation. The `per-call` mode and Script mode with `scriptPersistence: false` retain no program memory between calls. Changing the configuration reloads the provider and releases its execution resources. Packaged single-executable hosts require a `node-script` launch with `launch.executable` pointing to Node and `launch.bootstrapPath` pointing to this package's built `process.js` for in-memory execution.

In REPL mode, each live Agent keeps its own process and top-level variables, functions, and imported modules across `run_code` calls and turns. Use `await import(...)`, `console.log(...)`, and a final JSON expression; top-level `return` is not supported. Assignments to undeclared names create retained globals under Node REPL’s non-strict evaluation. `_` and `_error` are ordinary retained globals, without interactive REPL result setters. Node REPL declaration rules apply, including errors on redeclaring existing `let`, `const`, or `class` names; assign to a mutable binding or choose a new name. A leading `{ ... }` is a statement block and can contain top-level await and temporary declarations; parenthesize an object expression to return it. Retained functions and saved tool methods call the current evaluation's bindings. All tool calls must be awaited; callbacks from a completed evaluation cannot invoke tools in a later evaluation.

Memory is best-effort and never saved to disk. Restart, Agent disposal, provider unload, cancellation, timeout, protocol failure, output overflow, or process exit clears it. Missing variables raise normal reference errors; reacquire handles and recreate declarations. Exceptions in the active evaluation settle once and preserve earlier mutations. In REPL mode, exceptions from callbacks belonging to a completed evaluation are not reported in a later result. In Script mode, uncaught callback exceptions can terminate the retained process; await asynchronous work before completing an evaluation. The Session still records programs, tool dispatches and visible results; restoring a Session or forking an Agent starts with empty memory. Each evaluation resets the process working directory to its resolved cwd; program calls to `process.chdir()` do not persist across evaluations. Direct Node access follows the resolved file policy. A retained owner cannot change mode, workspace root, additional writable roots, or Session identity until its environment is released.

Service consumers pass an object as `stateOwner` to reuse its environment and await `release(owner)` when finished. Requests without an owner run in temporary processes. Their failures leave other owners' retained variables intact and do not report clearing them. Permission setters record the new mode synchronously. The runtime immediately invalidates affected processes and begins cancellation when the Session mode changes, including idle environments. The next program waits for their cleanup before starting; cleanup failure blocks that program and remains retryable. Permission-setting success does not mean old processes have finished stopping. A one-time approved escalation uses a separate environment and awaits its cleanup before returning; it cannot read the standing environment's variables or retain new declarations. Concurrent runs for one owner reject until execution and required cleanup complete; distinct owners may run concurrently. An idle environment has no expiration timer and keeps its process until release or failure. Raw stdout/stderr have no evaluation identity: bytes received during an evaluation share its output budget, even when written by an earlier child process; idle stdout is discarded and idle stderr retains only the bounded diagnostic tail. Await child-process completion before ending an evaluation. Process-exit diagnostics include the exit code and retained stderr tail; idle failures are written to the host logger. If process observation fails during cleanup, releasing the owner retries termination; new runs remain blocked until cleanup succeeds. Pipes that fail to drain after confirmed process exit produce a diagnostic but do not prevent releasing the environment.

### Deadlines and cancellation

For calls carrying a Session policy, a mode change cancels admission even while waiting for cleanup or process startup. Restoring the previous mode does not revive a canceled call.

The PTC consumer exposes per-call timeout and approved sandbox choices as described in [dsh-tool-executor-ptc](../../core/tool-executor-ptc/README.md). The runtime's readonly `timeout` descriptor reports its effective default and maximum to that consumer. The provider owns execution syntax, output syntax and state-retention guidance in `executionInstructions`. The tool consumer appends those mode-specific rules to its model-visible schema without inferring persistence from `programFormat`.

Omitting `timeoutMs` uses the configured elapsed default; numeric requests are validated and capped. Service callers can explicitly pass `timeoutMs: null` to omit the elapsed timer, as the workflow adapter does; `run_code` continues to accept only positive numeric overrides. An enabled deadline covers runtime setup and execution, including time awaiting nested tools or approval. It is not a CPU meter. Timeout or cancellation stops a synchronous loop through the host's managed process owner; successful per-call completion also cleans that managed range. The timer stops when an outcome is selected, before cleanup, so the returned call can take longer than its execution deadline while cleanup settles.

### Failures

Program parse errors and thrown exceptions are `exception`; deadline expiry is `timeout`; cancellation is `abort`; unparsable or oversized control traffic and invalid program messages are `protocol`; unavailable confinement is `sandbox-unavailable`; early process exit, lost control transport or failed managed cleanup is `worker-exit`. Control I/O failures retain the transport diagnostic alongside the observed process exit status. The substrate-independent failure name remains `worker-exit` for process providers. Lossy completions are `invalid-output`, and an oversized outer result is `output-limit`, retaining the fitting log prefix. Invalid or unsupported options and calls after disposal reject as caller misuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host owns policy, deadlines, binding lookup and process cleanup. The child owns program evaluation and binding proxies; model-written code is an untrusted peer even when its messages use the expected control descriptor.

`createExecution()` resolves the configured syntax, type erasure, model guidance and process lifetime once when the provider loads. The provider handles admission and cancellation. One execution owner creates temporary processes or reuses an enabled state owner's process; both use `ProgramWorker` for launch, deadlines, binding dispatch and cleanup. The shared child loop selects `createProgramEvaluator()` from the evaluation data; async-function, REPL and Script implementations expose globals, evaluation and cleanup operations independently of process lifetime.

### Launch and control

The host strips erasable types and, when starting a process, resolves the executable and bootstrap in the configured execution world, awaits argv confinement through `ctx.sandbox`, then spawns through `ctx.subprocess`. Cancellation is checked again after confinement, so a provider returning after cancellation cannot start the program. After adopting the inherited control channel, the child retains only executable-search, Windows system, and temporary paths in its OS environment and replaces the program-visible `process.env` with an empty dictionary. Windows ACL setup receives the parent's distinct `TEMP` and `TMP` values for shared grant locks, then replaces both with its private directory before starting the program. These native paths keep nested process creation and native temporary-file APIs functional. The host preserves `ELECTRON_RUN_AS_NODE` only for child startup so the Desktop executable runs the Node bootstrap; the bootstrap removes the selector before evaluating model code. The heap limit uses Node argv or a provider-created `NODE_OPTIONS` value for packaged executables; ambient loader and inspector flags are discarded.

The host calls the child’s `run()` method through birpc; injected bindings call the host’s `invoke()` method, and captured output uses notifications. birpc owns request correlation, remote results, and rejection delivery. Newline-delimited JSON travels over the inherited control pipe separately from stdout/stderr. The RPC adapter bounds each line and the native write queue and rejects pending calls when the pipe closes; birpc answers calls to methods an endpoint does not own with an error, and runs no method after the pipe closes. The host validates binding names and lossless JSON before dispatch; one pipe delivers each evaluation's messages before its result, so messages carry no evaluation identity. Execution deadlines remain host-owned, including calls that await approval.

Per-call completion leaves unfinished binding waits pending and stops binding calls and captured output notifications. The child keeps the control pipe open until the host receives its result and closes the pipe. Output capture meters serialized logs plus the completion or diagnostic; fixed result-envelope fields and sandbox metadata are outside that ledger.

### Source and built bootstraps

Source execution loads an erasable-only bootstrap closure without relying on sibling built exports; its evaluator modules and installed Acorn and birpc dependencies must be available in the execution world. Built script execution uses `process.js` for every mode; `persistent-process.js` delegates to the same loop with a REPL default for hosts that omit program syntax. Persistent mode requires a `node-script` launch. A remote script deployment supplies the matching `launch.bootstrapPath`. Embedded carriers launch their private worker through `launch.executable`. `resolveLaunch()` selects the local default during construction; an explicit remote invocation never depends on whether the client itself is packaged. A host path is never assumed to name the same remote file.

Source containing `await` is checked for top-level await before native compilation, which can otherwise treat `await` as an identifier. Acorn parses an async wrapper, and acorn-walk traverses it using Node's REPL visitors, declaration hoisting and character-position edits. Computed class-method keys are traversed while method bodies remain separate evaluations. The transform boxes the final expression; the evaluator unwraps and awaits its value. Source that needs no lowering uses native compilation; submissions without `await` retain native syntax diagnostics. Syntax errors preserve the parser message and available source location and caret, without compiler or transformer stack frames. Dynamic `import()` expressions remain native and use the compiling Script's `importModuleDynamically` option. Both private process bundles include Acorn, acorn-walk and birpc; source execution imports the installed packages.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node provider: common admission, cancellation and service delegation |
| [`src/config.ts`](src/config.ts) | Execution mode, validated limits and defaults |
| [`src/configuration.ts`](src/configuration.ts) | Retained-execution settings for profile editors |
| [`src/execution.ts`](src/execution.ts) | Mode selection, request resolution and temporary or retained process ownership |
| [`src/worker.ts`](src/worker.ts) | Shared process launch, evaluation deadlines, binding dispatch and cleanup |
| [`src/persistent-process.ts`](src/persistent-process.ts) | Installed REPL-default entry delegating to the common child loop |
| [`src/evaluators/index.ts`](src/evaluators/index.ts) | Shared selection entry for the three evaluators |
| [`src/evaluators/async-function.ts`](src/evaluators/async-function.ts) | AsyncFunction: strict async function bodies |
| [`src/evaluators/repl.ts`](src/evaluators/repl.ts) | Node REPL: interactive declarations and retained context |
| [`src/evaluators/vm-script.ts`](src/evaluators/vm-script.ts) | VM Script: Node globals, declarations and Promise completion |
| [`src/evaluators/vm-script-await.ts`](src/evaluators/vm-script-await.ts) | VM Script top-level await lowering and retained declarations |
| [`src/output-stream.ts`](src/output-stream.ts) | Bounded stream capture and process-output draining |
| [`src/launch.ts`](src/launch.ts) | Executable/bootstrap arguments and execution-world asset mapping |
| [`src/process.ts`](src/process.ts) | Common child handshake, evaluator lifetime and binding RPC |
| [`src/bootstrap.ts`](src/bootstrap.ts) | Binding proxies, JSON validation, cross-realm exception formatting and output capture |
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

Indirectly, through `dsh-tool-executor-ptc` and `dsh-workflow-ptc`, which present program outcomes through their own tool results. Intermediate binding traffic stays outside model history; the outer result follows the ordinary tool spill policy.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits qualify the execution guarantees and retained output.

- **Confinement inherits the selected backend's limits** — full and partial enforcement are reported separately; sandbox policy and managed-process containment are distinct guarantees.
- **The heap cap is not a process-tree memory limit** — native allocations and descendant memory are outside the V8 old-generation bound. No process-tree CPU meter is supplied.
- **Cleanup inherits subprocess observability** — escaped descendants on a fallback platform may remain outside the managed range; see the subprocess provider's stated limits.
- **Default execution is one-shot** — retained state requires `persistent-in-memory` mode or Script mode with `scriptPersistence: true`; no mode offers a yield/wait API.
- **Await lowering relaxes declaration semantics** — in transformed programs, top-level `let`, `const`, and `class` bindings are mutable and initialized to `undefined` before execution; the native temporal dead zone does not apply. Function declarations populate retained globals when execution reaches them, and a `var` declaration without an initializer resets its binding to `undefined`. Direct-eval declarations stay within that evaluation. Top-level `using` declarations are rejected; put disposable bindings inside a block. Runtime stack locations refer to the transformed source. Scripts that compile without lowering keep native semantics.
- **Failed native lexical initialization can reserve a name** — if a top-level `let`, `const`, or `class` initializer throws before initializing its binding, that name remains uninitialized in the retained Script context. Reading, assigning or redeclaring it fails; use a new name or release and recreate the environment.
- **Script values can cross realms** — binding results, binding rejection classes and imported modules can use constructors from outside the Script context. `instanceof Array` or `instanceof Error` can be false for those values; use `Array.isArray` and the declared binding error class.
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
