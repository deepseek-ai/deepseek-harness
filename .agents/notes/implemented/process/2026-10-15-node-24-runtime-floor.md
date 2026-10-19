# Agent Note: Node runtime floor and compatibility coverage

Status: implemented

English | [中文](2026-10-15-node-24-runtime-floor.zh.md)

## Problem

The root `engines.node` range promises that the installed workspace supports each admitted runtime. Its minimum must cover both the runtime APIs DSH uses and the declared requirements of installed dependencies. Otherwise strict installation can reject a supported version before DSH starts.

## Decision

Set `engines.node` to `>=24.9.0`. Node 24.9 is the minimum for DSH and its development carriers, including the experimental OAR subagent integration, whose `@botiverse/oar` library requires Node 24. This supersedes the [Node 22.19 floor](../../archived/process/2026-07-06-node-engine-floor.md); its Node 23 exclusion remains satisfied, and the declaration policy below remains narrower than the runtime floor. Migration instructions live in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.md).

The primary Node 24 jobs own complete typechecking and unit coverage. Focused compatibility jobs run on pinned Node 24.9 and Node 26. Node 24.9 supports the existing `import.meta.main` script entrypoints and native TypeScript stripping. Pinning 24.9 exercises this verified minimum and its v1 private module loader; the primary jobs track the latest Node 24 and exercise its v2 loader, introduced in 24.12.0. A floating `24` compatibility job would duplicate the primary loader coverage and stop testing the minimum.

The Node 24.9 compatibility job also builds artifacts and checks that the shipped Web CLI starts and disposes with full-text Session search disabled. Command-entrypoint, source-worker, Zstandard, source-launch, profile-resolution, and jsdom-storage checks run on both compatibility versions. Real-API e2e jobs stay on Node 24 because they validate provider integration.

The root, Web, and desktop projects retain `@types/node` on the 22.x line. Their current code needs no Node 24-only declarations. A narrower type API remains valid on the supported runtime and avoids unrelated declaration changes. Raise these declarations when a supported API requires them, and keep their major no newer than the runtime floor. The independently published native addon has its own runtime and type support policy.

## Consequences

- Node 22 installations must upgrade before running DSH. Packaged applications with an embedded runtime do not require a system Node upgrade.
- Supported runtimes provide `node:sqlite` and native TypeScript stripping without opt-in flags. The source CLI still uses its declared `tsx/esm` launcher.
- The compatibility graph retains both private loader interfaces used by supported Node versions.
- A future runtime-floor change updates `engines.node`, compatibility jobs, current documentation, this note, and an upgrade guide together.

## Alternatives considered

- **Keep Node 22 support.** It excludes the OAR library from the supported installation.
- **Use OAR’s declared minimum of Node 24.0.** Existing script entrypoints depend on `import.meta.main`, which Node 24.0 lacks. A dependency minimum alone does not establish the application minimum.
- **Test only the latest Node 24.** It does not exercise the minimum or the older private loader interface still used within the supported 24.x line.
- **Raise Node declarations ahead of the minimum.** It allows code to compile against APIs that a supported runtime can lack.
