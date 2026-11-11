---
description: "Run TypeScript programs in Node processes with optional retained memory, the session filesystem sandbox, and configurable execution limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-ptc-runtime-node

English | [中文](README.zh.md)

## Summary

Execute model-written TypeScript with host-provided async functions. The default `per-call` mode runs async function bodies in fresh Node processes; `vm-script` supports top-level await and optionally retains a context per Agent with `scriptPersistence`. Opt-in `persistent-in-memory` retains a REPL per Agent. All modes apply the file sandbox policy at process launch and return captured logs, lossless JSON, or structured failures. Elapsed deadlines, output bounds and a V8 heap limit constrain execution. Unacknowledged stops and one-shot completion clean up the managed process range; unavailable confinement fails execution.

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

Programs display text, objects, and `Image` values through top-level `inspect(...values)`. One call can mix multiple texts and images, including images nested in arrays and objects. `Image.attachmentId` matches the attachment ID in the model's image description. `Image.path` names a stored attachment file readable in the execution environment; `width` and `height` describe that file’s pixels. Image descriptors share the `maxOutputBytes` budget with text.

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
    stopGraceMs: 3000
    graceMs: 3000
```

| Field | Default | Meaning |
|---|---|---|
| `executionMode` | `per-call` | `per-call` runs async function bodies in fresh processes; `vm-script` evaluates Scripts; `persistent-in-memory` retains a confined REPL per owner |
| `scriptPersistence` | `false` | With `executionMode: vm-script`, reuse a process and context per owner; `true` with another mode rejects at load |
| `replScoped` | `true` with `persistent-in-memory`, otherwise `false` | With `executionMode: persistent-in-memory`, run scoped REPL statements whose calls receive copies of earlier top-level bindings; `false` selects Node's REPL evaluator, and `true` with another mode rejects at load |
| `timeoutMs` | `120,000` | Default elapsed execution deadline, including nested tool and approval waits |
| `maxTimeoutMs` | `600,000` | Elapsed deadline ceiling applied by the resolver |
| `maxOutputBytes` | `67,108,864` | Combined serialized logs and completion or diagnostic budget |
| `maxOldGenerationSizeMb` | `512` | V8 old-generation heap limit in MiB |
| `maxMessageBytes` | `134,217,728` | Limit for a control message, outstanding binding-argument bytes and queued control writes |
| `maxPendingCalls` | `128` | Maximum simultaneous host binding calls |
| `stopGraceMs` | `3,000` | Time to wait for cooperative stop acknowledgment before terminating the process |
| `graceMs` | `3,000` | Managed termination and output-drain grace |
| `launch` | Local carrier | Explicit `{ kind: "node-script", executable, bootstrapPath? }` or `{ kind: "embedded", executable }` in the subprocess world |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-ptc-runtime-node) defines accepted config fields. `resolve(request)` defaults cwd to the sandbox policy workspace root and supplies the numeric or null deadline choice and execution policy; `run(spec)` accepts those resolved inputs and does not fill missing values.

Profile editors can import `resolvePersistentExecution` from `@deepseek-ai/dsh-ptc-runtime-node/configuration` to select retained execution from the effective program format. Merge all three returned settings atomically: Script and scoped REPL keep their syntax, while function bodies and REPL statements switch to `persistent-in-memory` with its default `replScoped`, the scoped REPL.

### Execution and results

In `per-call` mode, programs are async function bodies: top-level `await` and `return` work, and only erasable TypeScript is accepted. Node globals remain available, and a function body may declare a local `process`, including `const process = await import("node:process")`. A successful call returns its lossless-JSON value as `result.value` and captured text and images as ordered `result.output` entries. `result.sandbox` reports the selected mode, observed denial and the backend's full or partial enforcement independently of the program outcome.

`inspect(...values)` renders strings directly and other values with Node's `util.inspect`, without depth, array-length or string-length preview limits. Undefined properties, Error objects and circular references remain visible. Registered Images are emitted directly or when Node's formatting reaches them in nested values, including Map entries, Set values and enumerable Symbol properties. Custom inspection methods determine which nested values are visited. Text and selected images follow argument order within the shared output budget. If object formatting throws, preceding inspected arguments remain visible. Each emitted text group ends in a newline; raw stream writes retain their original text.

All execution modes provide the complete native Node console, whose stdout and stderr writes enter the captured output. Model instructions say: "Use inspect(...values) to display output. Do not use console."

`run_code` sets `discardCompletion: true`: function return values and final expression values are omitted without JSON serialization, while inspected output remains visible. Direct runtime consumers receive the usual lossless-JSON completion unless they set this option.

Direct filesystem, network and subprocess operations remain Node operations, subject to the selected OS sandbox. Nested host bindings cross the control channel; PTC tool calls retain the registry's visibility, ordering, logging and approval rules. Running a program does not change the Session's standing policy or automatically replay it after a denial.

Set `executionMode: vm-script` to evaluate erasable TypeScript through `node:vm` Script. Top-level declarations and `await` work, for example `var fs = await import("node:fs/promises"); inspect(await fs.readdir("."))`. Top-level `return` and static `import`/`export` are not supported. The runtime awaits the final expression; its lossless JSON value is returned unless `discardCompletion` is enabled. Relative dynamic imports resolve from the supplied working directory. Script syntax is non-strict unless the program opts into strict mode; the context is not a security boundary, and Node access remains subject to the process sandbox.

`scriptPersistence: false` is the default: every call uses a fresh process and context, ignoring `stateOwner`. Set it to `true` to retain a context per owner under the lifecycle rules below. Top-level declarations, functions and object identities survive subsequent calls, including values initialized through top-level `await`. Function locals remain local. This option requires `executionMode: vm-script`; both settings accept the same syntax.

```yaml
- id: ptc-runtime
  config:
    executionMode: vm-script
    scriptPersistence: true
```

<a id="persistent-repl"></a>
### In-memory modes

The `persistent-in-memory` mode and Script mode with `scriptPersistence: true` retain state per owner. To retain a REPL, set `executionMode: persistent-in-memory` on the existing `@deepseek-ai/dsh-ptc-runtime-node` plugin; it runs the scoped REPL unless `replScoped: false` selects Node's REPL evaluator. All modes require `fs`, `subprocess`, `sandbox` and `sandboxPolicy` and apply the file sandbox policy at process launch. Enable it deliberately with a profile patch:

```yaml
- id: ptc-runtime
  config:
    executionMode: persistent-in-memory
```

Save the patch and pass its path to `dsh headless --patch <path>` in a composition with PTC tool presentation. The `per-call` mode and Script mode with `scriptPersistence: false` retain no program memory between calls. Changing the configuration reloads the provider and releases its execution resources. Packaged single-executable hosts use their embedded carrier by default; the host sends the selected program format and retention flag with each evaluation, so the embedded `process.js` bootstrap serves both per-call and retained execution. Remote script deployments use a `node-script` launch with `launch.bootstrapPath` pointing to this package's built `persistent-process.js`.

In REPL mode, each live Agent keeps its own process and top-level variables, functions, and imported modules across `run_code` calls and turns. Use `await import(...)` and `inspect(...)`; top-level `return` is not supported. A leading `{ ... }` is a statement block and can contain top-level await and temporary declarations; parenthesize an object expression to return it. Retained functions and saved tool methods call the current evaluation's bindings. All tool calls must be awaited; callbacks from a completed evaluation cannot invoke tools in a later evaluation. With `replScoped: false`, assignments to undeclared names create retained globals under Node REPL’s non-strict evaluation, `_` and `_error` are ordinary retained globals without interactive REPL result setters, and Node REPL declaration rules apply, including errors on redeclaring existing `let`, `const`, or `class` names; assign to a mutable binding or choose a new name.

In `persistent-in-memory` mode, call `registerEnvironmentInitializer(program)` before the first run is admitted to install REPL source that executes once per new environment. The runtime installs current bindings first and evaluates initialization separately from the user program, sharing the first call's deadline, cancellation and output limits. It discards the completion value and includes printed output in the result. New owners, owner-less execution, release and process loss create environments that run initialization again; ordinary calls reuse initialized state. Assigning to an initialized global does not trigger initialization. Initialization lines do not shift user-program locations. Other modes reject registration.

Initialization errors, cancellation, timeout or captured-output overflow prevent the user program from starting and terminate the environment before returning. Earlier external effects remain. Once the Host accepts initialization, user-program failures follow the ordinary retained-state rules below. The [runtime service](../ptc-runtime/README.md#choose-a-backend) defines registration and asynchronous unregistration.

With `replScoped` omitted or `true`, `persistent-in-memory` reports program format `scoped-repl` and compiles each call as a separate strict VM Script in one retained context. Each call starts with copies of the top-level bindings left by earlier calls and may declare any of those names again with any keyword; functions and still-running code from earlier calls keep their own bindings, and assignments that earlier code makes after a call starts are not copied into it. Assigning to an earlier name without declaring it, including one declared with `const`, changes only the copy seen by that call and later calls. The last top-level expression statement is the completion and a Promise completion is not awaited; top-level `return` is rejected. `eval`, `new Function` and WebAssembly compilation in the program context are rejected. Programs load modules only with dynamic `import()`, whose relative specifiers resolve from the working directory of the environment's first call; `require`, `module` and built-in module globals are not provided. A `var` declared inside a block is a top-level name of its call and carries to later calls like any other `var`. A `var` redeclaration of an earlier name starts from the earlier value, so one that does not run, after a throw or in a branch that is not taken, keeps that value. Uncaught callback exceptions and unhandled rejections fail the evaluation that created the callback while it is active and are otherwise discarded, without ending the process; a callback that throws a frozen or non-extensible object still ends the process, as in Node REPL. The [scoped REPL decision](../../../.agents/notes/implemented/architecture/2026-11-09-retained-ptc-scoped-repl.md) records the complete behavior and its comparison with Node REPL.

Memory is best-effort and never saved to disk. Restart, Agent disposal, provider unload, protocol failure, output overflow, or process exit clears it. Missing variables raise normal reference errors; reacquire handles and recreate declarations. Exceptions in the active evaluation settle once and preserve earlier mutations. In REPL mode, exceptions from callbacks belonging to a completed evaluation are not reported in a later result. In Script mode, uncaught callback exceptions can terminate the retained process; await asynchronous work before completing an evaluation. The Session still records programs, tool dispatches and visible results; restoring a Session or forking an Agent starts with empty memory. Each evaluation resets the process working directory to its resolved cwd; program calls to `process.chdir()` do not persist across evaluations. Direct Node access follows the process launch policy. A retained owner cannot change mode, workspace root, or Session identity until its environment is released. Additional writable directories are fixed when the process starts: later grants and revocations apply only after release and recreation.

Service consumers pass an object as `stateOwner` to reuse its environment and await `release(owner)` when finished. Requests without an owner run in temporary processes. Their failures leave other owners' retained variables intact and do not report clearing them. Permission setters record the new mode synchronously. The runtime immediately invalidates affected processes and begins cancellation when the Session mode changes, including idle environments. The next program waits for their cleanup before starting; cleanup failure blocks that program and remains retryable. Permission-setting success does not mean old processes have finished stopping. A one-time approved escalation uses a separate environment and awaits its cleanup before returning; it cannot read the standing environment's variables or retain new declarations. Concurrent runs for one owner reject until execution and required cleanup complete; distinct owners may run concurrently. An idle environment has no expiration timer and keeps its process until release or failure. Raw stdout/stderr have no evaluation identity: bytes received during an evaluation share its output budget, even when written by an earlier child process; idle stdout is discarded and idle stderr retains only the bounded diagnostic tail. Await child-process completion before ending an evaluation. Process-exit diagnostics include the exit code and retained stderr tail; idle failures are written to the host logger. If process observation fails during cleanup, releasing the owner retries termination; new runs remain blocked until cleanup succeeds. Pipes that fail to drain after confirmed process exit produce a diagnostic but do not prevent releasing the environment.

### Deadlines and cancellation

For calls carrying a Session policy, a mode change cancels admission even while waiting for cleanup or process startup. Restoring the previous mode does not revive a canceled call.

The PTC consumer exposes per-call timeout and approved sandbox choices as described in [dsh-tool-executor-ptc](../../core/tool-executor-ptc/README.md). The runtime's readonly `timeout` descriptor reports its effective default and maximum to that consumer. The provider owns execution syntax, output syntax and state-retention guidance in `executionInstructions`. The tool consumer appends those mode-specific rules to its model-visible schema without inferring persistence from `programFormat`.

Omitting `timeoutMs` uses the configured elapsed default; numeric requests are validated and capped. Service callers can explicitly pass `timeoutMs: null` to omit the elapsed timer, as the workflow adapter does; `run_code` continues to accept only positive numeric overrides. An enabled deadline covers runtime setup and execution, including time awaiting nested tools or approval. It is not a CPU meter. Timeout results retain captured output and report `execution timed out before code started` until the program is submitted to the ready process, or `execution timed out during execution` afterward. Timeout or cancellation during retained execution requests cooperative revocation. Captured output produced after the stop request is discarded, including output from `catch` and `finally` handlers. Acknowledgment preserves the VM and variables, including earlier mutations. If the execution thread cannot acknowledge within `stopGraceMs`, or the acknowledgment fails, the host terminates the managed process range and waits for cleanup. The result remains `timeout` or `abort` and reports whether variables were preserved or cleared; timeout messages also report the elapsed budget. After confirmed termination, the next call creates an empty environment. Cleanup failure returns `worker-exit` and blocks reuse until host release succeeds. Startup timeouts, temporary execution stops and successful per-call completion terminate the managed process range immediately. The timer stops when an outcome is selected, before cleanup, so the returned call can take longer than its execution deadline while cleanup settles.

### Failures

Program parse errors and thrown exceptions are `exception`; deadline expiry is `timeout`; cancellation is `abort`; unparsable or oversized control traffic and invalid program messages are `protocol`; unavailable confinement is `sandbox-unavailable`; early process exit, lost control transport or failed managed cleanup is `worker-exit`. Control I/O failures retain the transport diagnostic alongside the observed process exit status. The substrate-independent failure name remains `worker-exit` for process providers. When completion capture is enabled, lossy values are `invalid-output`, and an oversized outer result is `output-limit`, retaining a fitting ordered text and image prefix alongside the diagnostic. Invalid or unsupported options and calls after disposal reject as caller misuse.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host owns policy, deadlines, binding lookup and process cleanup. The child owns program evaluation and binding proxies; model-written code is an untrusted peer even when its messages use the expected control descriptor.

`createExecution()` resolves the configured syntax, type erasure, model guidance and process lifetime once when the provider loads. The provider handles admission and cancellation. One execution owner creates temporary processes or reuses an enabled state owner's process; both use `ProgramWorker` for launch, deadlines, binding dispatch and cleanup. The child drops the experimental-feature warnings that the runtime itself triggers, for `vm.USE_MAIN_CONTEXT_DEFAULT_LOADER` and `stripTypeScriptTypes`, so they never enter program output; warnings that programs emit still print, and the host strips types without printing the `stripTypeScriptTypes` warning. The shared child loop selects `createProgramEvaluator()` from the evaluation data; async-function, REPL, Script and scoped REPL implementations expose globals, evaluation and cleanup independently of process lifetime. Initialization is awaited without adopting its completion value, followed by Host acknowledgement and the user program. The evaluator's completion callback settles the user program immediately; subsequent microtasks cannot log or invoke bindings. REPL diagnostics can also settle the active run. The scoped REPL evaluator also takes three creation options: `strict` (on), `codeGeneration` (off) and `finalExpression` (on). The runtime always passes their defaults, which the scoped REPL model guidance describes; the other values are kept by design for later configurations and tested in both states. Its redeclaration notice is likewise a reserved hook that prints nothing. The [scoped REPL decision](../../../.agents/notes/implemented/architecture/2026-11-09-retained-ptc-scoped-repl.md) records what each option changes.

### Launch and control

The host strips erasable types and, when starting a process, resolves the executable and bootstrap in the configured execution world, awaits argv confinement through `ctx.sandbox`, then spawns through `ctx.subprocess`. Cancellation is checked again after confinement, so a provider returning after cancellation cannot start the program. After adopting the inherited control channel, the child retains only executable-search, Windows system, and temporary paths in its OS environment and replaces the program-visible `process.env` with an empty dictionary. Named `node:process` exports are refreshed so imports also receive the empty environment. Windows ACL setup receives the parent's distinct `TEMP` and `TMP` values for shared grant locks, then replaces both with its private directory before starting the program. These native paths keep nested process creation and native temporary-file APIs functional. The host preserves `ELECTRON_RUN_AS_NODE` only for child startup so the Desktop executable runs the Node bootstrap; the bootstrap removes the selector before evaluating model code. The heap limit uses Node argv or a provider-created `NODE_OPTIONS` value for packaged executables; ambient loader and inspector flags are discarded.

Control traffic uses newline-delimited JSON on an inherited pipe separate from stdout/stderr. The RPC adapter bounds each message and queued native writes, rejects pending transport calls on closure, and runs no further methods after closure. Unsupported methods receive error replies. The host validates binding names and lossless JSON before dispatch.

The host calls the child's `run()` method over birpc on the ordered control pipe. Only one evaluation runs at a time; its asynchronous context prevents ended callbacks from starting new bindings or emitting captured output. RPC requests associate completions and binding replies with their callers. A new environment completes initialization through the acknowledged `initialized()` RPC before user code starts; the Host accepts only while the first run remains active, and the child rechecks cancellation after the reply. On timeout or cancellation after initialization, the host rejects new binding calls and late results, sends a one-way `revoke()` notification, and waits for the original `run()` response within `stopGraceMs`. Revocation rejects unfinished tool calls normally, allowing user `catch` and `finally` handlers to run. A validated response confirms settlement without changing the selected timeout or cancellation outcome. A missing, rejected or malformed response triggers termination. Callers must await settlement or fallback termination and cleanup before starting another evaluation. A blocked event loop cannot process revocation, so synchronous loops require process termination and lose retained state.

Timers, arbitrary user-created Promises, I/O callbacks, Workers and child processes have no per-evaluation cancellation guarantee. Stop acknowledgment waits for the current evaluation to settle; it does not establish cleanup of those resources. Unmanaged asynchronous work may mutate retained globals after acknowledgment; captured output and completion from ended evaluations are ignored. Await required work before returning and use host reset when resources cannot be trusted.

Per-call completion leaves unfinished binding waits pending and stops binding calls and captured output notifications. The child keeps the control pipe open until the host receives its result and closes the pipe. Output capture meters serialized logs plus the completion or diagnostic; fixed result-envelope fields and sandbox metadata are outside that ledger.

### Source and built bootstraps

Source execution loads an erasable-only bootstrap closure without relying on sibling built exports; its evaluator modules and installed Acorn and birpc dependencies must be available in the execution world. Built script execution uses `process.js` for every mode; `persistent-process.js` delegates to the same loop with a REPL default for hosts that omit program syntax. Embedded carriers launch their private worker through `launch.executable` and carry the program format and retention flag in each evaluation. A remote script deployment supplies the matching `launch.bootstrapPath`. `resolveLaunch()` selects the local default during construction; an explicit remote invocation never depends on whether the client itself is packaged. A host path is never assumed to name the same remote file.

Source containing `await` is checked for top-level await before native compilation, which can otherwise treat `await` as an identifier. Acorn parses an async wrapper, and acorn-walk traverses it using Node's REPL visitors, declaration hoisting and character-position edits. Computed class-method keys are traversed while method bodies remain separate evaluations. The transform boxes the final expression; the evaluator unwraps and awaits its value. Source that needs no lowering uses native compilation; submissions without `await` retain native syntax diagnostics. Syntax errors preserve the parser message and available source location and caret, without compiler or transformer stack frames. Dynamic `import()` expressions remain native and use the compiling Script's `importModuleDynamically` option. Both private process bundles include Acorn, acorn-walk and birpc; source execution imports the installed packages.

<a id="runner-import-handling"></a>
### Runner import handling

Runner code can pass a `ProgramImportHandler` to `runNodeMain()` or `runPersistentMain()`. The handler belongs to the child process and is independent of execution syntax; it is not a serialized host binding or a plugin configuration field. Scoped REPL programs use the VM Script handling for their dynamic imports. VM Script accepts synchronous or asynchronous decisions; AsyncFunction and Node REPL require synchronous decisions and reject a returned Promise. `node-script` and embedded launches enable `--experimental-vm-modules`; independently started runners need that flag to intercept VM Script and scoped REPL imports. AsyncFunction and Node REPL interception need no VM startup flag.

The handler receives each program's dynamic imports and, in VM Script, static and dynamic imports from VM-loaded ESM dependencies. Each request carries the specifier, import attributes and the importing file's absolute filename. Saved functions retain that filename even after cwd changes. The decisions are:

- `{ type: 'default' }` resolves and loads the requested module.
- `{ type: 'redirect', specifier }` resolves and loads the replacement specifier with the original attributes.
- `{ type: 'module', exports }` exposes own enumerable string properties as module exports, including a property named `default`.

Default and redirected imports resolve relative to the importing file; the replacement specifier does not reenter the handler. VM Script uses Node's ESM resolver with the runner's active conditions and flags, and loads `.mjs` files and `.js` files that Node resolves with format `module` through `SourceTextModule` in the Script context. Their static dependencies, re-exports and later dynamic imports consult the same async-capable handler. Each evaluator caches file modules by resolved URL, including module and handler failures; static imports bind once. A later evaluation reloads modules whose linking or evaluation failed because a previous evaluation ended, while successfully evaluated modules retain their identity. Modules retain `import.meta.url`, `filename`, `dirname`, `resolve()` and `main: false`. Other formats use Node's loader, as do all imports when no handler is supplied. A thrown or rejected handler value rejects the importing graph without fallback; unrelated graphs remain usable. VM Script rejects source-phase imports before calling the handler and rejects import attributes on VM-loaded ESM. AsyncFunction and Node REPL retain Node's native dependency and source-phase loading rules.

Export values can be arbitrary runner-local objects: prototypes, private fields, closures, cycles and synchronous methods retain their normal behavior. One exports object identifies one module per evaluator; names and values are captured once, while referenced objects remain mutable. Returning a different exports object creates another module. The handler is consulted on every dynamic import and each static request during linking. Module evaluation failures remain cached for that exports object. A callable `then` export follows JavaScript's dynamic-import Promise assimilation in AsyncFunction and VM Script; Node REPL rejects the resulting non-module value, so use another export name there.

AsyncFunction and Node REPL share synchronous `registerHooks` and a symbol-keyed global export bridge. A VM-compiled factory calls the native AsyncFunction constructor with Node's default loader, preserving strict function-body syntax and parameter bindings. Each evaluator and compilation filename has a distinct source URL so V8's constructor cache retains the correct import handler and referrer. REPL uses `AsyncLocalStorage` to distinguish evaluators sharing Node's cwd-based import URL. VM Script owns ESM loading and linking through per-module callbacks; Node retains evaluation state. Cleanup releases evaluator caches and removes hooks and bridges; Node retains natively loaded ESM namespaces and symbol registry keys until process exit. Imports started or resolved after a retained evaluation ends reject; temporary evaluations keep these imports pending until process exit. A saved function invoked by a later active evaluation can import normally.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node provider: common admission, cancellation and service delegation |
| [`src/config.ts`](src/config.ts) | Execution mode, validated limits and defaults |
| [`src/configuration.ts`](src/configuration.ts) | Retained-execution settings for profile editors |
| [`src/execution.ts`](src/execution.ts) | Mode selection, request resolution and temporary or retained process ownership |
| [`src/worker.ts`](src/worker.ts) | Shared process launch, evaluation deadlines and binding dispatch; `interruptEvaluation()` requests cooperative interruption, `terminate()` ends the process |
| [`src/persistent-process.ts`](src/persistent-process.ts) | Installed REPL-default entry delegating to the common child loop |
| [`src/evaluators/index.ts`](src/evaluators/index.ts) | Shared selection entry for the four evaluators |
| [`src/imports/vm-modules.ts`](src/imports/vm-modules.ts) | Script import decisions, recursive ESM linking and native delegation |
| [`src/imports/module-hooks.ts`](src/imports/module-hooks.ts) | AsyncFunction and REPL hooks, evaluator attribution and export bridge |
| [`src/evaluators/async-function.ts`](src/evaluators/async-function.ts) | AsyncFunction: strict async function bodies |
| [`src/evaluators/repl.ts`](src/evaluators/repl.ts) | Node REPL: interactive declarations and retained context |
| [`src/evaluators/vm-script.ts`](src/evaluators/vm-script.ts) | VM Script: Node globals, declarations and Promise completion |
| [`src/evaluators/vm-script-await.ts`](src/evaluators/vm-script-await.ts) | VM Script top-level await lowering and retained declarations |
| [`src/evaluators/scoped-repl-evaluator.ts`](src/evaluators/scoped-repl-evaluator.ts) | Scoped REPL evaluator: context options, module globals and imports, completions and REPL-style asynchronous failures |
| [`src/evaluators/scoped-repl.ts`](src/evaluators/scoped-repl.ts) | Scoped REPL scope chain: bindings copied between programs, declaration scanning, source generation and Script compilation |
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

- **Recursive import handling covers explicitly declared file ESM** — CommonJS, inferred ESM, TypeScript, data URLs and other native-loaded formats retain their own dependency loaders. Static imports of native modules use synthetic exports captured at evaluation; dynamic native imports retain the original namespace. VM-loaded ESM instances are separate from Node's native module cache and share the Script globals.
- **Confinement inherits the selected backend's limits** — full and partial enforcement are reported separately; sandbox policy and managed-process containment are distinct guarantees.
- **The heap cap is not a process-tree memory limit** — native allocations and descendant memory are outside the V8 old-generation bound. No process-tree CPU meter is supplied.
- **Cleanup inherits subprocess observability** — escaped descendants on a fallback platform may remain outside the managed range; see the subprocess provider's stated limits.
- **Default execution is one-shot** — retained state requires `persistent-in-memory` mode or Script mode with `scriptPersistence: true`; no mode offers a yield/wait API.
- **Await lowering relaxes declaration semantics** — in transformed programs, top-level `let`, `const`, and `class` bindings are mutable and initialized to `undefined` before execution; the native temporal dead zone does not apply. Function declarations populate retained globals when execution reaches them, and a `var` declaration without an initializer resets its binding to `undefined`. Direct-eval declarations stay within that evaluation. Top-level `using` declarations are rejected; put disposable bindings inside a block. Runtime stack locations refer to the transformed source. Scripts that compile without lowering keep native semantics.
- **Failed native lexical initialization can reserve a name** — if a top-level `let`, `const`, or `class` initializer throws before initializing its binding, that name remains uninitialized in the retained Script context. Reading, assigning or redeclaring it fails; use a new name or release and recreate the environment.
- **Scoped REPL copies values when a call starts** — with `replScoped` omitted or `true`, assignments that earlier code makes afterwards stay invisible to later calls, and a `let`, `const` or `class` redeclaration cannot read the earlier value of its own name. A `var` redeclaration starts from that value, so `var count = count + 1` adds to it, also after an earlier `let` or `const` of the same name. Relative `import()` specifiers keep resolving from the environment's first working directory after a later call changes directory; relative file access follows the current directory. The `codeGeneration` limit rejects only the program context's own `eval`, `Function` and WebAssembly compilation and is no isolation: main-realm functions copied into the context, such as `setTimeout.constructor`, still compile code. Columns after the inserted completion on the final expression's line shift right by 17, programs that start with `#!` or contain `__$binding_` anywhere are rejected, and a surviving function keeps every value copied into its call. The [scoped REPL decision](../../../.agents/notes/implemented/architecture/2026-11-09-retained-ptc-scoped-repl.md) lists the complete behavior.
- **Script values can cross realms** — binding results, binding rejection classes and imported modules can use constructors from outside the Script context. `instanceof Array` or `instanceof Error` can be false for those values; use `Array.isArray` and the declared binding error class.
- **In-memory environments retain one process per live owner** — idle owners keep their process and heap until explicit release, owner disposal or failure. Fan-out can retain many processes; idle expiration remains deferred.
- **Output caps reject rather than retain every byte** — spill can preserve only the bounded result delivered by this provider.
- **Formatting allocates before output accounting** — complete object and TypedArray formatting can require much more memory than the retained output. The output budget does not cap these temporary allocations; exhausting the configured heap can end the run with `worker-exit`.
- **Bindings are bounded at transport admission** — control limits do not bound the memory a host binding allocates while producing its result.
- **Preinstalled bootstraps require a compatible protocol revision** — readiness rejects a missing or mismatched revision before dispatching code. Upgrade `launch.bootstrapPath` with the host; the runtime does not install remote bootstrap updates.
- **Image references live with the process** — every acquired image retains host metadata until the process terminates or its owner is released, including images that the program never displays. Long capture loops in retained environments accumulate these references.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [timeout discussion](../../../.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md#deferred-timeout-design) records open choices about yielding, total lifetime, approval wait accounting and process-tree CPU/RSS limits. Those choices do not alter numeric deadline defaults or the explicit no-deadline service option.

</details>
