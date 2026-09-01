# AGENTS.md — Web client stack

Rules for `packages/client/*` (the browser side of the dsh web GUI) plus its build entry `apps/web`. They supplement the repo-wide [conventions](../../AGENTS.md#conventions) and the [package rules](../README.md). Read the current [Web Client architecture](../../docs/subsystems/web-client.md), [Slots reference](../../docs/subsystems/slots.md), and [Conversation reference](../../docs/subsystems/conversation.md) before changing the corresponding layer.

Packages here are named with the directory prefix: `@deepseek-ai/dsh-client-<name>`.

## Slot and props discipline

The [Slots reference](../../docs/subsystems/slots.md) owns the current design; these are the rules you must not violate when writing or reviewing client code:

1. **One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? }, Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The shell alone renders `'root'`.
2. **children = declaration + authorization**: the slots your component renders are exactly the keys of your register call's `children` object (spec values: `kind`/`scope`). Rendering a slot you didn't declare, or declaring one someone else declared, fails at load — do not work around it; the conflict is the design speaking. Slot names mirror the composition path: `<domain>.<entry>.<hole>` (e.g. `'tool.call.toolview'`).
3. **Component props are the four shares, all derived**: `PropsRuntime<K>` (SlotMap: owner params + `useSession`/`sessionId` on session scope + global `useSessions`/`useWorkspaces`) & `PropsRenderSlots<S>` (children keys) & `PropsStore<H>` (store factory) & the inject face. Never hand-write a member a share already derives; never re-type a share locally.
4. **Hooks are framework-made only**: `useSession`, `useSessions`, `useWorkspaces`, `useStore`, `renderSlot` are the five standing seats, plus the `use<Name>` hooks the renderer binds from provide contributions and inject `hooks` compartments. Business code never creates a hook or selector as a prop value — pass plain data and callbacks. (Component-internal behavioral hooks that subscribe to nothing external are fine.)
5. **Live data has exactly three channels**: parent knows it → owner props at the renderSlot site; only the component knows it → local state; shared across entries or survives remounts → a store declared at register. Derived data is a pure function over framework-hook data (`useMemo`), never its own subscription.
6. **Stores: read `props.useStore`, write `props.actions.*`** — the declared actions are the complete mutation API. Write the store as an exported `createXXXStore()` factory (module-level handles are forbidden — de-facto singletons); share by passing one handle to several registers inside `apply`. Production code never calls the factory or `.create()` outside `apply`; tests do (that is the sanctioned zero-machinery path).
7. **inject returns plain data and callbacks** from the apply closure's own ctx — no hand-made hooks, no ReactNode producers, no whole-service objects. A registrant-private reactive fact uses the reserved `hooks` compartment (bare observables the renderer binds to `use<Name>`; components never see the sources). The plugin may use only the dependencies named by its `inject` declaration; there is no wider ctx to reach for.

## Reactive read and contract-currency discipline

How live data reaches render code, and what UI domains may share:

1. **Everything a render reads that can change outside React arrives through a framework hook** (rule 4 above). Event-handler code may read live snapshots (e.g. `keyboard.snapshot`); render code subscribes.
2. **Business components contain no subscription machinery** — no `useSyncExternalStore`, no manual subscribe wiring, no mirroring an external snapshot into local state or a second store. Give each reactive fact its owning channel instead: registrant-private → the inject `hooks` compartment; cross-entry or remount-surviving → a declared store; per-session standard → `sessions.provide`.
3. **Data-access ladder** — resolve needs in this order: framework hooks (standing seats + provide/inject-bound `use<Name>`) → a declared store (`useStore`/`actions`) → inject callbacks → anything else is a new framework extension point and needs main-thread arbitration.
4. **UI domains share only JSON-compatible data and callbacks.** Owner props, injected values, store state, and provide contributions are plain serializable data or callbacks over such data. The injected `hooks` compartment is the only place for bare observables, and components never receive those sources directly. Route ReactNode content through a slot; do not add ReactNode-valued owner props or injected members (the composer's existing `accessory`/`overlay`/`leftItems`/`rightItems` fields remain until they move to slots).
5. **An observable source keeps two identities stable**: the source object itself (hook binding is cached per source), and its snapshot between changes (`getSnapshot` returns the same reference until the fact moves).
6. **Whoever rebuilds a published value republishes it through the same source in the same step**, and a registration path that can run after consumers exist notifies the live consumers as part of registering.

## Export discipline (client plugin packages)

The `/client` entrypoint of a UI plugin package is its public browser API, not a convenience barrel. Three rules apply package-wide (do not restate them as per-file comments):

1. **A UI plugin exports no values beyond what cordis loading needs** — `apply` / `inject` (and `Config` where present), plus store factories consumed type-only by components (`ReturnType<typeof createXXXStore>`). Shared types (owner data, injected values, composed prop aliases) may also be exported. Implementation components, pure helpers, constants, and store handles stay internal. Adding any new value export requires user sign-off, not a matching consumer.
2. **Same-package tests import internals directly** — relative `../src/client/xxx.ts` from package tests, or the `./src/*` subpath where a spec lives outside the package. Never widen the public API to make a test compile.
3. **A feature plugin MUST NOT runtime-import or re-export another feature plugin's values, and MUST NOT declare `dsh.client.external` to obtain them.** Shared declarations use `import type`; behavior crosses packages through injected Cordis services, and UI crosses packages through slots. If neither fits, stop and escalate — do not add an export to unblock yourself. Shared runtime code belongs only in a narrow static owner such as `client/store`, `ui-primitives`, or a browser-safe utility package; transport and generated API assemblies keep their explicit infrastructure edges.

## ctx discipline (components never see ctx)

`ctx` belongs to the apply world only: the plugin body and the inject factories closed over it. Components — every `.tsx` under a feature domain — receive all data and callbacks **through the four props shares**; they never call a hook that reaches ctx, never import a service class to poke it, never read a React context (business components see zero contexts — `BindingContext` and its kin are renderer-internal). If a component needs something new, the answer is a prop threaded from its share's source (owner site, store declaration, or inject face), not a hook.

## Layering red lines

The stack has one-way knowledge, documented in the [Web Client architecture](../../docs/subsystems/web-client.md):

1. **Data object layer** (React-free): `client/connection` owns transport generations, `api/session-controller/client` owns `ClientSessions` → `SessionManager` → `Session`, `api/workspace-controller/client` owns Workspace state, and `client/store` owns the snapshot-store engine (`defineStore`, `createSnapshotStore`, `shallowEqual`). Store products are bare observable sources with no hook members.
2. **Render machinery** (`ui-renderer`, dynamic plugin): all ctx-to-React integration — slot renderer/outlets, `SessionProvider`, and the uSES adapter. Every hook is composed here at the binding site from bare sources; production business code carries no ui-renderer value dependency.
3. **Presentation components** (plugin packages' `src/client/`, pure props): consumables, expected to be rewritten wholesale. Business logic must not leak into them; everything arrives through the four props shares.

Non-negotiables across the layers:

- **Business data lives in the object layer, never a store.** Entry-declared stores carry shared viewing/interaction state (selection, drafts, panel widths); sessions, frames, and connections stay in the object layer.
- **rpcId is strictly bidirectional**: the initiator mints, the responder echoes, and minting stays in Connection ([unary Remote migration](../../.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md)).
- **Notifier publication discipline**: `notifyNow` is only the direct echo of a user gesture; structural updates use microtask-batched `markDirty`, while visible streaming chunks use cumulative `markFrameDirty`. See `../api/session-controller/src/client/sessions/notifier.ts`.
- **The web layer is pure presentation.** Nothing that is only "how to draw" enters the session log. Tool cards derive in the Client from raw call/result events and persisted result metadata; process-local control state uses its own snapshots and frames. Unknown or malformed tool data falls back to the generic form. A new *model-visible* input still requires a session event (repo-wide rule).

## Dependency declaration

Npm sections describe installation and development relationships; each build face independently decides what its artifact contains. [`verify-package-dependencies`](../../scripts/verify-package-dependencies.ts) checks and repairs these rules; [`verify-client-packages`](../../scripts/verify-client-packages.ts) owns Client loading and module requests.

1. **Every client package keeps Cordis in matching `peerDependencies` and `devDependencies`.** This includes the static packages because their Node face participates in the same Cordis plugin contract.
2. **A package under `packages/client/` is always covered; `dsh.client` marks a Client/Host package outside that directory.** Explicit include/exclude entries handle exceptions. Every covered package's Host entry is scanned, while a `./client` export alone does not select dependency policy.
3. **Browser and type relationships are development-only.** Client imports, type-only imports, module augmentations, TypeScript project references, `dsh.client.inject`, invariant companions, and metadata-only peers belong only in `devDependencies`. Configuration-only entries that Knip cannot infer from imports are listed in the dependency policy and projected into `knip.json` by `--fix`.
4. **Host value imports require classified exports.** A workspace value reached from the package's Host entry belongs only in `dependencies` when its exact module specifier and runtime export appear in `safeHostDependencyExports`. Exports whose identity or module state must be shared appear in `peerRequiredHostExports` and keep the whole package edge in matching `peerDependencies` and `devDependencies`. The verifier rejects unclassified exports before `--fix` writes manifests.
5. **Ordinary installed libraries stay in `dependencies`.** This includes private implementation libraries bundled into `lib/client.js` and bare imports left in a statically linked `lib/index.js`; the final Vite host, not the library build, merges and splits the latter.
6. **Browser and Node build faces declare externality independently.** A dynamic browser half uses the baseline plus `dsh.client.external`; a statically linked face externalizes every bare specifier; a Node face externalizes its production dependencies ([`tsdown.client.ts`](tsdown.client.ts)). Moving a name between npm sections must not silently change bundle contents.
7. **Keep the published payload closed.** Every relative runtime import and emitted asset must be covered by `files`; the repository publint pass checks the exact publication view.

## Build-time browser environment

Client business code may statically read `process.env.DSH_CLIENT_*`; every referenced value is public artifact content. The shared build-environment helper gives Vite and dynamic tsdown bundles the same build-process values, resolves unset names to `undefined`, and exposes no dynamic lookup or enumeration. A complete root build records the exact public values and a digest of all client artifacts; release and built-artifact consumers reject a missing or stale record. Use runtime configuration for choices that must change after build.

## Shared modules and the module graph

A dynamic browser half either carries a module privately or requests the shared module-table identity. The client baseline is centralized in [`web/src/platform.ts`](web/src/platform.ts): `PLATFORM_MODULES` names shell-seeded React, Cordis, and static Client libraries; `PRELOADED_CLIENT_EXTERNALS` is reserved for dynamic rows whose factories must arrive before shell boot and is empty when no such row exists.

1. **Baseline externals are implicit for every dynamic bundle.** Do not repeat React, Cordis, `client/store`, `ui-primitives`, or `ui-slots` in package manifests.
2. **`dsh.client.external` is not a feature-plugin dependency mechanism.** Only infrastructure, transport, or generated assembly may add a package-specific non-baseline value request whose dynamic row must be materialized through the module table. Declare the exact import specifier; only a trailing `/client` aliases the package row.
3. **Silence means a private copy.** Ordinary third-party implementation libraries may be bundled independently. A value reached only through `import type` is erased and creates no request.
4. **A request has two possible suppliers.** A dynamic package supplies its own row; `PLATFORM_MODULES` supplies an exact static-table key. There is no `dsh.client.provide` alias protocol.
5. **Validate both sides.** The dynamic build preset externalizes the baseline and rejects undeclared workspace value imports; [`verify-client-packages`](../../scripts/verify-client-packages.ts) rejects malformed or redundant requests, missing suppliers, and synchronous request cycles.

### The module graph sits below cordis DI

Three declarations read like dependency edges and none is interchangeable: Cordis service `inject`, module-graph `external`, and `dsh.client.inject` — the informational package-name edges of the [new-package checklist](#new-plugin-package-checklist).

| | Cordis service `inject` | module graph `external` |
|---|---|---|
| Unit | service name | module specifier |
| Timing | runtime; the fiber waits | materialization; the `require` handed to a factory is synchronous and cannot wait |
| Unsatisfied | stays PENDING, with no timeout | throws on the spot |
| Who may satisfy it | any plugin providing that service, replaceable | the single module identity, not replaceable |
| Cycles | allowed | rejected |

The seam is `loader.internal = modules`: cordis reaches plugin code through `EntryTree.import`, so every module request must be satisfiable before cordis can order activation above it. The modules node half emits rows in topological order, and `ClientModuleSystem.import`/`prefetch` recursively registers dynamic provider factories before their consumers materialize. This module order is independent from Cordis activation: a provider that injects services can register first and activate last.

`packages/client/web` is not a Loader entry. Its static imports seed `PLATFORM_MODULES`; parser-preloaded dynamic rows remain ordinary Loader entries and ordinary `lib/client.js` artifacts.

## Conversation Node discipline

- A Chat business feature registers one `ConversationNodeDefinition` and its keyed `conversation.chat.node` renderer; do not add its event switch or fold to `Session`, `SessionManager`, or a central built-in dispatcher. Follow the [Conversation reference](../../docs/subsystems/conversation.md).
- `match(event)` reads only the current `SessionEventLike`. Every scalar event or packed Assistant run in a multi-input Context carries or independently derives the same stable business id; `update` folds one Match into State and remains deterministically replayable by logical log `seq`. Packed rows are update-only, and a Definition that consumes Assistant deltas implements both scalar and `chunkrow/*` branches without expanding members.
- The append hot path and renderers never scan the full event window, Contexts, or Chat Nodes. Accumulate in State, publish same-Turn/Step facts through `buildLocationData()`, and consume final Node data or constrained Location hooks.

## Directory regime (plugin packages)

One UI feature = one plugin package (`src/client/` browser half). A multi-domain package splits where its code could later become separate packages — ui-conversation is the example: `contract/` (the only shared API), domain directories that never import a sibling domain, and `apply.ts` as the single cross-domain assembly point; `scripts/verify-client-domain-graph.ts` enforces the levels. Registration goes through `slots.register` in `apply` — never module-level side effects.

## Styling and localization

[docs/web-styling.md](../../docs/web-styling.md) is authoritative. Shared `--dsw-*` tokens and global sheets live in `ui-theme/src/styles/`; feature components consume semantic aliases through CSS Modules and `clsx`, with no literal colors, component library, or Tailwind. Code comments are English.

Every product-visible string—including text, accessibility names, tooltips, placeholders, status/unit formatters, and primitive chrome—lives in a typed locale dictionary and reaches components through the standard `t` seat or an already-localized prop. Cordis-free primitives require complete label props and own no fallback copy. Keep user/model/wire data and code tokens verbatim; internal matching uses discriminants or stable ids, never localized text. `pnpm run verify-client-ui-i18n` enforces source ownership ([decision](../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).

## Testing and coverage

The GUI test structure (three tiers, lane map) is settled in the [GUI testing system note](../../.agents/notes/implemented/process/2026-07-20-gui-testing-system.md); repo-wide policy in [docs/testing.md](../../docs/testing.md).

- Client source packages are inside the per-file 100% coverage gate (`pnpm run test:coverage`). Genuinely unreachable defensive arms take a `/* v8 ignore -- <reason> */` comment with a real reason, never a bare ignore.
- Component specs render with realistic props or a driven fixture runtime and assert user-visible behavior, not class names, hook internals, or render counts.
- The jsdom environment comes from a per-file `// @vitest-environment jsdom` pragma on the spec's first line; the shared config stays node-env.
- Each tier asserts its own layer. Data-layer semantics belong to the runtime and host suites; component specs cover presentation behavior.

## Before you push: the local check ladder

Run the narrowest rung that covers what you touched; escalate only when the change surface demands it.

1. **Every GUI code change** — `pnpm run test:gui` (seconds; no browser, no server): the client suites plus the host-side GUI packages. This is the inner loop; run it as freely as a typecheck.
2. **Any change that can alter the assembled browser or visible conversation/UI output** (client components or copy, `apps/web`, Vite, `dsh-host-webserver`, connection/handler/SSE) — additionally `DSH_SNAPSHOT=replay pnpm run test:web`: rebuilds the frontend dist, then runs the browser smoke pair (the real-host case self-skips without `DEEPSEEK_API_KEY`) plus the keyless replayed e2e scenarios. Linux PR CI uses the same read-only replay mode. Use `DSH_SNAPSHOT=refresh` only after confirming an intentional output change, or `DSH_SNAPSHOT=record` with a key to re-record fixtures.
3. **Before a PR** — use [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) to select the narrow checks for the outgoing diff; there is no repo-wide pre-push aggregate.

If `test:gui` is red on code you did not touch, neither silently fix nor ignore it: note it in your handoff so it lands in the next PR window's sweep.

## New plugin package checklist

Bringing up a new `packages/client/<name>` plugin package (ui-workspace is a complete example; ui-sidebar/ui-user-questions are minimal skeletons):

1. **Package skeleton**: `package.json` (`@deepseek-ai/dsh-client-<name>`, exports `.`/`./client`/`./src/*`/`./package.json`, optional `./invariant` only for an independent runtime relationship, `dsh.client` manifest, `files` list), `tsconfig.json` (extends `tsconfig.base.client.json`, one `references` entry per workspace dependency), `tsdown.config.ts` (`clientBundle(id, ['lib/types/index.js'])`, plus `lib/types/invariant.js` only when published), `src/index.ts` (empty node-half apply), optional `src/invariant.ts`, `src/css-modules.d.ts` when using CSS Modules, and `README.md` with the Model Experience section and the reason when no invariant is published.
2. **Three registration surfaces, all required** (missing any one fails at a different, later point): the `tsconfig.client.json` aggregate `references` entry; a `dsh.client` row in `packages/bundle/web-app/cordis.patch.yml`; a `packages/bundle/web-app/package.json` dependency (profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules` fallback, which mirrors the app's and each bundle's declared dependencies — a row whose package no manifest declares fails to import). `pnpm-workspace.yaml` already globs `packages/*/*`.
3. **dsh.client manifest semantics**: `platform: 'web'` always, and the declaration requires a `./client` export (the scan throws without one); `immediately: true` only for stage-one-prefetch infrastructure rows. `inject` lists package-name dependency edges — they are **informational only** (preflight display, HMR diffing); they do not sequence entry activation or apply order. Activation order is Cordis fiber inject waiting on *services*, nothing else. A non-baseline `external` request sequences its dynamic supplier ahead of the consumer — see [shared modules](#shared-modules-and-the-module-graph).
4. **Registering into another package's slot**: apply order is unconstrained, and a business service is not a declaration barrier. Use `ctx.slots.inject(name, () => ctx.slots.register(...))`; it waits on the actual declaration, removes the contribution when that declaration collapses, reruns after redeclaration, and leaves with the caller's plugin fiber. Return a generator yielding each registration when several contributions must install and roll back atomically. A bare `slots.register` into an undeclared slot remains an error; keep service edges only for services the contribution actually reads.
5. Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — the registry serves `lib/client.js`, not sources.
6. **Declaration decisions**, each settled by [dependency declaration](#dependency-declaration) and [shared modules](#shared-modules-and-the-module-graph): does the package ship a `./client` export; which non-baseline value imports require `dsh.client.external`; which Host value imports are ordinary dependencies; which Browser and type inputs are dev-only; and whether `files` covers every relative runtime import and emitted asset.

## New component checklist

1. Compose through register: add the slot to `SlotMap`, declare it in its parent entry's `children`, and register your component — see the [Slots reference](../../docs/subsystems/slots.md). No other composition route exists.
2. Type the props as the four shares (`PropsRuntime` & `PropsRenderSlots` & `PropsStore` & inject face) — derive, don't hand-write. Shared/surviving state goes in a `createXXXStore()` factory declared at register; component-private state stays local.
3. Component tests feed props directly (`createXXXStore().create()` for the store data; plain stubs for framework hooks) and assert behavior without render machinery.
4. Tokens only in CSS; product copy follows the localization rule above; English comments.
5. `pnpm run test:gui` green; if the component changes visible assembled output, also run `DSH_SNAPSHOT=replay pnpm run test:web`.
6. Non-trivial change? It needs an Agent Note in the same PR (repo-wide rule) — the GUI notes above are the precedents to extend.
