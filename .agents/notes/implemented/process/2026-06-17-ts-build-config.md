# Agent Note: TSC-first build and one compiler ownership

Status: implemented

English | [中文](2026-06-17-ts-build-config.zh.md)

> Root project topology uses a solution root over two aggregate programs; see the [solution-root note](../../archived/process/2026-07-22-tsconfig-solution-root-two-aggregates.md). The [API Remotes build note](../../archived/process/2026-08-08-api-remotes-generated-contract-build.md) defines the current command order in which the Host generates Remote contracts before the Client compiles. The tsc-first ownership decided here is unchanged.

## Problem

The current TypeScript build and typecheck setup had these issues:

- `build` used `tsc` to transform `.ts` to `.d.ts` files for packages under `packages/<group>/<pkg>` and `vendor/*`, and then used `tsdown` to transform `.ts` to bundled `.js` files. This made two tools do TypeScript transform.
- `typecheck` tended to validate packages, vendor source, examples, tests, and scripts through one root typecheck config.

Build and typecheck use matching tsconfig boundaries and TypeScript resolution/transform behavior. Build generates `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` through one compiler and config, so publish output and type validation stay consistent.

Concrete constraints:

- `tsdown` uses `oxc` to transform TypeScript, which is not the same behavior as `tsc`.
    - Bundled `.d.ts` emitted by `tsdown` conflicts with Cordis' internal relative module augmentation shape.
    - The tsc output is affected by `allowImportingTsExtensions`: generated `.js` files must not import `.ts` files, and generated `.d.ts` files must keep explicit relative specifiers that NodeNext/Node16 accepts. Therefore, in-package relative imports use explicit `.ts` specifiers in TypeScript source and `rewriteRelativeImportExtensions` rewrites those specifiers to `.js` in emitted JS.
    - Bundled `.js` emitted by `tsdown` is not the same behavior as per-file `.js` emitted by `tsc -b`, such as decorator transform behavior.
- `vendor/*/src`, examples, tests, and scripts cannot all be plain-included in one root strict program.
    - Directly typechecking `vendor/*/src` under the root strict config triggers many type errors outside this project's ownership.
    - Package dependencies under `packages/*/*` on `vendor` are resolved to the `vendor/*/lib` for different tsconfig strictness.


## Decision

In-package relative imports use explicit `.ts` specifiers.

`pnpm run build` orders Host lib, Client lib, and Web; each lib phase keeps tsc emission before tsdown bundling:

- Host tsc runs `tsc -b` against `tsconfig.host.json`, emitting per-module `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` into `lib/types` for each package in the Host graph; Host tsdown then reads that JavaScript, produces published entries, and runs Host Typert.
- Client tsc runs `tsc -b` against `tsconfig.client.json` after Host Typert has generated the Remote Client declarations; Client tsdown then reads the JavaScript emitted by the Client graph and produces the Client packages' Node loader entries and browser bundles.
- The Web build starts only after both lib phases complete.

`tsdown` is no longer the owner of TypeScript compilation or declaration output.

`pnpm run typecheck` first runs the Host lib phase to generate the Remote declarations required by Client typechecking, then runs `tsc -b` against `tsconfig.client.json`. The two aggregates themselves check their respective examples, tests, and scripts with `noEmit`; referenced package/vendor projects retain the same emit behavior as the build.

Composite projects keep their incremental build information inside their project-local `lib/` output. `pnpm run clean` derives live output directories from the root TypeScript project-reference graph, removes legacy root build information, and removes deleted `packages/*/*` directories that contain only known generated residue. Before removing an existing target, it resolves the target's parent and refuses it if that resolved parent is outside the repository, so a symlinked project reference cannot redirect cleanup outside the checkout. It preserves `node_modules` for every package that still has a `package.json`, and refuses to remove a manifest-less directory containing unknown files. Build does not invoke clean automatically, so ordinary builds retain incremental state.

The command orchestration shape is:

```sh
pnpm run build:
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web

pnpm run verify-node-next-types:
tsx scripts/verify-node-next-types.ts

pnpm run typecheck:
pnpm run build:lib:host
tsc -b tsconfig.client.json

pnpm run clean:
tsx scripts/clean.ts
```

The source-mode demos run through their declared TypeScript launchers and the root paths map. The `dsh` TUI chain uses Node's native transform plus its app-owned paths loader, the Web demo builds its required artifacts before entering that same CLI source chain, and the other source demos continue to use tsx.

## Alternatives considered

- **Keep `tsdown`/oxc as the TypeScript transformer** — oxc's transform is not `tsc` behavior (decorator transform differs, bundled JS differs from per-file emit), and its bundled `.d.ts` conflicts with Cordis' internal relative module augmentation shape.
- **One root strict program over packages, vendor, examples, tests, and scripts** — vendor source triggers type errors outside this project's ownership under the root strict flags; project references with per-project strictness are the boundary that works.
- **Clean before every build** — this would discard the incremental state owned by `tsc` and the bundler even when the workspace layout is unchanged.
- **Remove every package-level `node_modules`** — valid package dependency links do not cause the workspace-discovery failure, and deleting them would turn build cleanup into dependency reinstallation.

## Consequences

Build responsibilities are clearer:

- Each ordinary module under `packages/<group>/<pkg>` and `vendor/*` has one local tsconfig for build, typecheck, and tools that run source directly, such as the `dsh` source loader, `tsx`, and `vitest`. `api/remotes` is the sole exception: generated-contract ordering requires one solution and two mutually exclusive emitting projects.
- The `build` command runs the Host and Client Project Reference graphs in order. In each phase, `tsc -b` owns the publishable per-module `.js` and `.d.ts` output, while the bundler owns only the published runtime bundles.
    - `lib/types/*.d.ts` is the publish declaration output; `.d.ts.map` remains only as a local compilation artifact.
    - `lib/types/*.d.ts` uses explicit `.ts` relative specifiers, which TypeScript's NodeNext/Node16 resolver maps to sibling `.d.ts` files.
    - `lib/types/*.js` is normally only a bundler input. It is published only when an explicit runtime export points into the emitted tree.
    - `lib/index.*` is the publish runtime output and is generated by the bundler, currently `tsdown`.
- `pnpm run verify-node-next-types` scans built declarations for relative specifiers without file extensions, then typechecks a temporary external ESM consumer with `moduleResolution: "NodeNext"` against the built `types`/`exports` surface, so declaration specifier regressions fail before publish.
- The `typecheck` command uses `tsconfig.json`. Examples, tests, and scripts are checked by the root no-emit project, while packages and vendor modules keep the same emit behavior as `build`. Package and vendor source stays behind project-reference boundaries.
- After changing branches or updating a checkout that deleted packages, contributors can run `pnpm run clean` to remove stale package directories before rebuilding. Unknown files in a manifest-less package directory require manual classification instead of being deleted.

The Cordis vendor copy now has one more type-structure divergence from upstream. During upstream sync, that divergence must be reapplied or explicitly retired.
