# Agent Note: Node runtime floor and compatibility coverage

Status: implemented

English | [中文](2026-10-15-node-24-runtime-floor.zh.md)

## Problem

The root `engines.node` range promises that the installed workspace supports each admitted runtime. Its minimum must cover both the runtime APIs DSH uses and the declared requirements of installed dependencies. Otherwise strict installation can reject a supported version before DSH starts.

## Decision

Set `engines.node` to `^24.22.3 || >=26.13.1`. Node 24.22.3 is the Node 24 minimum for DSH and its development carriers, including the experimental OAR subagent integration, whose `@botiverse/oar` library requires Node 24. It is a Node security release and the Node version embedded in Electron 44.11.4 and later, so source, npm, desktop, and Python SDK executable installations run the same minimum Node release. Node 24.22.3 bundles undici 7.30.2; Node 26.13.1 is the first Node 26 release whose bundled undici, 8.12.4, carries the same security fixes, so the range excludes earlier Node 26 releases. The Python SDK executable pins exactly this release in `scripts/build-exe-for-python-sdk.ts`, and the desktop primary runtime pins it in `scripts/primary-runtime/lock.json`. This supersedes the [Node 22.19 floor](../../archived/process/2026-07-06-node-engine-floor.md); its Node 23 exclusion remains satisfied, and the declaration policy below remains narrower than the runtime floor. Migration instructions live in the [Node 24.9 upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.md) and the [Node 24.22.3 upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.1/node-24-22-3/guide.md).

The primary Node 24 jobs own complete typechecking and unit coverage. Focused compatibility jobs run on pinned Node 24.22.3 and Node 26. Pinning 24.22.3 exercises the verified minimum; the primary jobs track the latest Node 24. A floating `24` compatibility job would duplicate the primary coverage and stop testing the minimum. Every supported Node 24 release uses the v2 private module loader introduced in 24.12.0; the v1 loader adapters in `app-boot` and `hmr` are no longer reachable on a supported runtime.

The Node 24.22.3 compatibility job also builds artifacts and checks that the shipped Web CLI starts and disposes with full-text Session search disabled. It requests these build-backed gates with `DSH_NODE_COMPAT_BUILD=1`, which `run-gates` rejects on any other Node release. The Node version alone does not select them: the primary jobs can run the floor release and nest the same compatibility mode beside readers of restored build output, where a rebuild would delete the files under test. Command-entrypoint, source-worker, Zstandard, source-launch, profile-resolution, and jsdom-storage checks run on both compatibility versions. Real-API e2e jobs stay on Node 24 because they validate provider integration.

The root, Web, and desktop projects retain `@types/node` on the 22.x line. Their current code needs no Node 24-only declarations. A narrower type API remains valid on the supported runtime and avoids unrelated declaration changes. Raise these declarations when a supported API requires them, and keep their major no newer than the runtime floor. The independently published native addon has its own runtime and type support policy.

## Consequences

- Node 22, Node 24 releases before 24.22.3, and Node 26 releases before 26.13.1 must upgrade before running DSH. Packaged applications with an embedded runtime do not require a system Node upgrade.
- Supported runtimes provide `node:sqlite` and native TypeScript stripping without opt-in flags. The source CLI still uses its declared `tsx/esm` launcher.
- The compatibility graph exercises only the v2 private loader interface; the unreachable v1 adapters can be removed.
- A future runtime-floor change updates `engines.node`, compatibility jobs, current documentation, this note, and an upgrade guide together.

## Alternatives considered

- **Keep Node 22 support.** It excludes the OAR library from the supported installation.
- **Use OAR’s declared minimum of Node 24.0.** Existing script entrypoints depend on `import.meta.main`, which Node 24.0 lacks. A dependency minimum alone does not establish the application minimum.
- **Keep the Node 24.9 floor.** It admits Node releases older than the runtime embedded in the desktop application and Python SDK executable, and releases without the 24.22.3 security fixes.
- **Keep `>=24.22.3`.** It admits Node 26 releases before 26.13.1, whose bundled undici lacks the security fixes in Node 24.22.3.
- **Test only the latest Node 24.** It does not exercise the minimum.
- **Raise Node declarations ahead of the minimum.** It allows code to compile against APIs that a supported runtime can lack.
