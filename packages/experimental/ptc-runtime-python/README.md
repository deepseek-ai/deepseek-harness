---
description: "Run Python model code in fresh CPython processes under the shared filesystem sandbox, with configured resource budgets and async host bindings."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ptc-runtime-python

English | [中文](README.zh.md)

## Summary

Run model-generated Python in a fresh CPython 3.10+ process on macOS or Linux under the same file policy as TypeScript PTC. Programs can use top-level `await` and `return`, call configured bindings, and write normal stdout/stderr. Direct file operations follow the selected sandbox policy; resource budgets and process-group teardown bound execution. No state persists across runs, and no shipped profile enables this experimental runtime.

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

Choose this published experimental package only in an explicit composition. Register `PythonPtcRuntime` beside `dsh-tools`; `run(resolve(request))` executes each program in a fresh CPython 3.10+ subprocess, resolving with `result.value` on success and `result.error` on failure (the orthogonal `PtcRunFailure.kind` taxonomy classifies parse failures, thrown exceptions, invalid completions, output overflows, budget expiry, aborts, unavailable confinement, and substrate death). It rejects only for caller misuse, such as malformed bindings, unresolved execution options, or a call after disposal. Configuration is rejected at load: a non-Unix platform; an explicit `pythonBin` that is not an executable regular file or a bare name that does not resolve on `PATH`; a non-CPython, pre-3.10, or probe-failing interpreter; a non-positive or non-integer budget; a `maxLogBytes` below the truncation-marker floor (64); a timer value `setTimeout` would clamp; a budget larger than the effective fd-3 frame cap (lowered when the host heap cannot safely parse a near-cap frame); or an `addressSpaceMb`/output-budget pair whose worst-case peak would breach `RLIMIT_AS`.

The composition must supply `sandbox` and `sandboxPolicy` for this local execution host. `resolve(request)` accepts an explicit `sandboxPolicy` or resolves the shared deployment policy, and defaults `cwd` to that policy's workspace root. PTC mode supplies the calling Session's policy and directory. The configured `maxWallMs` remains the execution deadline; explicit `timeoutMs` overrides are unsupported.

`read-only` and `workspace-write` execute through the configured sandbox provider; `danger-full-access` explicitly bypasses confinement. `result.sandbox` reports the mode, observed denial, and the backend's full or partial enforcement separately from the program outcome. The [sandbox service](../../sandbox/sandbox/README.md) defines the file restrictions and backend limits; these modes do not restrict network access or arbitrary file reads.

The runtime advertises file confinement so `run_code` exposes `sandbox_permissions` and `justification`. Approval widens access for that complete program once; nested tools retain their own policies and approvals. Programs are never replayed automatically after a denial. See [PTC mode](../../core/tools/README.md#ptc-mode) for the consumer's escalation instructions.

The runtime supplies these execution instructions:

```text
Each call runs in a fresh Python process. Relative paths use the supplied working directory; only TMPDIR is set in the environment. Direct filesystem access follows this execution's sandbox policy.
```

### What you get

The package's default export is the `PythonPtcRuntime` plugin. Its public surface also re-exports the host-side protocol vocabulary: `validateChildFrame` (rebuilds every inbound frame), the lossless-JSON codec and meters (`encodeJsonPlain`, `checkDoneValue`, `hasUnsafeIntegerToken`, `hasNonLosslessNumber`), `logTruncationMarker` (the shared truncation-marker text), plus `resolvePythonBin` (interpreter lookup against the current `PATH`), `readProcessStart` (process-start statistics for tests), `detachResidual` (a test seam for the settled run's resource cleanup), and `hostFrameParseCeiling` (the heap-derived frame parse cap a given heap limit admits). Every cap is a validated `Config` field with a default: `cpuSeconds` (60), `maxWallMs` (600000), `addressSpaceMb` (512, not applied on Darwin), `maxLogBytes` (65536), `maxValueBytes` (32768), `graceMs` (3000), and `pythonBin` (`python3`, resolved, executable-checked, version-probed under a five-second force-kill deadline, and frozen at load). Each child receives only `TMPDIR`; ambient credentials, `PATH`, `HOME`, and other host state stay unavailable.

### The wire

Frames travel on the child's fd 3 as JSON-lines — one object per line — so stdout/stderr stay clear for the program's own output. Child → host: `boot-ack`, `call`, `log`, `done`. Host → child: `boot` (first frame, carrying every cap and the namespace declarations), `run` (after `boot-ack`, carrying only the program body), and one `reply` per `call`. A forged frame can carry both `value` and `error` on `done`, so a consumer must check `error` first and ignore `value` when it is set. A `log` frame's `open` flag marks an unterminated line committed by an explicit flush: the host appends the next log frame to the same entry, so `print('a', end='', flush=True); print('b')` reads back as one `'ab'` entry rather than a fake newline (the split-billing arithmetic lives in the fd-3 protocol Agent Note's wire-contract section). The one exception to merging is truncation: when a later over-budget frame trips the ledger, the already-billed prefix is committed as its own entry and the truncation marker follows it (the marker stays last, with no re-charge).

### What can go wrong

Required confinement that cannot be established returns `sandbox-unavailable`; the runtime never retries unconfined. An operation denied by a working sandbox remains a program failure with `sandbox.denied` set when its diagnostic matches the selected backend. A caught denial need not appear in this diagnostic flag.

Host-side validation drops junk without throwing, so a malformed or forged frame never crashes the host process: `validateChildFrame` returns `undefined` for anything that does not rebuild cleanly, a non-number call id can never be echoed into a reply, and forged extra fields never ride along. A completion value that is not lossless JSON, or that exceeds the configured byte budget, is rejected explicitly (`non-lossless` / `over-budget`) rather than silently rounded or truncated. An fd-3 frame whose raw length exceeds the effective frame parse cap (64 MiB, or lower when the host's configured heap cannot safely parse a near-cap frame — see `hostFrameParseCeiling`) settles the run as a `worker-exit` (the receive path caps raw frames before `toString`/`JSON.parse` so a compact wide frame cannot decode to far more host memory than its wire bytes admitted).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the backend; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One direction of trust: the host treats every inbound frame as hostile (model code can forge anything on fd 3) and REBUILDS it field by field before reading; the Python side trusts host replies. The bootstrap (`py/bootstrap.py`) runs the program as the body of an async function, so top-level `await` and `return` work; binding calls travel over fd 3 as JSON-lines and replies are paced across the pump so a flood of large replies cannot pin the host's fd-3 write buffer.

The shipped bootstrap and protocol sources reach the interpreter as UTF-8 JSON on trusted binary stdin, independently of sandbox temporary-directory mounts and locale text encoding. Model programs and binding traffic use fd 3. The host resolves the sandbox runner before spawning with only `TMPDIR` in the child environment. The wall deadline includes sandbox setup. The configured interpreter's load-time version probe runs outside confinement and executes no model code.

### Wire contract

The frames are `boot` / `run` (host → child) and `boot-ack` / `call` / `log` / `done` plus one `reply` per call (child → host). The `log` frame's `truncated` flag marks the frame that IS the child ledger's truncation marker, so the host stops capturing at the same point the child did instead of inferring it from its own budget. The `log` frame's `open` flag marks an unterminated line committed by an explicit flush: the host merges the next log frame into the same entry, so `print('a', end='', flush=True); print('b')` reads back as one `'ab'` entry rather than a fake newline (the split-billing arithmetic lives in the fd-3 protocol Agent Note's wire-contract section). The one exception to merging is truncation: the already-billed prefix is committed as its own entry and the truncation marker follows it (marker last, no re-charge). `done.error.kind` is one of `exception`, `invalid-output`, `output-limit`, or `timeout` from the CPU check after model code returns; wall deadlines, aborts, and substrate death are observed host-side.

### Lossless JSON crossing

Completion values and binding arguments cross as exact JSON: values serialize without recursion, so a deep payload below the byte budget survives instead of dying on `JSON.stringify`'s stack limit, and integral doubles beyond the safe range cross as exact digits rather than silently rounded tokens; the meters in `src/protocol.ts` enforce byte budgets and number losslessness before anything else reads the payload.

### Mirror alignment

`tests/protocol-mirror.e2e.ts` spawns a real `python3` and asserts, against `src/protocol.ts`, both `PROTOCOL_FD` / the truncation-marker text and each `TypedDict`'s required/optional wire field set in `py/protocol.py`, so a renamed or dropped field — or one side making a field optional the other requires — fails the test. Field *types* are not compared across the language boundary; that residue stays with review plus the backend's real-subprocess suite (`tests/runtime.spec.ts`).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `PythonPtcRuntime` — spawn, frame pump, budgets, containment, teardown; re-exports the protocol vocabulary |
| [`src/protocol.ts`](src/protocol.ts) | Host side: frame codec, hostile-frame validators, lossless-JSON meters, shared marker text |
| [`py/bootstrap.py`](py/bootstrap.py) | Child side: fd-3 channel, program execution, binding dispatch, ledger and settlement |
| [`py/protocol.py`](py/protocol.py) | Python side: `PROTOCOL_FD`, `TypedDict` frame mirrors, `log_truncation_marker` |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | Real-subprocess suite: budgets, containment, hostile frames, name rebinding |
| [`tests/protocol-mirror.e2e.ts`](tests/protocol-mirror.e2e.ts) | Cross-language mirror test against a real `python3` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the runtime contract is not enough. They move from the seam definition to the design record and the companion backend.

- [PTC runtime seam](../../ptc-runtime/ptc-runtime/README.md) — the abstract contract this backend implements.
- [fd-3 protocol Agent Note](../../../.agents/notes/implemented/architecture/2026-07-31-ptc-runtime-python-fd3-protocol.md) — design rationale and wire contract.
- [Settlement-fixes Agent Note](../../../.agents/notes/archived/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.md) — settlement, metering, and containment fixes and their regression cases.
- [Node process backend](../../ptc-runtime/ptc-runtime-node/README.md) — the released TypeScript sibling.
- [PTC runtime subsystem reference](../../../docs/subsystems/ptc-runtime.md) — request/result vocabulary, bindings, and failure taxonomy.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through PTC mode in `dsh-tools` when an explicit composition mounts this provider; it renders the program's completion value or failure into a retained `run_code` result, and no shipped profile mounts this experimental package.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the package does and does not cover; they are current package constraints, not a task backlog.

- **The cross-language guard covers the executed surfaces and the frame field shapes, not the field types** — the mirror e2e compares required/optional field sets, not that `cpuSeconds` is an `int` on both sides; a type-level drift is caught by review plus the backend's real-subprocess suite.
- **A descendant that escapes the child's process group with `setsid()` is not reaped by the group teardown** — `kill(-pid)` cannot reach it; the run still settles on the value the done frame decided, and the close-deadline backstop forces settlement if the orphan holds the pipes open, but the orphan itself outlives the fiber until it exits on its own.
- **A `log` frame that arrives after settlement is dropped** — once the run has settled, host-side capture is closed; a late fd-3 `log` frame (from a thread that outlived the done frame) is discarded rather than appended to `logs`.
- **A binding REPLY value has no seam-level byte or depth cap** — `maxValueBytes` meters only the done frame's completion value; a wide binding reply is rebuilt host-side (`snapshotJsonValue` traversal) and encoded whole, bounded on both sides only by process memory (like a binding argument, which has no child-side budget either).
- **No shipped profile mounts this provider** — the keyless `ptc-python-turn` snapshot replaces the headless PTC runtime through the real Loader; released profiles use the sandboxed Node process backend.
- **Workflow execution requires Node** — compositions using this Python provider disable `workflow-ptc`, `tool-workflow`, and `tool-ralph`; the workflow provider rejects an incompatible runtime when loaded.
- **Cross-channel log interleaving is backend-dependent** — Python stdout, stderr, and fd-3 log frames travel independently; each channel preserves its own order, while their total order in `result.logs` may differ.
- **CPython 3.10 or newer is required** — the configured executable is resolved and version-probed at load; unsupported interpreters fail before `ctx.ptcRuntime` is registered.
- **Execution is local and Unix-only** — the interpreter, working directory, and sandbox runner must belong to the host running this plugin. The provider uses POSIX resource limits and process-group signals; it does not support Windows or remote execution providers.
- **Sandbox enforcement inherits backend limits** — a successful program can report partial enforcement, and file confinement does not establish multi-tenant isolation or complete descendant cleanup.
- **Diagnostic prefixes omit the package's experimental qualifier** — the marker `[dsh-ptc-runtime-python] log capture truncated at <N> bytes` identifies this provider independently of its npm package name. The protocol mirror verifies identical marker bytes in TypeScript and Python.
- **`run()` is one-shot** — `logs` become available only after `PtcRunResult` resolves; there is no streaming-log or progress interface for output produced by a running program.
- **No state persists across runs** — every request executes in a fresh subprocess; a persistent REPL-style kernel stays deferred until a backend brings its own logging scheme.
- **An fd-3 frame whose raw length exceeds the effective frame parse cap settles the run as a worker-exit** — the cap is 64 MiB, or lower when the host's configured heap cannot safely parse a near-cap frame (`hostFrameParseCeiling`); `maxLogBytes`/`maxValueBytes` are load-bounded to the same cap so an honest child's frames always fit; a model-constructed binding ARGUMENT above the cap (a value with no seam-level budget) trips it too — an accepted residual of the OOM guard.
- **A child that stops reading its replies settles the run as a worker-exit once the reply backlog passes 1024 frames** — the host writes replies one at a time, waiting for `drain` when the pipe is full; a child that keeps sending calls without consuming replies would otherwise grow the retained backlog (and the binding results it pins) until the wall clock, so the backlog cap fails the run early. Binding results carry no seam-level byte cap, so this is a count bound, not a byte bound.
- **A child that floods calls against a binding that never settles settles the run as a worker-exit once 1024 calls are in flight** — binding calls are counted before dispatch and released when the async body settles, so a binding whose promise never resolves would otherwise accumulate one async closure per call frame until the wall clock. Like the reply backlog, this is a count bound, not a byte bound.
- **A combined log-and-value peak is not modelled by the load gate** — a model daemon thread that keeps writing while the completion value is metered and framed can add the two peaks in a way no gate admits or rejects; the run dies as `worker-exit`, containment holds, and only the failure classification is degraded.
- **CPU signal classification depends on the launcher** — the soft limit retains default `SIGXCPU` termination, including during native calls. A launcher such as bwrap can convert that signal into an ambiguous exit code, reported as `worker-exit`; a directly observed `SIGXCPU` is `timeout`. Only the CPU check after model code returns attempts a `timeout` frame before termination, and a busy or backpressured control channel can prevent that report. Kernel limits and the wall deadline remain in force.
- **A 1-second dual-limit `ulimit -t 1` CPU overrun is reported as `worker-exit`, not a timeout** — when the host starts under a hard CPU limit equal to the soft and that limit is 1, `_clamped` cannot lower the soft, so the kernel SIGKILLs the busy loop and SIGXCPU is never delivered; containment holds, only the classification is degraded.
- **No byte cap on intermediate binding values** — the implementation remains bounded by the lossless-JSON serialization cost and process memory, and a provider or executor may apply its own fetch cap.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
