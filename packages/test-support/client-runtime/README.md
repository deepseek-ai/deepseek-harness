---
description: "jsdom slot test runtime for browser feature specs, for test authors exercising slots, stores, and rendering against production machinery."
kind: "package-library"
---

# @deepseek-ai/dsh-client-test-runtime

English | [中文](README.zh.md)

## Summary

`SlotTestRuntime.create()` lets Vitest suites drive production slots, stores, typed Session and Workspace fixtures, and local DOM assertions in jsdom. For plugin activation, reload, reconnect, and cleanup tests, `createClientTest` starts the web profile's bundle roster with endpoint-named Remote mocks, without a business Host. Missing services and unstubbed calls fail explicitly. The whole-client fixture owns startup and disposal; the local runtime provides idempotent disposal. Use this package through `devDependencies` for client tests; it is not a product plugin.

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

This package gives a browser feature spec a real runtime to mount against: create the bench, declare the slots your feature occupies, mount the feature plugin, render a slot, assert on the local view, and dispose — with no second implementation of production logic.

### Setting up a feature spec

`SlotTestRuntime.create()` assembles the runtime, `declare(children)` registers an auto frame whose per-key `<div data-slot>` wrappers become snapshot roots, `mount(plugin)` runs the feature on a real fiber, and `renderSlot(key, owner, opts?)` returns the slot-local view with scoped queries and in-place updates:

```text
const runtime = await SlotTestRuntime.create()
await runtime.declare({ 'feature-slot': {} })
const handle = await runtime.mount(FeaturePlugin)
const view = runtime.renderSlot('feature-slot', { owner: props })
expect(view.container).toMatchSnapshot()
await runtime.dispose()
```

`mount` prechecks required services and fails loud when one is missing — `provide(name, value)` supplies an extra service first. The runtime provides a `fileUpload` stub that rejects every call until a suite replaces `runtime.fileUpload.upload`. `storeOf(key, scopeKey)` returns the live store instance the renderer hands a slot's component for identity and action-driven-write assertions.

The optional render options select a keyed entry with `entryKey` or a list item with `only`; `view.update(owner)` retains that selection. `runtime.panelInfo` supplies the default `usePanelInfo` source with no global panel selected. Release it with `releasePanelInfoSource()` before mounting the production Layout owner. `dispose()` releases both default Workspace and panel-info root sources; early release is idempotent and does not remove replacement owners.

### Local DOM snapshots

A registered snapshot serializer folds CSS-module class hashes (`_frame_a1b2c3` → `frame`) so `.snap` files stay structural, and collapses `<svg>` internals to a `data-content` fingerprint. Suites needing a custom page frame use `root.declare(children, Frame)` instead of the auto frame; `dispose()` tears down views, feature fibers, minted scopes, and persisted store state on one axis and is idempotent.

### Scripting Remote answers and failures

`TestRemote` is the double for the `ctx.remote` face: it registers itself plus one service per scripted namespace so a plugin injecting `remote.<name>` unparks, drives `$on` subscriptions from an explicit test event driver, and exposes `$host` as a plain mutable field a spec assigns to script a homed or non-loopback Host. This package is also where a UI spec takes the `RemoteError` constructor as a value — the `dsh-api-remotes` facade cannot carry it, because a value import from a spec would pull that assembly's unbuilt `/remote` artifact chain.

Script a failure by the code the Host would answer with, and assert the same way production code discriminates — on `code`, never on the class:

```text
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

remote.goals.create.mockResolvedValue({
  ok: false,
  error: new RemoteError('goal/not-found', 'goal "g1" does not exist', { goalId: 'g1' }),
})
expect(view.getByRole('alert')).toHaveTextContent('goal/not-found')
```

### Whole-client tier

The slot tier above mounts one feature against doubles. The whole-client tier boots the real assembly: `TestClient.start(plan, mock, options)` imports every roster row's `/client` module in-process (or takes the plan's `provide` replacement), binds `{ rpc: mock.rpc }` to that client's Connection module, synthesizes the boot graph with `graphFromRoster` and hands the loaded modules to the production module system, boots through the production `bootClient`, optionally mounts `uiRenderer`, and waits for `ctx.connection.state === 'connected'`. It lives behind a deep import so slot-tier specs never load it:

```text
// @vitest-environment jsdom
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'

const test = createClientTest({ roster: webApp }, { mount: true })
test('registers into the sidebar', async ({ remote, start }) => {
  remote.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
  const client = await start()
  expect(client.ctx.slots.entries('sidebar.settings')).toHaveLength(1)
})
```

`createClientTest` uses native Vitest fixtures: each test gets a fresh `mock` loaded with `remoteDefaultResponses`, a `remote` proxy equal to `mock.remote`, and a `start()` that boots only after the test configures its responses. Repeated starts share one promise; await it to observe startup errors. Fixture teardown waits for startup, disposes the client even after a failed assertion, checks missing responses, and refuses a saved `start` after the test. Use `TestClient.start` directly for independently owned clients. These fixtures isolate their own state, not page globals such as `location`.

The [generic Remote proxy](../remote-mock/README.md#remote-proxy) supports every namespace in both tiers. An assembled test uses the `remote` fixture; a local `TestRemote` can receive `{ settings: mock.remote.settings }`. Configure returned data and read native `.mock.calls` directly. A mutation response does not update later describe answers automatically: change `remote.settings.describe.mockResolvedValue(...)` explicitly when the scenario publishes new data. The proxy documentation owns unbuilt typing and the required build-backed local typecheck.

### Roster and startup behavior

`webApp` is the `web` profile's browser roster, read when the assembly entry is first imported from its bundles (`dsh-base`, then `dsh-web-app`) as the launcher composes them, except that a patch matching nothing throws here where the launcher warns: each bundle's `dsh.bundle.patch` list is parsed with the include plugin's YAML dialect and composed by its `applyEntryPatches`, and every enabled row whose package declares `dsh.client.platform === 'web'` becomes a row carrying that declaration's `inject` and `immediately`; `bundleRoster(bundles)` does the same for any bundle list. Nothing is copied from the bundles, so a bundle change is visible at the next test run. `webApp.closure(names)` keeps the named rows plus everything they inject, transitively (the rows a spec needs to boot those plugins as the bundle composes them), `webApp.pick(names)` and `webApp.without(names)` cut it down by hand, all three throw on unknown names, and `ClientRoster.of(rows)` builds one inline. `remoteDefaultResponses` holds default responses for exactly the Remote endpoints the roster calls while booting with no sessions, no workspaces, and default settings; a spec layers its own `RemoteTable` on top with `mock.load(table)`, and any call without a rule fails the test at `dispose()` through `mock.assertNoUnmatched()`. `mount` requires a roster that provides `uiRenderer`; `start` fails loud otherwise instead of returning an empty container. `client.connection` is the roster's Connection service (no `Context` augmentation declares it), and `connectTimeoutMs` bounds the readiness wait, whose failure message lists the mock log. `reload(name)` rebuilds one Loader entry the way client-hmr does (registry-first teardown, then `entry.refresh()`); each client retains its own module system and instance-bound Connection replacement, so starts and reloads can overlap without changing a page global. `unload(name)` removes an entry and waits for plugin cleanup; `flush()` settles React inside `act`. jsdom implements neither `EventSource` (client-hmr opens one at apply) nor `ResizeObserver` (layout components observe size at mount), so `start` reference-counts inert stubs for whichever global is absent and `dispose` removes exactly those — a jsdom gap, not a client identity channel. The `@deepseek-ai/dsh-api-remotes` row is dropped from every roster: its generated Remote clients exist only in built `lib/`, and `remote.<ns>` is what the tier replaces anyway. `start` instead provides one contract-free proxy per `remote.<ns>` service the roster injects (plus the namespaces the mock has rules for at that point; a namespace first registered later has no proxy); `ctx.remote.<ns>.<method>(...args)` becomes a call on the endpoint `<ns>/<method>` carrying the positional args, a stream when the mock registered a `stream()` script and a unary call otherwise, with the generated client's outcome folding (`gateway/internal` for carrier throws, `gateway/cancelled` on abort). An endpoint without a rule is still dispatched, so the mock logs it and `dispose()` fails the test.

### When to use it

Use the bench for feature suites that exercise slots, stores, rendering, and disposal under a real runtime — the production `SlotRegistry`, renderer, and provide-bundle materialization are mounted, never reimplemented. It is client-side test infrastructure: it never reaches a model request, and feature packages depend on it in `devDependencies` only.

### What can go wrong

- **A declared service is not provided** — `mount` fails loud with the missing names; `provide()` them first.
- **A render is attempted before `declare`** — `renderSlot` fails loud; declare the key first.
- **A spec calls an unstubbed verb on a session behavior stub** — fixture stubs fail loud by design, so a missing stub surfaces at the call site rather than silently passing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the bench; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

The bench copies no production logic: it mounts the production `SlotRegistry`, production renderer, and `UiSession` adapter. `TestSessions` and `TestWorkspaces` implement the owner interfaces that features consume through Cordis, each fixture Session implements `SessionFace`, and `stubSettingsScope` implements `SettingsScope`. `UiSession` derives standard renderer sources from those Controller bindings. Unstubbed `ISession` behavior fails with the missing method name.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SlotTestRuntime` assembly, `TestRoot`, auto frame, `mount`/`dispose` |
| [`src/sessions.ts`](src/sessions.ts) + [`src/workspaces.ts`](src/workspaces.ts) | `ISessions`/`IWorkspaces` test doubles and `FixtureSession` behavior stubs |
| [`src/fixtures.ts`](src/fixtures.ts) | Plain fixture builders: conversation snapshots, workspace list state |
| [`src/snapshot.ts`](src/snapshot.ts) | DOM snapshot serializer (class-hash folding, `<svg>` fingerprint) |
| [`src/remote.ts`](src/remote.ts) | `TestRemote` double for host RPC, `RemoteError` value re-export |
| [`src/translate.ts`](src/translate.ts) + [`src/locale-env.ts`](src/locale-env.ts) | Translation and pinned-browser-language test helpers |
| [`src/settings-scope.ts`](src/settings-scope.ts) | `stubSettingsScope` with test-driven publications and a write spy |
| [`src/assembly/roster.ts`](src/assembly/roster.ts) | `ClientRosterRow`, `ClientRoster` (`of`/`closure`/`pick`/`without`), the `AssemblyPlan` it annotates, and `graphFromRoster` |
| [`src/assembly/modules.ts`](src/assembly/modules.ts) | Source `/client` imports and replacements, registered through the production module facade's pending factory queue |
| [`src/assembly/test-client.ts`](src/assembly/test-client.ts) | `TestClient`: instance-bound Connection, shared jsdom shims, `bootClient`, mount, readiness wait, `reload`/`unload`/`dispose` |
| [`src/assembly/vitest.ts`](src/assembly/vitest.ts) | Test-scoped `mock` and lazy `start` fixtures |
| [`src/assembly/remote-default-responses.ts`](src/assembly/remote-default-responses.ts) | `remoteDefaultResponses`: default responses of the Remote endpoints the roster calls at boot |
| [`src/assembly/remote-proxies.ts`](src/assembly/remote-proxies.ts) | Contract-free `remote.<ns>` proxies over the Connection: `remoteNamespacesOf`, `remoteProxiesPlugin` |
| [`src/assembly/bundle-roster.ts`](src/assembly/bundle-roster.ts) | `bundleRoster` and `webApp`: the browser roster read from bundle patch files with the include plugin's own schema and patch application |
| — | No runtime invariant companion is published; this test-support package owns no production event stream or mutable data — it assembles the runtime SlotRegistry and renderer (whose packages own their invariants) around test doubles; its own behavior is exercised by its package tests. |

### Lifecycle

`create()` builds a fresh context, mounts the slot and conversation registries, installs the renderer, and provides the session/workspace doubles plus the fail-loud file-upload stub. `mount` checks every declared injection against the context before starting the fiber, so a missing provider fails loud instead of suspending forever. `dispose()` unmounts React trees first, then disposes feature fibers, releases the root registration, disposes minted session scopes, and clears persisted store state; every public mutator is act-wrapped, so tests never handle SlotCore microtask batching or React `act` themselves.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the bench to the production machinery it mounts and the tests that use it.

- [ui-session](../../client/ui-session/README.md) — the production adapter that derives standard Slot sources from the Controller doubles.
- [UI slots package](../../client/ui-slots/README.md) — the `SlotRegistry` contract the bench mounts.
- [UI renderer package](../../client/ui-renderer/README.md) — the renderer the bench installs.
- [Testing policy](../../../docs/testing.md) — the coverage tiers and browser snapshot lane.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is browser-side test infrastructure; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how the bench is consumed. They are current package constraints, not a task backlog.

- **The whole-client tier does not run the generated Remote clients** — `remote.<ns>` proxies forward positional arguments without the generated zod validation, wire-name mapping, or scoped-identity injection; mock handlers receive those arguments directly, and the generated clients stay covered by the built-artifact e2e lanes.
- **Proxied calls bypass the Gateway client's `invoke` and `invokeStream`** — no `$mount` lifecycle check runs, stream failures are not re-marked through `normalizeConnectionStream`, and a unary rejection is folded by the proxy itself with the Gateway client's exported `carrierFailure` and `cancelledFailure`. `ctx.remote.$stream`, `$on`, and `$host` are the real Gateway client's.
- **An undeclared endpoint is dispatched as a unary call** — the proxy learns each endpoint's mode from the mock's registrations; a stream endpoint the spec neither scripts nor declares (`RemoteTable.streams`, `mock.stream(endpoint)`) is logged as a `unary` miss and product code receives a folded result rather than a failing stream. `remoteDefaultResponses` declares the roster's later-opened streams; `dispose()` fails the test either way.
- **The package's client compile program adds the `node` ambient types** so the roster reader can use `node:fs`; the slot-tier sources compile against them as well.
- **Session, Conversation, and Chat fixtures stay separate** — `sessionSnapshot` contains only Session Controller state, `conversationSnapshot` contains target-neutral Conversation state, and `chatSnapshot` contains Chat target state. Assembly tests provide Session event entries instead of adding Conversation or Chat fields to `SessionSnapshot`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
