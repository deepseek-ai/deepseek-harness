---
description: "jsdom slot test runtime for browser feature specs, for test authors exercising slots, stores, and rendering against production machinery."
kind: "package-library"
---

# @deepseek-ai/dsh-client-test-runtime

English | [中文](README.zh.md)

## Summary

`dsh-client-test-runtime` gives a browser feature spec a real jsdom test bench: it assembles a Cordis context, the renderer-owned slot registry, and the production `UiSession` adapter around typed Session and Workspace Controller doubles. Feature suites exercise declaration, registration, scoping, stores, injection, rendering, updates, and disposal without copying production renderer or adapter logic. Suites publish Session lifecycle state, Workspace state, projection values, and Conversation events through typed fixtures, then use local DOM snapshot roots, scoped Testing Library queries, and fail-loud service checks. It is not part of the product plugin graph (no `dsh.client`); feature packages depend on it in `devDependencies` only.

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

`SlotTestRuntime.create()` assembles the runtime, `declare(children)` registers an auto frame whose per-key `<div data-slot>` wrappers become snapshot roots, `mount(plugin)` runs the feature on a real fiber, and `renderSlot(key, owner)` returns the slot-local view with scoped queries and in-place updates:

```text
const runtime = await SlotTestRuntime.create()
await runtime.declare({ 'feature-slot': {} })
const handle = await runtime.mount(FeaturePlugin)
const view = runtime.renderSlot('feature-slot', { owner: props })
expect(view.container).toMatchSnapshot()
await runtime.dispose()
```

`mount` prechecks required services and fails loud when one is missing — `provide(name, value)` supplies an extra service first. `storeOf(key, scopeKey)` returns the live store instance the renderer hands a slot's component for identity and action-driven-write assertions.

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

### When to use it

Use the bench for feature suites that exercise slots, stores, rendering, and disposal under a real runtime — the production `SlotRegistry`, renderer, and provide-bundle materialization are mounted, never reimplemented. It is browser-side test infrastructure: it never reaches a model request, and feature packages depend on it in `devDependencies` only.

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
| — | No runtime invariant companion is published; this test-support package owns no production event stream or mutable data — it assembles the runtime SlotRegistry and renderer (whose packages own their invariants) around test doubles; its own behavior is exercised by its package tests. |

### Lifecycle

`create()` builds a fresh context, mounts the slot and conversation registries, installs the renderer, and provides the session/workspace doubles. `mount` checks every declared injection against the context before starting the fiber, so a missing provider fails loud instead of suspending forever. `dispose()` unmounts React trees first, then disposes feature fibers, releases the root registration, disposes minted session scopes, and clears persisted store state; every public mutator is act-wrapped, so tests never handle SlotCore microtask batching or React `act` themselves.

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

- **Vitest and jsdom only** — every consumer is an in-repository browser-oriented Vitest suite. The package is not a product plugin or a general Node test harness.
- **Session, Conversation, and Chat fixtures stay separate** — `sessionSnapshot` contains only Session Controller state, `conversationSnapshot` contains target-neutral Conversation state, and `chatSnapshot` contains Chat target state. Assembly tests provide Session event entries instead of adding Conversation or Chat fields to `SessionSnapshot`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
