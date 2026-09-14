# Agent Note: Whole-client test tier over an endpoint-named Remote mock

Status: implemented

English | [中文](2026-09-06-client-assembly-test-line.zh.md)

## Problem

Browser feature specs each hand-build their bench: a bare Cordis context, stand-ins for `locale`, `connection`, and `remote`, and slot declarations the real declarer would have made. Their assertions therefore describe the bench, not the product: a plugin that adds a settings section, a declarer that reloads through the Loader, or a Connection that reconnects is invisible to them, and every bench repeats the same forty lines with small drift.

API client specs drive their objects through a programmable fake of the Remote surface. The fake re-implements Gateway semantics it should only exercise: follow-stream opening snapshots derived from a history list, page cuts, stream pumps with delivery promises, and an envelope layer. Each of those is a second implementation of a contract the product already owns, and it lets tests describe behavior the generated client cannot produce, such as a unary call that rejects.

No focused source test boots the client the way production does — `bootClient` creating one Loader entry per manifest row, then `mountClient` — so composition faults between plugins are hidden by hand-built benches.

## Decision

A whole-client tier lives in `@deepseek-ai/dsh-client-test-runtime` under the deep import `src/assembly/`, and a new test-support package `@deepseek-ai/dsh-remote-mock` answers Remote traffic by endpoint name. Both are described by their READMEs ([client-runtime](../../../../packages/test-support/client-runtime/README.md), [remote-mock](../../../../packages/test-support/remote-mock/README.md)); this note records the decisions behind them.

**The roster is read from the bundles, never copied.** `bundleRoster(bundles)` parses each bundle's `dsh.bundle.patch` with the include plugin's own YAML dialect (`entryListSchema`, which carries `!!js`) and composes the layers with its `applyEntryPatches`, then keeps every enabled row whose package declares `dsh.client.platform === 'web'`, carrying that declaration's `inject` and `immediately`. `webApp` is the `web` profile's roster (`dsh-base`, then `dsh-web-app`), computed at import. A spec names what it tests and derives the rest: `webApp.closure([row])` keeps a row plus its transitive `inject` cone; `pick` and `without` exist for deliberate cuts. The test runtime stays a Client-face package: it imports no Host module, uses no dynamic import for this, and its client-face `types` adds `node` beside `client-build-environment` so the reader can use `node:fs`. `closure` treats the shell's static platform modules (`PLATFORM_MODULES`) as satisfied without a row.

**The production boot path runs with one Connection substitution.** `TestClient.start(plan, mock)` loads each roster row's `/client` module, replaces the Connection row's page-global adapter with `installConnection(ctx, { transport: { rpc: mock.rpc } })`, registers the resulting factories through the production module facade's `pendingQueue`, boots through `bootClient`, optionally mounts through `mountClient`, and waits for `connected`. `reload(name)` rebuilds a Loader entry through client-hmr's exported `tearDownEntryFiber`; `unload(name)` removes it; `dispose()` tears down and then fails the test on any endpoint that had no rule. jsdom lacks `EventSource` and `ResizeObserver`; `start` reference-counts inert stand-ins only where the global is absent. Module systems, Connection carriers, Remote mocks, reloads, and disposal are instance-owned, so clients start concurrently and do not coordinate through page globals.

The modules plugin reads the module system from its own `ctx.loader.internal` when it activates. Reloading the bootstrap row republishes that same instance without invalidating its bootstrap code, while another client's Loader and `ctx.modules` remain independent.

**`remote.<ns>` is a contract-free proxy, not the generated client.** The `@deepseek-ai/dsh-api-remotes` row is dropped because its generated clients exist only in built `lib/`. For every `remote.<ns>` a roster row injects, plus every namespace the mock has a rule for, the tier provides one Proxy: `ctx.remote.<ns>.<method>(...args)` calls the endpoint `<ns>/<method>` over the roster's own Connection with the positional args, as a stream when the mock registered a stream script for it and as a unary call otherwise. Cordis resolves `ctx.remote.<ns>` to the service `remote.<ns>`, so the Gateway client itself is untouched. A unary answer returns unchanged; a unary rejection folds the way the generated client folds a carrier throw, through the Gateway client's exported `carrierFailure` and `cancelledFailure`, so product code that fires a Remote call without awaiting sees no rejection. Stream items and failures pass through as the stream yields them.

**Native mocks own response configuration and call assertions.** Tests use `mock.remote.<namespace>.<method>` with `mockResolvedValue`, `mockResolvedValueOnce`, `mockReturnValueOnce`, or `mockImplementation`; the generated API supplies the signatures. Each mock instance owns its native response queue. Reusable tables register only default values or positional handlers, and each endpoint retains only its latest default. Stateful callbacks and deferred promises belong to individual tests. `ok` builds the success envelope. Streams require explicit declarations and can receive scripts over the opening args and a handle (`push`, `end`, `fail`); a declaration without a script produces a stream miss, while undeclared endpoints default to unary calls. Values are not validated. `mock.streams` controls scripted streams and exposes readiness/drain waits; `mock.log` records carrier calls (`pending`, `answered`, `failed`), scripted-stream state, first-argument `requests(endpoint?)`, and unmatched requests. `RemoteMock.create()` answers `$events` with a ready frame so the client can connect.

**Vitest owns each test's mock and client lifetime.** `createClientTest(plan, options)` adds native `mock`, `remote`, and `start` fixtures. The mock is fresh and carries the default responses; `remote` is its namespace proxy, and explicit `start()` leaves startup responses configurable and shares one startup promise within the test. Object-layer specs use `remote` directly when they do not need the Connection; cases requiring Gateway `$stream` call `start()`. Teardown waits for startup, disposes the successful client even after an assertion failure, checks missing responses, and rejects later starts. Callers await startup failures. Independently owned clients still use `TestClient.start`. Scenario data configures native mocks directly; returning a mutation response and updating subsequent describe responses remain separate actions.

**`remoteDefaultResponses` holds default responses for the boot-time Remote endpoints.** The table lists exactly the endpoints the `web` roster calls while booting and rendering with no sessions, no workspaces, and default settings, each row commented with its caller. A spec layers its own `RemoteTable` on top; a new boot-time call fails the spec at `dispose()`.

App-owned built-bundle tests install a fresh `RemoteMock` through `__DSH_TRANSPORT__` before `AppWebEntry` starts. Their scenario data stays under `apps/web/tests`; the production Connection package contains no scenario dataset or query-selected test transport. Browser cases that need Host behavior use `launchWebScaffold()` and the real HTTP/WebSocket path.

`mock.remote` uses native `@vitest/spy.fn` functions shared by direct callers and Connection dispatch. `MockedRemote` applies Vitest's deep mock type transformation to the entire generated namespace map; an empty map weakens only this proxy to `any`. Production `Context` and Remote declarations remain strict, with no namespace-specific type copies or compiler flags. The [proxy typing guidance](../../../../packages/test-support/remote-mock/README.md#remote-proxy) requires build-backed local type checking even when unbuilt tests pass.

## Product exports added for the tier

- `client/connection`: `ClientTransportHooks.rpc?` accepts an already decoded carrier owned by an in-process composition; `fetch` is optional. `installConnection(ctx, options)` installs the same production service from instance-local transport, recovery, and location inputs.
- `client/hmr`: `tearDownEntryFiber(entry)` is the registry-first fiber teardown `reload` already performed.
- `client/modules`: `parseDshClient` and `exactPackageSpecifier` are exported from the client face and shared by the Host and roster reader. Test factories use the existing registration queue. The roster-to-boot-graph synthesis has only test consumers and lives in the tier.
- `client/web`: `bootClient` and `mountClient` are extracted from `AppWebEntry.run()`, which now calls them.
- `api/gateway`: `carrierFailure` and `cancelledFailure` are exported so a stand-in for the generated client folds identically.

## Alternatives considered

**Running the generated `/remote` clients from built `lib/`.** Rejected: it makes source-plane specs depend on a build artifact, and the proxies need only the unary-or-stream declaration the mock already holds.

**A generated static roster module with a drift gate.** Rejected after review: it is a copy of bundle data inside the test package, and every subset written against it is a hand-list that misses rows. Reading the bundles at import through the include plugin's own schema and patch application removes the copy, the generator, and the gate.

**A Host compile face for the test runtime, a dynamic import of a Host module, or a vitest `globalSetup` handing rosters through `provide`/`inject`.** Rejected: a Client test runtime must not import Host code, dynamic imports hide the dependency, and a config-level channel hides the roster's source. The composition functions the launcher uses are face-neutral, so none of these is needed.

**A hand-written test-side YAML and patch parser.** Rejected: `entryListSchema` and `applyEntryPatches` are the launcher's own and carry no Host Context merge; the tier writes only file reading, package.json location, and the web-row filter.

**A mock module standing in for the Gateway client.** Rejected: the mock must not interfere with Gateway internals; passing it to the production Connection installer keeps retry, folding, and stream semantics real.

**A query-selected fixture transport and scenario dataset in the production Connection package.** Rejected: it couples shipped code to mutable application-test data and makes a URL flag a hidden transport selector. Client-only assembled tests inject `RemoteMock`; browser tests that own Host behavior use the real Host scaffold.

**A worker-level boot turn around a page-global Connection carrier.** Rejected: clients would share mutable process state, and every start or Connection reload would need serialization to install the acting client's carrier. Instance-local Connection installation lets independent plugin trees start and reload concurrently.

**A second typed Gateway implementation with an `Api` generic, envelope and error classes, and a fixtures directory.** Rejected: it duplicates Gateway declarations and encoding. The mock derives method types from the generated namespace map and declares only unary or stream behavior at runtime.

**Proxies passing unary rejections through unchanged.** Rejected: product code never awaits a Remote rejection because the generated client folds carrier throws, so an unmatched endpoint produced unhandled rejections; folding through the exported helpers restores the client's face.

**Keeping CallContext and wrapping native spies in an adapter.** Rejected: it makes each test unwrap a synthetic call and retains counter/state machinery with no business-spec consumer. Positional handlers use the existing test ecosystem directly.

**A separate `once` / `sequence` DSL and fallback rule stack.** Rejected: native per-instance queues already express the deferred responses and temporary failures used by consumers. Immutable table declarations with a cursor per registration would allow shared one-shot tables, but no current shared table requires them. The tier gives up newest-registration-first fallback and table-level repeat-last declarations; tests use native queue order and a persistent default instead. Response values and stateful handlers remain borrowed, not cloned.

**A separate pre-materialized-module option or `staticModules`.** Rejected: the existing pending registration queue accepts the same factories before Loader startup. `staticModules` bypasses factory materialization and does not share graph prefetch/invalidation behavior; the queue removes the extra option without losing that behavior. Assembly-only helpers remain in their leaf modules rather than the recommended entry's exports.

**A compiler-wide fallback flag or private augmentation package.** Rejected: declaration merging affects every file in a TypeScript Program that reaches the import; `private: true` only prevents publication. Separate test compiler graphs and additional policy checks add configuration maintenance without narrowing the fallback to its actual helper consumers. A local conditional type limits weakened inference to those consumers.

**Per-namespace helpers with selected method lists and separate spy aliases.** Rejected: they repeat operation names and controls already supplied by native mocks. The generic proxy derives every method from the production namespace map, while fixtures own the returned data rather than a second implementation of domain writes or publication.

## Consequences

Specs boot real plugins: the whole `web` roster costs about five seconds cold and well under a second warm, and a three-row cone about twenty milliseconds per test. Assertions read product facts — the real section list, the real declarer, a Loader rebuild, a second `$events` generation on reconnect — and change when the product changes.

The proxies skip the generated client's zod validation, wire-name mapping, and scoped-identity injection; mock rules read positional `args`, and the generated clients stay covered by the built-artifact e2e lanes. `remoteDefaultResponses` must gain a row when a plugin adds a boot-time call, and fails loud until it does. The two bundle names of the `web` profile are repeated once in `WEB_PROFILE_BUNDLES`, mirroring the launcher's `PROFILE_TEMPLATES.web`, and no check links the two: the client test program cannot import `@deepseek-ai/dsh-app-boot`, whose Host `Context` merges collide with the Client ones, and the test runtime takes no Host dependency even for tests. A template change therefore has to be carried to that constant by hand.

The shared functions keep production and test callers on one implementation. `AppWebEntry.run()` mounts the Loader after the immediate-tier prefetch settles; application entry creation remains after prefetch, so serializing Loader setup with prefetch does not advance application activation.

Native stream overrides may return their own iterable. The caller then owns consumption and cancellation; these iterables bypass scripted-stream logs and controls. Registered scripts retain managed queues and cancellation. This distinction preserves native mock behavior without adding another iterator wrapper or changing pull timing.

## Deferred

Product facts the tier surfaced and leaves as they are:

- No `declare module` augmentation declares `Context.connection`; consumers read `ctx.get('connection') as ConnectionHandle`, and `TestClient.connection` is the typed entry the tier offers.
- `TestClient.start` has no page-URL option, so a spec that needs the `connection` plugin to classify the page as off-loopback reconfigures the jsdom instance vitest exposes on `globalThis.jsdom`, a private detail of the jsdom environment provider.
- `ISessions` exposes no queue observation point, so queue frames reach a `Session` through `handleControlFrame` directly rather than over the `session/control` stream.
- A durable event pushed twice with the same seq is dropped at the tail of `RemoteJournalStream` as a replay and never reaches `SessionQueueMirror.acceptDurable`.
- The vendored Loader rejects `create()` when a module import fails, so the import-failed branch of `assertEntriesActive` is unreachable through `create()`.
- The session-controller client casts `ctx.remote as unknown as SessionRemotes`; in the client test program the cast is redundant, since the generated `/remote` merges are visible there.

## Testing

`packages/test-support/remote-mock/tests/` covers rules, streams, the log, and the carrier face; the `assembly-` specs under `packages/test-support/client-runtime/tests/` cover the roster reader on the real bundles and on a scratch installation, module loading, the proxies including their fold, parallel client startup, instance-local module and Connection reload, and `TestClient` under jsdom and plain Node. App-owned built-client specs under `apps/web/tests/` inject a fresh RemoteMock and keep their stateful scenario data beside those specs. In `packages/client/ui-settings-general/tests/`, the shell and apply specs boot the whole `web` roster; the apply spec reads its Chinese copy from the Host settings document the mock answers and reconfigures the jsdom page URL for the off-loopback branch. In `packages/client/ui-message-feedback/tests/`, object-layer specs pass the `messageFeedback` RemoteMock namespace directly. In `packages/api/session-controller/tests/`, Session, queue-store, pending-submission, projection tail-page, sessions-service, and the manager cases that exercise streams start the Gateway dependency cone; the other manager cases and projection-store's manager-routing cases use the same per-test Remote fixtures without starting a client; and client-apply boots the plugin's dependency cone, delivering Remote events as emit frames on `$events`. In `packages/api/workspace-controller/tests/`, the transport spec boots the plugin's cone for apply cases and the gateway cone for hand-built stream and controller cases, since a rostered plugin would share the follow endpoint. Each package keeps a `tests/remote/` module with its default responses and frame builders. The fixture tests include an expected assertion failure and independently observe completed client cleanup; settings reload tests observe replaced registration identities, and write tests assert every mutation argument. Teardown-failure tests execute the real tree disposer before reporting the injected failure and observe the `$events` stream's cancelled state.
