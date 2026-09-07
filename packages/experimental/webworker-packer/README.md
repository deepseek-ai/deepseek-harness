---
description: "Browser-worker VFS image packaging for maintainers building or debugging the experimental preview deployment."
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-packer`

English | [中文](README.zh.md)

## Summary

The VFS image packer: turns one composed profile into the gzip-compressed base tar the browser worker mounts as its filesystem, and opaque data trees into ordered overlay tars ([experimental group](../README.md)). Nothing is compiled from source — the base image carries the repository's real build products, so a preview deployment debugs exactly what the served deployment ships. Read this page when packaging a preview image or diagnosing its contents.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [`DshConfigTreeDeclaration`](../../util/package-manifest/README.md) type describes each `dsh.configTrees` entry; this packer validates it and resolves its source directory.

The pack is a three-layer standard stack:

1. **Roster** — the composed profile's plugin rows (standard YAML parse under Include's dialect, `!!js` intact), plus the rows of every config tree the CLI declares in its `package.json` `dsh.configTrees` (agent presets), materialized as a Node-style dependency closure. External peer edges never bind the worker; workspace peers stay on the chain.
2. **Publish view** — each workspace or vendored package contributes its built npm slice (`files` through picomatch) without source or workspace `dist/`. External packages retain published JavaScript under both `src/` and `dist/` because their `main` or `exports` may point there; only generic test, map, declaration, and archive exclusions apply.
3. **Reachability sweep** — the runtime loader's own resolution walks from every workspace export face plus the worker assembly's seeds (`IMAGE_ENTRY_SEEDS`), lowering each reached module to the wrapper contract at pack time. The transform reports statically named imports, re-exports, and dynamic imports; calls through `require`; and module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named import from `node:module` or `module`, including an import alias. Page assets (`lib/client.js` behind `./client` exports) ship verbatim; an unresolvable request from our own code fails the pack, third-party ones are tolerated to fail loud at require time.

`repository.ts` owns the repo-shaped inputs (workspace scan of `vendor/`, `packages/`, `native/landlock-run/packages/`, and `apps/`; profile composition through the real CLI dump path); `pack.ts` owns none of them, so the same library packs a different tree by being called differently. The native scan makes the Landlock entry package an ordinary published-view dependency while its executable remains a Worker platform implementation. The CLI is `dsh-pack-vfs-image --out <file> [--profile web]`; `apps/web`'s `build:preview` runs it after the preview shell build.

The repository adapter also declares the preview-only fixture trees under `webworker-runtime/tests/fixtures/`. The CLI packs each named fixture into a separate deterministic overlay archive plus a browser-readable manifest. Overlay files bypass npm publish-view and module-reachability exclusions, so dot directories and example source files remain intact; their mounts are limited to `home/` and `workspace/`. `pack.ts` treats them as opaque bytes, and Session and Workspace interpretation stays in the runtime packages that own those formats.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package runs at build time and writes an image file; nothing it produces reaches a model request on its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The rule tables are judgement calls** (`rules.ts`: exclude globs, page-asset patterns, entry seeds) pinned by `tests/`; a new asset class the worker must reach needs a table row, not a scanner change.
- **Reachability infers only exact request forms** — computed `import` and `require` arguments, stored `createRequire` results, CommonJS-obtained `createRequire`, and bases other than `import.meta.url` resolve only at runtime and fail loud if the target was otherwise pruned; a target reachable only through those forms needs an explicit image entry seed.
- **Vendored package sources (`src/*.ts`) are excluded** — nothing resolves them at runtime; a future in-worker source-inspection feature would need a dedicated include rule.
- **The packer assumes built `lib/` artifacts are current**: it never compiles, so a stale workspace build packs stale bytes. Run the repository build first.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package is a build-time pass with no production event stream or mutable data; the pack's own gates (unresolvable own requests, the all-or-nothing wrapper contract) fail the pack instead.
