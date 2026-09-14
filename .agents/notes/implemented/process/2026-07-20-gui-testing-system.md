# Agent Note: GUI testing system — the three-tier structure

Status: implemented

> Path update (2026-08-27, Remote migration): the three-tier philosophy and golden-path method here remain current; object-layer specs live across `packages/api/session-controller/tests/` and `packages/test-support/client-runtime/tests/`, while Remote and carrier specs live across `packages/api/gateway/tests/` and `packages/client/connection/tests/`. Component specs are per-plugin jsdom suites under each `packages/client/*/tests/`. Component-spec shape follows the [slot system standard](../architecture/2026-07-22-slot-type-chain-implementation.md): feed props directly — the store share comes from `createXXXStore().create()` (the real engine, the sanctioned zero-machinery path), framework hooks are plain stubs; no render machinery, no provider mounting. Slot ownership and registry semantics are tier-2 territory (`ui-renderer` + `ui-slots` suites), not component specs.

English | [中文](2026-07-20-gui-testing-system.zh.md)

> Division of labor: this note covers only the test structure specific to the GUI (`packages/{client,host}/*` + `apps/web`); repo-wide testing policy (tiering principles, the with-key policy, real-implementation-first, REAL-composition) lives in [docs/testing.md](../../../../docs/testing.md) and is not restated here.

## Problem

The GUI stack spans multiple application shapes, and within one shape multiple runtime environments (the Node host, the data protocol layer, the browser object layer, React/DOM); a single-lane test suite cannot give a meaningful signal. Every link needs effective tests of its own, plus the base capability for full-chain testing.

## Decision

Cut along the architecture's natural test hooks into three tiers, bottom-up:

| Tier | Under test | Key technique | File location |
|---|---|---|---|
| 1 Protocol isomorphism | Generated Typert Remote descriptors + `ApiGateway` + the Connection RPC carrier (arguments / results / errors / streams / cancellation) | **The full chain at the isomorphic point**: gateway host/client suites validate descriptor codecs and Remote dispatch in process; Connection host suites exercise the same `/api` carrier framing and trust checks without a browser | `packages/api/gateway/tests/`, `packages/client/connection/tests/` |
| 2 Object-layer orchestration | `Session`/`SessionManager`/`ConnectionController` (state machines and timing: stitching / dedup / paging / optimistic draft clearing / pendingBuffers / reconnect / backoff) | **The "event sequence in → snapshot out" golden path**: programmable fakes + deferreds controlling timing + fake timers controlling backoff | `packages/client/{runtime,connection}/tests/` |
| 3 Assembled presentation | Built artifacts × the real client loader and plugin composition | App-owned semantic snapshots boot the built client graph under jsdom with a test-owned `RemoteMock`; Playwright cases separately exercise the real browser and Host carriers, with recorded model sessions replayed through `dsh-llm-replay` ([whole-client tier](../testing/2026-09-06-client-assembly-test-line.md), [web e2e lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md)) | `apps/web/tests/*.expected.e2e.ts`, `apps/web/tests/*.e2e.ts`, `apps/web/tests/*.snapshot.ts` |

Inter-tier discipline: **each tier tests its own layer, upper tiers never re-test lower ones** — an app semantic snapshot pins only user-visible projection across the assembled plugin boundary, while Playwright smoke proves browser and carrier liveness; wire semantics belong to tier 1 and data semantics to tier 2. Pure-function layers (lineage/partial/notifier/transcript-adapter) are tested directly with zero fakes in the same package's tests/ alongside tier 2.

- **Host and client source** are under the repo-wide per-file 100% coverage gate except the narrow browser-grade exclusions annotated in `vitest.config.ts`; component suites use per-file jsdom pragmas and Testing Library without changing Node suites.
- **App-owned semantic snapshots** read built client bundles, execute them through the real loader, and drive deterministic RemoteMock scenarios. They own stable visible state such as sidebar labels, breadcrumbs, and `document.title`, not CSS pixels or lower-layer state-machine details.

## Lane map

| Scenario | Command | Content | When to run |
|---|---|---|---|
| Baseline | `pnpm run test:gui` | Tier 1+2 vitest (`packages/client packages/host`), seconds-fast, no browser, no server | Casually, after touching any GUI source |
| Semantic snapshot | `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot` | Keyless assembled-application semantics plus the repo's transport-specific expected outputs | After a human-visible GUI change; before delivery |
| Browser end-to-end | `pnpm run test:web` | Rebuilds the front-end dist first, then runs built-client RemoteMock cases and real-Host browser scenarios, including keyless recorded-session replay (`DSH_SNAPSHOT=record`/`refresh` re-record fixtures / rewrite goldens) | After touching the build surface/boot/carriage; before delivery |
| Browser expected-output gate | `DSH_SNAPSHOT=replay pnpm run test:web:built` | Reuses CI-built artifacts and compares every committed browser golden without writing | Every Linux pull request |
| Gate | `pnpm run test:coverage` | The repo-wide gate (host and client GUI packages included, except annotated browser-grade exclusions) | The PR window |

**Division of labor between the browser scripts and vitest**: Playwright owns browser/carrier black-box regression and long sequential user journeys; ordinary vitest owns data-layer semantics such as reference stability, timing, and wire shapes; snapshot vitest owns stable app-level semantic output through the built composition. These lanes complement each other rather than duplicating assertions.

## Anti-regression discipline

- **Every bug fix pins an assertion**: a browser-visible bug is pinned into its owning browser spec (smoke or e2e scenario); a data-layer bug is pinned into the matching spec (precedent: the res-close misjudgment pinned in the webserver bridge suite — pure Node, reproduces in seconds, no longer needs the 12s browser sentinel as the only defense).
- **All-green on RemoteMock is not done, the real wire must pass too**: a decoded in-process carrier deliberately omits the HTTP/WebSocket chain and its network timing. Changes touching connection, bridge, handler, or streaming transport must run the browser lane (`pnpm run test:web`), whose keyless e2e scenarios drive the real carrier; the with-key real-Host smoke remains the live-model complement.
- The code-on-disk-is-the-answer reconciliation workflow: when a behavior change lands and turns existing cases red, reconcile on the spot (fix the test or fix the code, with the RFC/contract as arbiter); no red left hanging.

## Consequences

Each lane tests its own tier: touching any GUI source gets seconds-fast `test:gui` feedback, wire/object-layer semantics assert in milliseconds in Node, built-composition snapshots pin deterministic user-visible projection, and the browser carries wiring and carrier acceptance. Inter-tier discipline remains review-owned, while Linux CI mechanically enforces browser-golden freshness. Every new app snapshot must avoid unstable layout or clock output.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Single e2e (everything through the browser) | Browser startup is seconds × N slower and timing is uncontrollable; wire/object-layer invariants can be fully asserted in milliseconds in node env |
| Migrating the verify scripts to vitest | An ordered script shares one browser session; splitting the cases either formalizes it (sequential + shared page) or re-runs the preamble × N; streaming PASS/FAIL output is exactly the agent's locating interface |
| Keeping a production client fixture for tests | It couples shipped code to scenario data and a query-selected transport; RemoteMock and real-Host tests own the two required tiers directly |
| A standalone vitest config for GUI packages (once designed as vitest.gui.config.ts) | Package-level tests/ are already scanned by the root include; `vitest run packages/client packages/host` path filtering is the tight loop — zero new config |
| Deferring hooks/component-layer unit tests | jsdom remains the coverage mainline because it gives fast per-file component behavior; the required browser replay gate complements it at the assembled tier rather than replacing it ([CI gate decision](../testing/2026-07-30-web-browser-snapshot-ci-gate.md)) |
