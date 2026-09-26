---
description: "Host half of dynamic Cordis packages for agents and maintainers choosing, composing, or debugging the registry, sandbox, and run round trip."
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-host-runner

English | [中文](README.zh.md)

## Summary

`dsh-cordis-host-runner` exposes runtime inspection and keeps process-local dynamic definitions available to programmatic callers and browser controls. Host halves run in a `node:vm` realm; browser halves use the Client runner and approval UI. Definitions disappear on restart. Agents discover APIs through `tool-cordis` and install persistent bundles through Plugin Manager; no model tool creates dynamic definitions.

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

Mount this plugin for the inspection registry or programmatic dynamic-package lifecycle. Browser lifecycle consumers also require the Client runner and UI package. The shipped Creator workflow uses installed bundles instead of this definition registry.

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

Programmatic callers use `define`, `run`, `stop`, and `undefine`; the browser panel operates existing definitions. Host-only packages activate in this process. A package with a browser half waits for approval or cancellation, then loads Host before Client. `mode: "run"` starts the current version; `mode: "update"` replaces it. Stop disposes the live effects and retains the definition; undefine also forgets it.

### What happens to definitions

Definitions are session-scoped and process-local: other sessions read them as absent, and restart clears them. Historical logs retain tool arguments and receipts but do not restore the registry. Reloading a browser page requires another explicit run to load its Client half.

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

- [Tool package](../tool-cordis/README.md) — the read-only tools that use its inspection registry.
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

This package registers no tool or prompt. Programmatic `run` calls and browser controls can steer the owning session with outcomes and diagnostics; stop and remove gestures inject a user message. Shipped model tools cannot create or update dynamic definitions.

#### Token effect

Conditional and data-dependent: messages arrive only when an event occurs, and each carries a bounded description of what happened; there is no fixed per-request cost.

#### KV Cache effect

None of its own. A host half that registers tools changes the next request's tool view, which invalidates prefix reuse from the first changed schema token; running or stopping a package with no tool registrations is prefix-neutral.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the runner needs special care. They are current package constraints, not a task backlog.

- **A successful run does not mean the UI rendered** — React renders after the load receipt; failures reach the owning session through steering and appear in the browser panel.
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
