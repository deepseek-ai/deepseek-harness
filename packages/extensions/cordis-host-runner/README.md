---
description: "Host half of dynamic Cordis packages for agents and maintainers choosing, composing, or debugging the registry, sandbox, and run round trip."
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-host-runner

English | [中文](README.zh.md)

## Summary

`dsh-cordis-host-runner` makes dynamic packages runnable in this process: definitions the model records with `cordis_define` stay here, host halves run in a `node:vm` sandbox, a package with a browser half waits for a person to approve or decline it on a page, and the model can inspect the live runtime and its definitions here. The model-facing tools live in `@deepseek-ai/dsh-tool-cordis`, and the browser half loads through `@deepseek-ai/dsh-cordis-client-runner`. Definitions live only in process memory, so a DSH restart clears them and nothing is written to disk. One config field, `vmTimeoutMs`, bounds synchronous sandbox evaluation.

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

Mount this plugin in any composition that should support dynamic packages — it powers the model's `cordis_*` tools, and packages with a browser half additionally need the client runner plus the UI package composed on the client side. The common path is explicit: load this package, optionally set `vmTimeoutMs`, and let the tools and the browser do the rest.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    vmTimeoutMs: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `vmTimeoutMs` | `5000` | Milliseconds the synchronous portion of a host half may run in the vm before evaluation is aborted |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-cordis-host-runner) is the exhaustive source for every accepted field.

### What a run does

A definition is recorded by `cordis_define` and activated by `cordis_run`. A package with only a host half activates directly in this process: its code runs in the sandbox. A package with a browser half becomes a request: it waits until a person allows or declines it on a page, or the asking turn is cancelled; the answering page then loads the host half first and the browser half second. `mode: "run"` starts the current package or restarts it, `mode: "update"` switches to a different package version. `cordis_stop` ends the live run — removing the package's handlers and any loaded browser UI — while keeping the definition runnable; `cordis_undefine` stops and forgets it.

### What happens to definitions

Definitions are session-scoped and process-local: a package is visible only to the session that defined it, other sessions read it as absent, and everything disappears on DSH restart. The session log keeps the define call's arguments — including the code it submitted — and the receipt; only the in-memory registry holds the parsed definition. A browser half reaches a page only through a run, so a reloaded page holds nothing until someone runs the package again.

### Trust stance

The sandbox isolates globals but is not a security boundary: Node globals are absent or redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers), and a host half receives a façade without framework internals, yet the services it declares reach the live runtime. Treat a dynamic package like bash access — see the [self-referential toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the runner; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The runner is built on two separations. **Registry and sandbox are one service.** The `DynamicCordisRunnerService` owns the definition registry, the vm sandbox, the host-half fiber lifecycle, and the invoke handler table, so a definition's whole life has one owner. **Versions are immutable packages.** A plugin holds packages that never change after `define`; `currentPackageId` and `nextPackageId` point at the running and target versions, and `mode: "run"` versus `"update"` encodes whether the target equals the current version. The browser round trip exists because a browser half can only be carried out by a page: the service emits a request, suspends, and is settled by the page's verdict, with the caller's `AbortSignal` as the only other exit.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: `Config`, registry wiring, lifecycle verbs, steer messages |
| [`src/registry.ts`](src/registry.ts) | Definition store: plugin and package identities, run attempts, approval requests |
| [`src/sandbox.ts`](src/sandbox.ts) | `node:vm` evaluation: globals, Node-API traps, define-time syntax precheck |
| [`src/guard.ts`](src/guard.ts) | Registration boundary: schema normalization, the sandbox `ctx` façade, plugin-shape checks |
| [`src/lifecycle.ts`](src/lifecycle.ts) | Starting a host half under the `cordis-dynamic` fiber group |
| [`src/inspect-registry.ts`](src/inspect-registry.ts) | The `ctx.cordisInspect` registry: host providers plus the mirrored client manifest |
| [`src/types.ts`](src/types.ts) | Client-safe payload shapes for the `dynamicCordisRunner` remote namespace and forwarded events |

### How a run flows

`define` trims and requires the metadata, prechecks each half's syntax by compiling it (running nothing), mints the plugin and package ids, and records the definition against the session that asked. `run` resolves the target against `currentPackageId` and `nextPackageId`; a host-only package evaluates in the sandbox and commits immediately, while a browser-half package arms an approval request, emits `cordis/request-run`, and suspends. The answering page walks `runHostHalf`, `getClientCode`, then `resolveRequestRun`; a success naming the live revision commits the activation and sets `currentPackageId`, and `cordis/request-run-resolved` drops the pending affordance on every other page. `stop` retracts the live dispatch — handler disposers, fiber dispose, and the `cordis/dynamic-retract` broadcast — and leaves the definition runnable. Four forwarded events (`cordis/request-run`, `cordis/request-run-resolved`, `cordis/dynamic-package`, `cordis/dynamic-retract`) are declared on the client-safe `./types` subpath and allowlisted for delivery by `@deepseek-ai/dsh-api-remotes`, which is what lets a browser reach them through `ctx.remote.$on`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the runner to the tools that call it, the browser half that answers it, and the generated surface.

- [Tool package](../tool-cordis/README.md) — the model-facing tools that call this service.
- [Client runner](../cordis-client-runner/README.md) — the browser half that answers run requests and loads browser-half code.
- [UI package](../ui-cordis/README.md) — the panel users approve and operate runs with.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-cordis-host-runner) — every accepted config field.
- [Extensions subsystem](../../../docs/subsystems/extensions.md) — the generated `ctx.cordisInspect` and `ctx.dynamicCordisRunner` API and `cordis/*` events.
- [Self-referential Cordis toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) — sandbox semantics, lifecycle, and composition rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Run outcomes, refusals, and diagnostics relayed to the owning session

#### What the model sees

Nothing directly: this package registers no tool and injects no prompt. It steers the owning session when a run settles — a success names the current package and says to continue, a user rejection says not to request the same activation again, and a technical failure names the reason, the version pointers, and the inspect-then-correct-and-update path. It also steers post-settle render failures (slot, whether the entry was removed), host guard rejections, and host handler failures. Panel stop and remove gestures inject a user-role message naming what the user did. Refusals from `run` or `stop` also reach the model through the calling tool's result.

#### Token effect

Conditional and data-dependent: messages arrive only when an event occurs, and each carries a bounded description of what happened; there is no fixed per-request cost.

#### KV Cache effect

None of its own. A host half that registers tools changes the next request's tool view, which invalidates prefix reuse from the first changed schema token; running or stopping a package with no tool registrations is prefix-neutral.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the runner needs special care. They are current package constraints, not a task backlog.

- **A successful run does not mean the UI rendered** — `run` returns once the answering page has loaded the browser half; React renders afterwards, so a component that throws cannot appear in the run receipt. The failure surfaces through steering and `cordis_inspect_self` diagnostics.
- **A browser-half package suspends where no page is connected** — headless and ACP deployments hold the run until the asking turn is cancelled; host-only packages are unaffected.
- **A suspended run request has no timeout** — it waits for a person until the asking turn is cancelled, so unattended automation cannot use packages with a browser half.
- **`vmTimeoutMs` bounds only synchronous evaluation** — an async host-half body escapes it, matching the toolset's cooperative trust stance.
- **A stale-success refusal leaves the request suspended** — when the answering page names a revision the registry has moved past, the resolution is refused (`accepted: false`) and the request stays answerable until another page answers or the caller cancels; the browser half does not read the acknowledgement.
- **The run announcement carries no service declarations** — a browser half's declared `inject` is read from the plugin it returns in the page, so `cordis/request-run` carries metadata only, never code or service lists.
- **`zod` is a runtime dependency of the generated Typert faces, not of `src`** — `./typert` and `./remote` resolve to unbundled `lib` files with a bare `import { z } from 'zod'`, so the package declares it even though nothing in `src` imports zod.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The definition registry is process memory with no event stream to observe, and its one owned relation (a running definition owns a settled host-half fiber and its handler table) is established and unwound inside single awaited verbs, so package tests assert it directly.
