---
description: "Browser half of dynamic Cordis packages for users and maintainers choosing, composing, or debugging how a page answers run requests and loads browser-half code."
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-client-runner

English | [中文](README.zh.md)

## Summary

`dsh-cordis-client-runner` lets a page run the browser half of a dynamic Cordis package: it answers the host's run requests, loads the browser-half source into the page as a live plugin, and removes it when the host retracts the run. A person approves or declines a run — or starts one directly — and the result this package reports back becomes the `cordis_run` tool result the model reads. Nothing loads at activation and nothing is restored after a refresh; a page runs a dynamic package only when someone answers a run request or asks for it here.

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

Mount this plugin in a web client whose composition also mounts the host runner — the host half runs in the process, this browser half in the page. When a dynamic package that has a browser half is run, the open pages receive a run request; this package carries out the load on this page, and the UI package (`ui-cordis`) renders the panel and cards a person uses to answer it. Host-only packages need no browser half and therefore no page: the host runs them itself.

### What the page does

A browser half is written in plain JavaScript — no JSX, no TypeScript, no module imports — and runs as an async function. It receives a fixed set of names — `React`, `console`, `styles`, and `host` — while browser globals like `fetch` and `setTimeout` are unavailable. The plugin it returns can use the lifecycle verbs and only the services it declared in its own `inject`. Calling `host.call(method, args)` from the loaded half reaches its own host half. A crash that happens while React renders the loaded half is reported to the host with the slot, whether the crash removed the entry, and a message written for the author.

### What the run surface offers

A run surface can answer a pending host request — approving it, optionally covering future versions of the same plugin, or declining it — and can start a definition at the user's own gesture, which authorizes it. Each definition has at most one in-flight activity, so an affordance built on that state survives a remount. What the surface shows about this page is page-local: the last render crash per package, why this page's own attempt failed, and whether a package is loaded here — never the host's view of what is running.

### Lifecycle boundaries

Loading is idempotent: asking to load a revision this page already runs changes nothing, a newer revision replaces the loaded one, and the same revision after a retract loads afresh. Operations on a definition serialize. A refresh starts clean by design — the host still holds the definition, this page does not run it until asked again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the browser half; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The browser half is built on one principle: a dynamic package must ride the same activation gating, fiber-effect cleanup, and status projection as a static one. The evaluated plugin is seated in the module table and mounted through `loader.create`; unload is entry removal plus factory invalidation plus style removal. The guard is a whitelist — lifecycle verbs plus declared services — that mirrors the host-side sandbox facade, so a package author meets one contract on both halves. One observer feeds two outlets: the slot registry's entry-error seam is watched only here, and a crash belonging to a package this runner seated goes upstream to the host for the model and onto this package's own `renderFailures` for the panel.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: runner, orchestrator, inspect registry, forwarded-event subscription |
| [`src/client/runtime.ts`](src/client/runtime.ts) | Load engine: convergence by run identity, guarded mount, retract |
| [`src/client/orchestrator.ts`](src/client/orchestrator.ts) | Run orchestration: host half first, source fetch, browser half, one resolution |
| [`src/client/evaluator.ts`](src/client/evaluator.ts) | Closure evaluation: the symbol surface and its teaching traps |
| [`src/client/guard.ts`](src/client/guard.ts) | The whitelisting `ctx` façade for loaded browser halves |
| [`src/client/inspect-registry.ts`](src/client/inspect-registry.ts) | Client Inspect Providers and the pending-query router |
| [`src/client/providers.ts`](src/client/providers.ts) | First-party client Inspect Providers (slots, theme, events) |
| [`src/client/timer.ts`](src/client/timer.ts) | The client timer service dynamic packages inject |

### How a run is carried out

A `cordis/request-run` event asks this page whether to run a definition. Whoever answers — the page after an approval, or the user pressing run — drives the orchestration: the host half first (so a host-half failure short-circuits before the browser has moved), then the source fetch, then the browser half, then one resolution carrying what happened. The browser half's source is evaluated as an async function body with the symbol surface as parameters, the returned plugin is guard-wrapped and mounted through the loader, and the resolution reports the loaded revision or the failing stage with the closure's, guard's, or fiber's message. `host.call` routes through the Remote namespace; an omitted argument travels as `null`, and a payload the generated codec refuses becomes a teaching error naming the call and the contract.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the browser half to the host that asks it, the tools whose runs it answers, and the surface that renders it.

- [Host runner](../cordis-host-runner/README.md) — the registry and run round trip this package answers.
- [Tool package](../tool-cordis/README.md) — the model-facing tools whose run requests reach this page.
- [UI package](../ui-cordis/README.md) — the panel and cards that operate this face.
- [Extensions subsystem](../../../docs/subsystems/extensions.md) — the generated `ctx.dynamicCordisRunner` API and `cordis/*` events.
- [Dynamic client render and attachment ownership Agent Note](../../../.agents/notes/implemented/architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md) — how browser plugins own their rendering and CSS.
- [Client shells and dynamic packages Agent Note](../../../.agents/notes/implemented/architecture/2026-08-15-client-shells-and-dynamic-packages.md) — package placement and build faces for the client halves.

-----

<a id="model-experience"></a>
## Model Experience

### Run resolution, when a model asked for the run

#### What the model sees

This package contributes no tool, prompt, or context of its own; the first thing it authors that reaches a model is the resolution it sends back for a `cordis/request-run` round trip, which the host turns into the blocked `cordis_run` result. A success carries the loaded revision and, for a browser half parked on services this page does not have, their names. A failure carries one reason — `rejected` when the user refused, `host-half-failed`, or `client-half-failed` — and, for the browser half, this package's own text: the failing stage (`evaluate`, `module-import`, or `activate`) followed by the closure's, guard's, or fiber's message. The guard's teaching errors (an undeclared service, a shadowed browser global, a plugin that returned no `apply`) reach the model through exactly that field. A crash that happens later, while React renders the loaded half, travels the separate post-settle path below.

#### Token effect

Conditional and bounded: at most one resolution per run request, spent inside the `cordis_run` tool result the host already emits. The text is data-dependent (a definition's own error message) and this package retains nothing across requests — a page's later load failures are page-local diagnostics with no model-visible carrier.

#### KV Cache effect

Append-only. A resolution reaches the model only as the tool result for the request that was already in flight, extending the history tail; nothing this package authors rewrites or reorders earlier request tokens, so an otherwise reusable prefix stays reusable. Repeated runs of the same definition each produce their own result rather than replacing an earlier one.

### Render failure, after the run settled

#### What the model sees

A browser half that loads cleanly can still crash when React renders it, and that crash lands after the run was answered — so the model would otherwise be told "ok" and never learn. Every entry-boundary crash of a package this page seated is sent to the host (`reportRenderFailure`) naming the slot, whether the crash retired the entry from its cell (`abdicated`: the package's UI is gone, not merely broken), and a message written for the author. The host keeps the last one per package, steers the owning session with it, and exposes it through `cordis_inspect_self`; nothing here reaches a run resolution.

#### Token effect

Conditional and bounded by the host's retention, not by this page: one report per crash, and the host keeps only the latest per package, so a repeatedly crashing entry costs the model one message rather than a growing list. The report never enters a tool result of its own — the model pays for it only when it is steered or asks.

#### KV Cache effect

None of its own. Reports travel over RPC and are stored, not appended to the conversation; the model reads them through a steering message or an inspection it chose to make, which extends the tail like any other tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the browser half needs special care. They are current package constraints, not a task backlog.

- **A refused resolution is not retried** — the acknowledgement of `resolveRequestRun` is not read, so when the host declines a stale success (`accepted: false`, because the definition's revision moved on while this page was loading) the page keeps what it loaded and does not orchestrate again. The request stays answerable — another page's answer or the caller's cancellation settles it — and the stop that bumped the revision retracts the stale load.
- **The plugin stays parked until the host namespace exists** — it declares `remote.dynamicCordisRunner`, so it loads no browser half whose host half it could never reach.
- **Slot admission has no carrier** — the dispatched row declares services, not target slots, so per-deployment allow or deny lists for slot admission have nowhere to ride.
- **Guard whitelists are hand-mirrored twins** — the browser guard replicates the host-side sandbox facade; sharing one specification is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The owned relation (a live Plugin's loader entry exists exactly while one Plugin Run ID is live) is browser-only state reachable through the client half's service, which the node-plane companion cannot observe. The relation is asserted by the package's own load/teardown coverage instead.
