---
description: "Browser-worker VFS image packaging for maintainers building or debugging the experimental preview deployment."
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-packer`

English | [中文](README.zh.md)

## Summary

The VFS image packer: turns one shipped profile's bundles and the installation's optional bundles into the gzip-compressed base tar the browser worker mounts as its filesystem, one archive per lazily loaded page chunk, and opaque data trees into ordered overlay tars ([experimental group](../README.md)). Nothing is compiled from source — the base image carries the repository's real build products, so a preview deployment debugs exactly what the served deployment ships. Read this page when packaging a preview image or diagnosing its contents.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The public npm package exposes `packVfsImage` and `packVfsOverlay` through its library entry. Callers supply the profile name, the package roster, the installation manifest, package directories, and the resolution root; no profile layer is installed and no composed configuration is packed — the worker composes the bundle layers at boot. An optional `homePatch` is written to `home/cordis.patch.yml`, the home layer the image's app-boot reads. The runtime's library entry supplies the module-proxy and replacement tables used during packing.

The packer owns the internal `dsh.configTrees` declaration, its validation, and source directory resolution in [`src/repository.ts`](src/repository.ts). This field is not part of the public plugin manifest API.

The pack is a three-layer standard stack:

1. **Roster** — the shipped profile template's bundles and every bundle in `OPTIONAL_BUNDLES` from [`dsh-official-bundles`](../../util/official-bundles/README.md), each resolved from the CLI manifest as the launcher resolves it, plus every package their patch files name (insert lists and grouped rows included), plus the rows of every config tree the CLI declares in its `package.json` `dsh.configTrees`, materialized as a Node-style dependency closure. External peer edges never bind the worker; workspace peers stay on the chain. The CLI manifest itself enters the image alone at `node_modules/@deepseek-ai/dsh/package.json`, as the worker's bundle resolution anchor; the manifest records its name and the profile.
2. **Publish view** — each workspace or vendored package contributes its built npm slice (`files` through picomatch) without source or workspace `dist/`. External packages retain published JavaScript under both `src/` and `dist/` because their `main` or `exports` may point there; only generic test, map, declaration, and archive exclusions apply.
3. **Reachability sweep** — the runtime loader's own resolution walks from every non-wildcard workspace runtime export plus the worker assembly's seeds (`IMAGE_ENTRY_SEEDS`), lowering each reached module to the wrapper contract at pack time. Declaration-only condition trees do not seed the sweep; runtime requests for those exports still fail. The transform reports statically named imports, re-exports, and dynamic imports; calls through `require`; and module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named import from `node:module` or `module`, including an import alias. Page assets (`lib/client.js` behind `./client` exports) ship verbatim; an unresolvable request from our own code fails the pack, third-party ones are tolerated to fail loud at require time.
4. **Lazy chunks** — every page chunk a page asset requests as a literal `require.async("./client.<name>.js")`, the only form the dynamic Client build emits, leaves the base image unless a `./client` export names it. Each becomes its own deterministic archive named `lazy/<sha256 of the archive>.tar.gz` beside the base image, and the manifest registers its path, size, and archive for the worker's lazy filesystem. A request for a chunk the package does not publish fails the pack.

`repository.ts` owns the repo-shaped inputs (workspace scan of `vendor/`, `packages/`, `native/system/packages/`, and `apps/`; the profile roster through the shipped templates and optional-bundle list of `dsh-official-bundles` and app-boot's bundle patch readers; the CLI manifest as the installation; the home patch, which sets the runtime's `PLATFORM_ENTRY_CONFIG` fields over each named row's config composed from the template's bundle layers); `pack.ts` owns none of them, so the same library packs a different tree by being called differently. The native scan makes the Landlock entry package an ordinary published-view dependency while its executable remains a Worker platform implementation. The CLI is `dsh-pack-vfs-image --out <file> [--profile web]`; it writes the lazy archives beside the base image, and `apps/web`'s `build:preview` runs it after the preview shell build.

The repository adapter also declares the preview-only fixture trees under `webworker-runtime/tests/fixtures/`. The CLI packs each named fixture into a separate deterministic overlay archive plus a browser-readable manifest. Overlay files bypass npm publish-view and module-reachability exclusions, so dot directories and example source files remain intact; their mounts are limited to `home/` and `workspace/`. `packVfsOverlay` treats all files as opaque bytes.

`packPreviewFixture` prepares the newest canonical raw Session generation in each fixture directory through the [Session format catalog](../../session/session-format-catalog/README.md) in Node. It collects direct-child discovery evidence from the same fixture root before completing historical parent catalogs. It strictly restores the source, encodes and strictly validates the current successor, and packs that successor beside unchanged source files. A malformed, unsupported, or future selected generation refuses the build without falling back. Temporary successors are removed after packing. Browser write-open then uses current data without invoking Node's migration-verification Worker. Projection caches remain owner-validated; an older generation cannot supply a current fold checkpoint.

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
- **The CLI requires its original repository location**: `dsh-pack-vfs-image` finds the checkout relative to its own installed file and reads the source CLI, configuration trees, and preview fixtures there. An npm installation supports the parameterized library API; the CLI and repository helpers require a complete, built DeepSeek Harness checkout.
- **Preview Session inputs use raw JSONL** — `packPreviewFixture` rejects compressed and noncanonical Session generation filenames. Generic overlays remain byte-preserving.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
