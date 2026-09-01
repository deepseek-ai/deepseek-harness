---
description: "Worker-thread code execution for users and maintainers composing, sizing, or debugging the shipped TypeScript backend that runs each program in a fresh Node worker."
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-worker-thread

English | [中文](README.zh.md)

## Summary

`dsh-code-runtime-worker-thread` executes TypeScript programs for the [`dsh-code-runtime`](../code-runtime/README.md) seam: each program runs in one fresh Node worker thread with host-provided bindings callable as ordinary async functions, and the run returns `{ value, logs, error? }`. It is the shipped backend for PTC mode in `dsh-tools`, so mounting it is what makes model-written TypeScript execution work in a composition. The runtime contains a program without isolating it: the trust posture is bash-equivalent, with an empty environment, a heap cap, measured busy-time and wall-clock budgets, and hard termination. Programs run once per request with no state carried between runs, and every failure — syntax error, budget expiry, abort, OOM exit, or output overflow — comes back as a result field.

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

Mount this backend with the code-runtime seam when a composition should execute model-written TypeScript programs; PTC mode in `dsh-tools` then drives it through `ctx.codeRuntime` whenever the model calls `run_code`. Every execution cap is validated config, so you can size the runtime for your deployment from `cordis.yml`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-code-runtime'
- name: '@deepseek-ai/dsh-code-runtime-worker-thread'
  config:
    computeMs: 60000            # busy-time budget (measured event-loop active time)
    maxWallMs: 600000           # wall-clock ceiling; never pauses for anything
    maxOutputBytes: 67108864    # combined serialized outer-output cap (64 MiB)
    maxOldGenerationSizeMb: 512 # worker heap cap
```

| Field | Default | Meaning |
|---|---|---|
| `computeMs` | `60,000` | Busy-time budget: the run fails with `timeout` once the worker's measured event-loop active time exceeds it |
| `maxWallMs` | `600,000` | Wall-clock ceiling, the backstop for waits that busy time cannot see; at most `2_147_483_647` |
| `maxOutputBytes` | `67,108,864` | Hard cap for serialized logs plus the completion value or failure message; at least `4` |
| `maxOldGenerationSizeMb` | `512` | Worker heap cap; overflow kills the worker and surfaces as `worker-exit` |

Every field is validated and defaulted at load; there are no other tunables. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-code-runtime-worker-thread) is the exhaustive source for every accepted field.

### What a run returns

A successful run returns the program's lossless-JSON completion value as `result.value` and the text it printed, in order, as `result.logs`. Top-level `await` and `return` work, and the program can call the host-provided binding functions (PTC mode exposes one `tools` object) as ordinary async calls.

### Containment, not a security boundary

A program runs with authority comparable to the bash tool: it can reach Node APIs, and the backend deliberately does not promise isolation from the host. What it does provide is containment — a separate isolate, an empty environment (no ambient credentials, no inherited loader flags), a configurable heap cap, and hard termination that also stops a hot synchronous loop. OS processes a program spawns survive `terminate()` and need deployment-level cleanup.

### What can go wrong

Every program outcome resolves as a result, so a failed run is a `result.error`, not a rejection: a syntax error or non-erasable TypeScript (`enum`, namespaces) fails as `exception` before any worker spawns; budget expiry is `timeout`; the abort signal is `abort`; a heap overflow or other worker death is `worker-exit`; a completion value that is not lossless JSON is `invalid-output`; and serialized output beyond the cap is `output-limit` — with the fitting captured log prefix retained. Rejection means caller misuse, such as a run submitted after disposal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the backend; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The backend rests on one separation: **containment, not a security boundary**. Model code has bash-equivalent trust (the [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) Trust posture), so the design optimizes for reconstructability and bounded resource use rather than for a hard multi-tenant boundary — that awaits a container-class backend. Each run gets one fresh worker, so a program's world dies with its worker: no cross-run state exists to leak or to log, and a run is reconstructable from the session log alone.

### Execution flow

A run is type-stripped host-side (`node:module`'s `stripTypeScriptTypes`, position-preserving), wrapped as the body of an async function so top-level `await`/`return` work, and sent to a fresh worker whose bootstrap materializes the binding namespaces. Binding calls cross the message port as lossless JSON and are answered at most once per call id. Log text streams to the host eagerly so a killed program still shows what it printed. Exactly one outcome settles the run — a `done` frame, a budget expiry, an abort, or worker death — after which the host terminates the worker and awaits its exit.

### Hostile-peer port

Model code can reach `parentPort` and forge traffic, so every inbound message is shape-validated and rebuilt field by field before anything reads it: forged extra fields never ride along, a non-number call id can never be echoed into a reply, binding names resolve as own properties only (a forged `constructor` cannot walk a prototype chain), and junk drops silently. Worker-side namespaces are null-prototype, so `__proto__`-shaped binding names are ordinary keys.

### Budgets

Two independent budgets exist because the peer is hostile: `computeMs` meters the worker's measured busy time (`eventLoopUtilization()` polling every 25 ms), so a hot loop expires it whether or not a decoy dispatch is in flight, while a program idling on a slow binding accrues nothing; `maxWallMs` backstops what busy time cannot see, such as a promise nobody resolves. Both funnel into `worker.terminate()`. `maxWallMs` is range-checked at load against `MAX_TIMER_DELAY_MS` because `setTimeout` clamps a longer delay to 1 ms.

### Output ledger

`maxOutputBytes` accounts the JSON serialization of the outer `logs` array plus the completion value or failure-message payload; fixed `CodeRunResult` field names and envelope syntax are outside that ledger. At or below the cap the exact value returns; a lossy completion is `invalid-output`, and a combined overflow is `output-limit` rather than a substituted inspected string. The failure retains a fitting captured prefix of the logs.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `WorkerThreadCodeRuntime`, run orchestration, output ledger |
| [`src/worker.ts`](src/worker.ts) | Source-mode worker entry (erasable TypeScript, no `lib/` dependency) |
| [`src/bootstrap.ts`](src/bootstrap.ts) | Worker-side bootstrap: namespace materialization, console shim, log capture |
| [`src/protocol.ts`](src/protocol.ts) | Port message vocabulary between host and worker |
| [`src/worker-json.ts`](src/worker-json.ts) | Worker-side lossless-JSON encode/decode |
| [`src/output-json.ts`](src/output-json.ts) | Byte metering and truncation for the outer ledger |
| — | No runtime invariant companion is published; this process-boundary implementation exposes no same-process event relation; worker protocol and built-worker tests cover it. |

### The worker entry, unbuilt and built

Source mode loads erasable-only `src/worker.ts` through Node's native type stripping; its transitive runtime closure contains only Node built-ins and relative source modules, so a fresh checkout never requires a sibling workspace package's unbuilt `lib/` export. Built mode passes the sibling `lib/worker.cjs` as a filesystem path because pkg's VFS Worker hook expects CommonJS; the same path works under ordinary Node.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the backend contract is not enough. They move from the seam definition to the consumer and the configuration surface.

- [Code runtime seam](../code-runtime/README.md) — the abstract contract this backend implements.
- [PTC mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) — how `dsh-tools` consumes `ctx.codeRuntime` and presents `run_code`.
- [Code runtime subsystem reference](../../../docs/subsystems/code-runtime.md) — request/result vocabulary, bindings, and failure taxonomy.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-code-runtime-worker-thread) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through PTC mode in `dsh-tools`, which renders the exact outer value when it fits or an explicit `invalid-output` / `output-limit` failure, while only the outer `run_code` result enters model context under its ordinary spill policy and binding traffic plus intermediate values remain execution-local.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **OS processes a program spawns survive termination** — `worker.terminate()` ends the thread only, weaker than bash-local's process-group kill; orphan cleanup is a deployment concern until a container backend exists.
- **Type-strip rides Node's experimental `stripTypeScriptTypes` API** — amaro or sucrase are the named drop-in replacements if the relied-on behavior shifts.
- **`computeMs` expiry can overshoot by up to one poll interval** — busy time is sampled every 25 ms (an internal constant, deliberately not config).
- **Programs get a five-method `console` shim** (`log`/`info`/`warn`/`error`/`debug`) — deliberately not Node's full console API.
- **Intermediate binding values have no byte cap** — a program can exhaust process or worker memory with a value that never becomes outer output.
- **The default 64 MiB cap is a rejection boundary, not recoverable storage** — outer spill can save only the bounded logs and diagnostic returned after `output-limit`; bytes rejected beyond the runtime cap never reach the spill layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
