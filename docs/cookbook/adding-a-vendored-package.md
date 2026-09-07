# Cookbook: adding a vendored package

English | [中文](adding-a-vendored-package.zh.md)

When the harness needs another upstream Cordis package (e.g. `@cordisjs/plugin-http`), it is **vendored** as pinned source under `vendor/`, not added as an npm dependency. [vendor/README.md](../../vendor/README.md) states why and covers *updating* an already-vendored package; this guide is the file-by-file checklist for adding a **new** one. (Verified against the existing vendored set; if it drifts, fix it here.)

## 1. Copy the source in

```
vendor/<dir>/
  package.json     # from upstream; rescope the name, keep exports/type (publishable release member, no private flag)
  tsconfig.json    # extends ../../tsconfig.base.json (see configuration below)
  src/             # the upstream src/ verbatim
  README.md LICENSE # if upstream ships them
```

`tsconfig.json` mirrors the other vendored packages — `rootDir: src`, `outDir: lib/types`, the strictness relaxations upstream code needs, and a `references` entry for every other vendored package it imports:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src", "outDir": "lib/types",
    "noUncheckedIndexedAccess": false, "exactOptionalPropertyTypes": false,
    "noImplicitOverride": false, "noUnusedLocals": false, "noUnusedParameters": false
  },
  "include": ["src"],
  "references": [{ "path": "../cordis" }, { "path": "../cosmokit" }]
}
```

`package.json` invariants: rescope the `name` ([mapping](../rescope.md)) while keeping upstream's `exports`/`type`, point declaration metadata at `lib/types`, publish `.d.ts` and `.d.ts.map` declaration outputs, and list its cordis deps in `peerDependencies` (matching the upstream manifest). Vendored packages are publishable release members, so they must NOT set `private: true` and must set `publishConfig.access: public`; the `version` field follows the harness release sequence (see [vendor/README.md](../../vendor/README.md)). Transitive upstream deps must themselves be vendored or already present — vendoring one package often means vendoring its dependency tree (e.g. `@cordisjs/plugin-http` pulls `@cordisjs/fetch-file`).

Local relative imports/exports in vendored TypeScript source use explicit `.ts` specifiers after copying. This is a repo-local build difference from upstream: `rewriteRelativeImportExtensions` emits `.js` runtime imports while declarations keep explicit `.ts` specifiers that NodeNext/Node16 TypeScript consumers can resolve.

## 2. Register it in the root configs

| File | Change |
|---|---|
| `tsconfig.base.json` | add `"<npm-name>": ["./vendor/<dir>/src"]` to `paths` |
| `tsconfig.host.json` | add `{ "path": "./vendor/<dir>" }` to `references` (before the `packages/*` entries; vendored code enters the graph through the host aggregate only) |
| `vendor/README.md` | add a manifest table row (dir, npm name, version, upstream repo, commit SHA) and log any local modifications |
| `scripts/publint-all.ts` | only if the vendored package is itself published from here (vendored deps normally are not — skip) |

Covered automatically by globs — no edits needed: root `package.json` workspaces (`vendor/*`), `tsdown.config.ts`, `vitest.config.ts`, `.oxlintrc.json`. A per-package `vendor/<dir>/tsdown.config.ts` is needed ONLY if the build configuration differs from the root default (dual ESM/CJS or multiple entries — see `vendor/schemastery` and `vendor/logger-console`); its entry should read the JS emitted under `lib/types`.

## 3. Mind the manifest guard

`scripts/check-vendor-manifest.sh` (a pre-commit hook) fails if anything under `vendor/*/src` is staged without `vendor/README.md` also staged. Stage the manifest update alongside the source so the commit passes.

## 4. Verify

```sh
pnpm install        # registers the workspace
pnpm run typecheck
pnpm run build && pnpm run constraints
```

Run the behavior checks selected by the [testing policy](../testing.md). The source `paths` map lives once in `tsconfig.base.json` and serves every graph. The important isolation boundary is the project-reference graph: vendored source must be referenced through its own `vendor/<dir>/tsconfig.json`, not pulled into an aggregate's strict program ([layout](../development.md#typescript-project-layout)).
