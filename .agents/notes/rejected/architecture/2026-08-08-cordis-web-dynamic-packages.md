# Agent Note: Cordis Host/Client Dynamic Plugin Runtime

Status: rejected — closed as a proposal: the shipped packages/extensions runtime and its READMEs own the design

English | [中文](2026-08-08-cordis-web-dynamic-packages.zh.md)

## Problem

The model needs to extend the current DSH process temporarily without modifying repository source, rebuilding the application, or refreshing the browser. An extension may run in the Host Node.js process, in a Client browser page, or as one plugin whose Host half retrieves data and whose Client half presents it.

This capability cannot be limited to “execute some code.” Before writing code, the model needs to discover the Services, Events, Builtins, Slots, and theme tokens available on both platforms. The user needs to preview the code before deciding whether Client code may enter the page. A single plugin needs immutable versions, retries after failure, and rollback. Asynchronous runtime errors need to return to the model instead of remaining only in server logs or the browser console.

Combining definition, approval, execution, version switching, capability discovery, and UI state into one action creates states that cannot be explained consistently: whether a successful definition also means a successful run; which version remains successful after a failed update; how long a Tool should wait when no page responds; which historical card owns the business UI after the same Package runs multiple times; and whether page-local Client load state can represent process-wide Host state.

## Proposal

### Core principles

- The Host is the sole process-wide authority for Plugins, Packages, Runs, approvals, and version pointers.
- The Client stores only the current page's approval interaction, load results, Slot contributions, business views, and page-local errors.
- Define creates only immutable code versions; Run activates only a defined version.
- A version switch commits `currentPackageId` only after the target Package completes its required Host/Client activation.
- Before writing code, the model queries capabilities through Inspect Providers. Inspect results assist coding and are not plugin runtime business data.
- Dynamic Host and Client code both use restricted plain JavaScript contexts and attach reversible side effects to the Cordis lifecycle.
- Client code requires user authorization before entering a page. Authorization may cover one Package or future versions of the same Plugin.
- Tool calls do not wait for approval or browser operations that may occur only after the current turn ends. State stores and model steering report asynchronous outcomes.

### Package responsibilities and dependency direction

Four packages under `packages/self-modification/` implement the dynamic runtime:

| Package | npm package | Responsibility |
| --- | --- | --- |
| `tool-cordis` | `@deepseek-ai/dsh-tool-cordis` | Registers the System Prompt, seven model-facing Tools, Host Inspect Providers, `@pluginId` context injection, and Tool presentation metadata |
| `cordis-host-runner` | `@deepseek-ai/dsh-cordis-host-runner` | Stores the authoritative Registry, allocates IDs, executes Host code, and manages versions, approvals, Runs, private handlers, Inspect routing, and model feedback |
| `cordis-client-runner` | `@deepseek-ai/dsh-cordis-client-runner` | Synchronizes Inspect manifests in the browser, orchestrates approved Host→Client activation, evaluates Client code, and manages the Guard, Loader/Fiber, timer, styles, and teardown |
| `ui-cordis` | `@deepseek-ai/dsh-client-ui-cordis` | Renders Define/Run Tool cards, the global Cordis panel, approval controls, version selection, runtime status, and Package-specific business views |

`tool-cordis` depends only on the Host Runner's in-process service and does not import the Client implementation. `ui-cordis` consumes only the Client Runner face and Client-safe wire types and does not import the Host implementation. Existing generated Remote APIs and forwarded events connect Host and Client runtime control; the gateway owns no dynamic Plugin domain logic.

### Domain objects

#### Plugin

A Plugin is a dynamic plugin instance that can be modified over time. It is identified by the branded type `CordisDynamicPluginId`, for example `clock-1`. When creating a Plugin, the model submits only a semantic prefix of 3 to 6 lowercase English letters; the Host appends a process-unique numeric suffix. The model cannot specify the complete `pluginId`.

A Plugin belongs to the Session that defined it. Model-facing Tools can read and operate only Plugins from the current Session. The global Client panel can list Plugins from all Sessions, but each action still executes under the owner Session carried by that row.

#### Package

A Package is an immutable code version under a Plugin. It is identified by `CordisDynamicPackageId`, for example `pkg-2`. It contains a name, a purpose, optional Host code, and optional Client code, with at least one code half present. Every `cordis_define` creates a new Package; an existing Package cannot be modified in place.

One Plugin may own multiple Packages, but at most one physical Run may exist at a time. Whether a Package contains a Host or Client half affects only its activation steps, not its version identity.

#### Plugin Run

A Plugin Run is one concrete activation attempt. It is identified by `CordisDynamicPluginRunId`, for example `run-3`. Every new activation attempt receives a new ID, including an attempt that fails after approval, a retry of the same Package, and a version update. `pluginRunId` associates approval, Host activation, Client loading, private RPC, Tool cards, and errors with the same attempt.

The Host stores the current physical Run separately from `latestRun`. The physical Run is the activation that can currently receive calls and be torn down. `latestRun` records the approval, phase, status of both halves, and diagnostics for the most recent attempt. A failed attempt may leave no live physical Run while remaining available for inspection.

#### Version pointers

- `currentPackageId` is the most recent Package to complete its required activation flow. Stopping the plugin, beginning an update, or failing an update does not clear it.
- `nextPackageId` is the target Package that is awaiting approval, activating, awaiting a Client, or most recently failed. It is cleared after the target succeeds and is committed as current.

A Host-only Package commits current after the Host successfully establishes its Fiber. A Client-bearing Package commits current after Host activation succeeds and at least one Client successfully establishes the corresponding load. A Fiber that Cordis parks as waiting because a hard dependency is absent is still a successfully established lifecycle object; it is not equivalent to a parse or `apply` failure.

If an update target fails, the old physical Run is not restarted automatically. The previous `currentPackageId` continues to identify the last successful version, and the failed target remains `nextPackageId`. The user or model can retry next, or reactivate current with `mode: "run"` to roll back.

### Host authority and persistence

`DynamicCordisRunnerService` and its internal Registry are the sole authority in the current DSH process. They store:

- each Plugin's Session ownership and immutable Package set;
- `currentPackageId`, `nextPackageId`, the physical Run, and `latestRun`;
- per-Package authorization and cross-version Plugin authorization;
- pending Client activation requests;
- Host Fibers, Package-private handlers, waiting Services, and recent diagnostics;
- Host and Client Inspect Registry directories and query routing.

These objects are not written to configuration or disk and are not restored after process restart. The Session Log may retain Tool calls, results, and metadata needed by cards, but it does not replay dynamic code to restore the Registry. Historical cards remain in the conversation after a restart, but their original `pluginId` and `packageId` are no longer runnable.

Runtime state is not written to Session projection as recoverable state. Refreshing a page or opening a new page does not automatically restore Client halves; automatic restoration would reintroduce connection identity, startup baselines, and cross-page consistency protocols, which are outside this design.

### Define, Run, and version switching

`cordis_define` has two modes: creating a Plugin submits `idPrefix`, while modifying an existing Plugin submits its exact `pluginId`. Code always uses `code: { host?, client? }`. Define validates arguments and plain JavaScript syntax, records immutable source, and returns the final IDs. It does not execute `apply`, create approval, change version pointers, or run implicitly.

There is no separate `cordis_update`. `cordis_run` expresses activation intent through `mode`:

| Version relationship | `mode` |
| --- | --- |
| No `currentPackageId` exists | `run` |
| Target equals current, including restart, retry, or rollback | `run` |
| Target differs from an existing current | `update` |
| Retry `nextPackageId` after a failed update | `update` |

Run first validates Plugin/Package ownership, the version relationship, and whether another transition is in progress. It then creates `pluginRunId` and writes `latestRun` and `nextPackageId`.

A Host-only Package completes Host activation within the Tool call and returns `running` or a failure synchronously. A Client-bearing Package does not wait for a browser outcome within the Tool call: without authorization it registers approval and returns `awaiting-approval`; with authorization it registers automatic Client activation and returns `starting`. Both results mean that the request exists, not that full activation succeeded.

When target activation actually starts, the Host stops the old physical Run before executing the target Host half. Only after Host success may the Client fetch and load source for the exact `pluginRunId`. Client success commits the version pointers. Any failure is recorded against that attempt, without restarting the old version and presenting it as target success.

`cordis_stop` tears down the current Host/Client Run and pending approval request while retaining the Plugin, Packages, authorization, and version pointers. `cordis_undefine` stops first and then deletes the Plugin, Packages, authorization, and version pointers; historical cards then show only that the Plugin was removed.

### Client approval and authorization

A Package containing Client code requires user authorization before its first activation because model-generated code will run in the user's page. The approval panel offers three actions:

- A single check authorizes the current Package. Later runs of the same Package do not need approval, but a new Package does.
- A double check authorizes future versions of the current Plugin. New Packages, updates, retries, and rollbacks no longer require per-version approval.
- Reject ends the current request without executing Host or Client code. The model must not immediately request approval again unless the user asks for it.

Authorization is written to the Host Registry when the user allows it and remains even if a later technical step fails. When the panel runs a Package directly, the user's click itself authorizes that Package.

A row awaiting approval shows only per-Package allow, cross-version allow, and reject; it does not simultaneously offer run, stop, or delete. The panel expands automatically when new approval appears. If auto-expansion fails or the panel is collapsed, the fixed entry and row status still show the pending approval count and state.

### Client activation orchestration

The Host sends Client activation requests through `cordis/request-run`. A request includes only request identity, Session, Plugin, Package, mode, name, purpose, and whether approval is required; it does not broadcast source code.

An authorized page executes the following fixed sequence:

1. Call `runHostHalf` to start the target Host half or bind to the same attempt's already-started Host Run.
2. After Host success, call `getClientCode` with `pluginId + pluginRunId` to retrieve only the exact current Run's Client source.
3. The Client Runner evaluates the plugin in the page, establishes its Loader entry/Fiber, and installs its Guard, styles, Slots, and page-local state.
4. The page reports success, waiting, or failure through `resolveRequestRun` or `settleUserRun`.
5. The Host accepts the report only for the still-current exact Run, commits current or saves diagnostics, and broadcasts request completion so other pages clear their activities.

Host activation precedes Client activation so that the Client does not start before required Host handlers exist. A page may tear down the Host Run after Client failure only when that request created the Host Run; a page that merely bound to an existing Run does not own it.

The Client Orchestrator stores pending approvals and active orchestration by `pluginId`, so one Plugin cannot run two page activations concurrently. Host inventory can reconstruct omitted pending-approval items and approval-free automatic activation requests.

Client load state is a page-local fact. An active Host does not mean that the current page loaded the Client half. The UI has three primary states: gray “Ready” when no physical Run exists, yellow “Client ready to activate” when the Host runs but the current page has not successfully loaded the Client, and green “Running” when both halves are available in the current page. Approval and failure appear as additional states.

This version does not establish per-connection identity or multi-page quorum. The first still-valid Client success may commit process-wide current; each page's store independently records whether that page loaded the Client.

### Package-private Client-to-Host communication

A dynamic Package uses a private JSON channel for Client-to-Host calls: the Host registers methods for the current Run with `harness.handle(method, handler)`, and the Client calls them with `host.call(method, args)`. Every call is associated with `pluginId + pluginRunId`, and the Host rejects stopped or stale Runs. Arguments and return values must be lossless JSON; functions, React elements, Contexts, Service instances, and class objects are forbidden.

This channel serves only Client-to-Host calls within the same Package. It does not use public Remote Services or `ctx.remote` in dynamic code. The public Remote interface carries only the Runner's own control protocol and does not expose dynamic Packages.

### Dynamic code, Guard, and lifecycle

Host and Client both execute only plain JavaScript function bodies, without TypeScript, JSX, or bundler transformation. The Host executes in `node:vm`; the Client evaluates in a restricted closure. These contexts reduce misuse and provide instructional errors, but they are not security boundaries against malicious code.

By default, the model reads an optional Service through `ctx.get('serviceName')` and checks for `undefined`. A plugin object declares `inject` only when the Service is a hard dependency whose absence must park the Package and whose later arrival must reactivate it. Direct `ctx.serviceName` access is allowed only when the same plugin declares the corresponding inject.

Host and Client `timer` are same-named Cordis Services with the same interface, not global Builtins. A plugin that needs timers must declare `inject: ['timer']`; a timer created inside a React effect returns its disposer as cleanup.

The current Fiber owns every registration and reversible side effect. Event listeners, Services, Tools, handlers, timers, Slots, styles, and theme overrides register through `ctx.effect()`, `ctx.on()`, or official APIs that return disposers. Stopping, updating, failure rollback, or undefining tears down both halves' contributions. Theme overrides are layered by source and return a disposer so unloading restores the previous theme values.

Host, DSH, Cordis, and their Service instances, Event payloads, Slot props, Session/Conversation Snapshots, Tool state, and other runtime objects are internal live data. Dynamic code must not run `JSON.stringify`, `structuredClone`, recursive enumeration, full copying, or whole-object display on these objects or their descendants. It reads only leaf fields needed by the current task and constructs minimal owned data without Host references.

### Inspect Providers and Catalogs

Capability discovery uses three Tools: `cordis_inspect_list` lists Host/Client Provider manifests; `cordis_inspect_query` executes an explicit read-only query on the selected platform; and `cordis_inspect_self` queries the current Session's Plugins, Packages, source, version pointers, and runtime diagnostics.

Host and Client each own a `CordisInspectRegistry`. A Provider registers a platform-unique ID, description, methods, input schemas, and output schemas. Provider methods are explicitly allowlisted queries, not arbitrary Service-method forwarding; the Registry has no layered target and does not automatically turn business Service methods into executable Inspect methods.

The initial Providers are:

| Platform | Provider.method | Data source |
| --- | --- | --- |
| Host / Client | `Service.listService` | Static Service Catalog for each platform |
| Host / Client | `Event.listEvents` | Static Event Catalog for each platform |
| Host / Client | `Builtin.listBuiltins` | Hand-maintained definitions beside the evaluator/Guard |
| Host | `Tool.listTools` | Tool Registry actually visible to the current Agent |
| Client | `Slots.listSubTree` | Static Slot Catalog plus the page's live subtree/occupants |
| Client | `Theme.listTokens` | Read-only inspect export from ThemeService |

When the Client Registry changes, it synchronizes the complete manifest to the Host without storing duplicate directories per Session. Host queries execute locally. For a Client query, the Host broadcasts a request ID and a page executes the local Provider and responds. The Host accepts only the first successful result that passes output-schema validation; a failed page does not settle the request. If no page succeeds, the Tool remains pending until a later success or Tool-call cancellation.

Inspect data is used only before code is written to confirm capabilities, signatures, types, and mounting protocols. A plugin that needs runtime business data calls the actual Service or listens to the actual Event; it must not cache, display, or depend on Inspect/Catalog results.

`CordisCatalogProjector` generates Host and Client Service and Event Catalogs separately through TypeRT. The Slot AST generator scans `SlotMap`, registration options, standard props, owner props, and referenced types; the Slots Provider merges the static Catalog with the live tree at query time. ThemeService exports theme tokens, Builtins are maintained manually beside the evaluator/Guard, and Tool schemas come from the Registry.

Catalog generation scans real source signatures and then applies a model-visible allowlist. The allowlist may hide Services, members, `@deprecated` APIs, Runner-owned Services, and `cordis/*` control Events, but it must not rewrite method names, parameters, or return types for the remaining APIs. Guard may reject arguments, fix sources, or hide members, but it must respect source signatures.

Model-visible owner JSDoc requires only a complete description, `@param` for every parameter, `@returns` for every non-void return, `@mode` for Events, and descriptions for Slot/props fields. Usage recommendations, counterexamples, and cross-capability choices belong in the Skill rather than duplicated Catalog example fields.

### Model guidance layers

Model guidance has four layers:

- The System Prompt carries the stable runtime model, restrictions of both platforms, lifecycle, approval, version pointers, minimum code rules, and a usage map for the seven Tools. It still supports a minimally correct implementation when the Skill is unavailable.
- The `cordis-plugin-development` Skill carries requirement navigation, capability composition, recommendations, and counterexamples without copying complete schemas.
- Each Tool description states only that action's prerequisites, parameter semantics, synchronous or asynchronous result, and next step.
- Provider/Catalog results supply current exact names, signatures, parameters, Slot props, tokens, and runtime query results.

The System Prompt requires loading the Skill first, then listing/querying capabilities, and only then defining/running code. React examples in the Skill register into a Slot instead of returning a React Element directly from `apply()`. Examples use `React.createElement`, correct `ctx.get()`/`inject`, reversible effects, and minimal JSON RPC.

### `@pluginId` and Tool UI

The input system registers an `@pluginId` mention for the current Session. Selecting it injects only Plugin identity, the default baseline Package, version pointers, the active Run, and the latest status, not source code. The default baseline is selected in order from next, current, and the most recently defined Package. The model must read source through `cordis_inspect_self` before appending a Package in existing mode; an invalid mention must not silently create a replacement Plugin.

The `cordis_define` card presents Host and Client code in two tabs. A `cordis_run` card associates with one exact attempt through `pluginRunId` and reads the Client store to show pending approval, Client ready to activate, running, failed, replaced by a later Run, or Plugin removed.

A Package may register `key: "self"` into `tool.view.cordis`. At runtime, self binds to `pluginId + packageId`; the business Slot key omits `pluginRunId`, while owner props still provide the exact Run identity. The newest Run card for a Package owns the business UI, and earlier cards show that a newer Run exists. Cards react to store changes rather than scanning later Session Log entries or notifying one another.

The global Cordis panel has one fixed entry and groups rows by current and other Sessions. Its title and collapse action remain fixed while only the list scrolls. A normal row can select a Package and run, stop, or delete it. A failed update can retry next or select current to roll back. A pending-approval row exposes only the two allow actions and reject.

### Errors and model feedback

Technical errors crossing Host and Client preserve the original `message` and preserve `stack` when the error object provides it. Structured diagnostics include `pluginId`, `packageId`, `pluginRunId`, and one phase: approval, host-load, host-apply, client-load, client-apply, or client-render.

Host and Client Guards, Host evaluation and handlers, Client evaluation and apply, Slot `onEntryError`, and React ErrorBoundary all return errors to the owning Agent. The Client console also prints the original error object through `console.error`. A rendering error belongs to the exact Run and does not contaminate the immutable Package.

After a model-initiated asynchronous Run succeeds, is rejected, or fails technically, `agent.steer` wakes the owning Agent. A technical failure requires the model to read diagnostics, correct the same Plugin, and retry autonomously. A user rejection forbids an automatic repeat request. A user's manual run, stop, or removal in the panel is supplied through context injection to the next step without waking the model proactively.

## Alternatives considered

**Combine Define and Run.** This removes the previewable “defined but not running” state and mixes syntax errors, approval, runtime errors, and retries into one action. The design therefore uses immutable Define and independent Run actions.

**Use Package ID as Plugin ID.** A single-level ID cannot append immutable versions beneath a stable instance; updates would require stop, undefine, and a new define, while historical cards and `@` references could not retain object identity. The design therefore uses separate Plugin, Package, and Run identities.

**Provide a separate `cordis_update`.** Update has the same loading, approval, UI, diagnostics, and execution semantics as Run, so a separate Tool would duplicate the protocol. It is represented by `cordis_run mode:"update"`.

**Automatically restore the old physical Run after an update failure.** Automatic restoration combines “target failed” and “old version succeeded again” into one result. The design retains the old current pointer without restarting it, so the user explicitly chooses to retry next or run current.

**Block `cordis_run` until user approval and the final Client outcome.** Approval or page interaction may only occur after the current model turn ends. Blocking would deadlock and occupy the Tool indefinitely when no page exists. The Tool returns immediately, while stores, Inspect, and steering report the final outcome.

**Broadcast source from the Host and wait for Client acknowledgements with a timeout.** Broadcasting sends source to every page before authorization. A timeout cannot distinguish no page, a slow page, and no user action, and the Host would need compensating rollback. The protocol broadcasts only metadata, and an authorized page fetches source for the exact Run.

**Automatically restore every Host-active Package when a page starts.** This requires connection identity, a startup baseline, and cross-page consistency. The design accepts page-local Client state and lets the user load again from the panel.

**Connect Package halves through public Remote Services or `ctx.remote`.** This exposes dynamic Packages through the product RPC interface. Package-private `harness.handle`/`host.call` is sufficient for Client-to-Host JSON calls and rejects stale requests by `pluginRunId`.

**Expose every Service method automatically as an Inspect query.** This turns capability discovery into a business-call proxy that bypasses plugin approval and lifecycle. Providers expose only curated read-only queries; the Service Catalog only describes business method signatures.

**Put the complete API in the System Prompt or Skill.** Static text drifts and consumes context. The System Prompt retains stable rules, the Skill provides requirement navigation, and Provider/Catalog results return exact signatures and runtime directories.

**Require Slot owners to register props schemas at runtime.** Slot props already exist in TypeScript types and JSDoc, so duplicate registration creates a second authority. The Slot AST Catalog extracts the static protocol and only merges the live tree at query time.

**Write runtime state to the Session Log and restore it during replay.** Dynamic code and Fibers are process-local objects. Restoration would require re-executing historical code and reinterpreting approval. The Session retains only model-visible records; the Registry and page Runs are not restored.

**Make historical Run cards scan later Session Log entries.** This couples Tool views to the complete log order and later message structure. The page card index/store already tells cards by Package when a later Run replaces them or their Plugin is deleted.

## Acceptance criteria

- A new Plugin can be created only from a 3-to-6-character lowercase English prefix; final Plugin, Package, and Run IDs are allocated by the Host and use branded types.
- `cordis_define` validates only parameters and plain JavaScript syntax and returns an immutable Package; one Plugin can append versions while old source remains inspectable.
- `cordis_run` strictly validates run/update; Host-only activation completes synchronously, while a Client-bearing activation returns `awaiting-approval` or `starting` without waiting for the final browser outcome.
- A single check authorizes only the current Package, and a double check authorizes future versions of the same Plugin. Authorization survives technical failure, while rejection executes neither half.
- The Host activates first and the Client then fetches source for the exact Run. A Client-bearing Package does not commit current before Client success, and current/next permit retry and rollback after failure.
- One Plugin has at most one physical Run at a time. Stop tears down both halves while retaining definitions and pointers; undefine deletes every Package, authorization, and state.
- The current page distinguishes “Ready,” “Client ready to activate,” and “Running,” and a pending-approval row shows only approval actions.
- `tool.view.cordis` self binds Plugin + Package. The newest Run card for a Package exclusively owns its business UI, while old cards and deleted Plugins have explicit fallback states.
- Host and Client Guards reject imports, JSX, undeclared Services, and unavailable globals. Services, timers, Slots, styles, Tools, handlers, and theme overrides are torn down with the Run.
- Package-private RPC permits only lossless JSON from Client to Host and rejects a stale `pluginRunId`.
- Inspect list returns Host and Client manifests together. Query calls only explicit read-only methods, and a Client query waits for the first schema-valid successful result or cancellation.
- Service/Event Catalogs are generated per Host/Client and apply allowlists. `@deprecated` APIs, Runner-owned Services, and `cordis/*` control Events are hidden from the model; Slot query merges static props with the live subtree.
- `cordis_inspect_self` returns layered Plugin lists, Package summaries, and exact source/diagnostics. `@pluginId` does not inject source and keeps updates in the same Plugin.
- Asynchronous technical failures, Host handlers, Client Guards, and React rendering errors preserve message/stack and steer the owning Agent; user panel actions only inject context into the next step.
- The System Prompt, Skill, Tool descriptions, and Provider/Catalog layers follow this Note. The Prompt remains sufficient to generate a minimally correct plugin if the Skill is unavailable.
- Relevant workspaces pass `pnpm run build`; implementation adds Host/Client lifecycle, versioning, approval, Inspect, Guard, Tool-card, and real-application snapshot coverage.

## Risks

- **A process restart loses all dynamic objects.** Historical Tool cards remain, but the Registry is not restored; the user must define again.
- **Multi-page state is not strongly consistent.** The first valid Client success may commit current while Client loading and rendering state still differs across pages. This version does not introduce connection identity, quorum, or page aggregation.
- **Client Inspect may remain pending indefinitely.** The Host stores the latest manifest, but without a page successfully executing the Provider it cannot present stale data as a live result. If every page fails, the request waits until cancellation.
- **Cross-version authorization expands trust.** A double check permits future Packages of the same Plugin without further approval. The UI must clearly distinguish per-Package and cross-version authorization.
- **A failed update can leave current pointing to an old version that is not running.** Current identifies the last successful version, not the physical Run. UI, Inspect, and prompts must show active, current, and next together.
- **Restricted contexts are not security sandboxes.** Host Services, files, commands, network access, and Client UI are real capabilities. Allowlists and approval reduce misuse but do not isolate malicious code.
- **Catalogs, Guards, and source can drift.** Generators, allowlists, and owner JSDoc must be maintained together. Guard hiding rules must not create a second signature.
- **Builtins require manual declarations.** React, harness, host, styles, and Context methods have no unified scannable source, so injection implementations and Provider definitions must share one maintenance location.
- **Provider output schemas currently permit broad JSON.** The first version prioritizes Provider ownership, input validation, and Host/Client routing; output schemas can become narrower later.
- **Host and Client Guards are parallel implementations.** Their available environments and Cordis type interfaces differ, so they remain separate. A shared specification should be extracted only if it removes code without obscuring security policy.
