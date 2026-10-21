# Agent Note: Client plugin package assets served by URL

Status: implemented

English | [中文](2026-10-19-client-plugin-package-assets.zh.md)

## Problem

The browser half of a dynamic Client plugin is a lazy-CJS factory built by the [client build preset](../../../../packages/client/tsdown.client.ts) and loaded through the `/plugins` route of the [Client module system](../../../../packages/client/modules/README.md). That route served only `client.js` and package-local chunks, so an image that plugin code referenced had to be embedded in the bundle as a base64 data URL, and an image used by a stylesheet needed a package-level build plugin that rewrote it into the inlined style.

The embedded bytes were downloaded and parsed with the JavaScript whether or not the image was shown, and base64 adds a third to their size: the onboarding illustrations made the ui-settings-account `client.js` about 3.4 MB. ui-chat carried its own [tsdown plugin](../../../../packages/client/ui-chat/tsdown.config.ts) for one mask image.

## Decision

A Client plugin package keeps raw images under `src/client/assets/`. The shared preset emits each referenced image under `lib/assets/` and turns the reference into a synchronous `require.asset(<document-relative URL>)` call on the bundle's module loader; the package publishes the emitted files with `"exports": { "./assets/*": "./lib/assets/*" }` and `lib/assets` in `files`; the client-modules Host serves them at `/plugins/<package>/assets/<emitted path>`.

### References and file names

Client code imports an image (`import art from './assets/a.webp'`), and the package's own stylesheets reference one with a relative `url()`. Both compile to a `require.asset(reference)` call whose argument is the same reference; a stylesheet becomes string literals joined with those calls, which run when its injected text is built. The module system answers each call through its `resolveAsset` option, which returns the reference unchanged unless a carrier supplies one. The emitted file name inserts the content revision, the first 12 hexadecimal digits of the SHA-1 digest of the bytes, before the extension, so one URL always names one content:

```text
src/client/assets/running-whale@2x.png
lib/assets/running-whale@2x-06738fa29b2f.png
plugins/@deepseek-ai/dsh-client-ui-chat/assets/running-whale%402x-06738fa29b2f.png
```

Each path segment is percent-encoded with `encodeURIComponent` and then `!`, `'`, `(`, `)`, and `*`, so the reference is also a valid unquoted CSS `url()`, and the package name is emitted verbatim. The URL is relative to the shell document, like every app-owned route, so it resolves under any mount and from injected `<style>` text. Components need no hook, injected value, or service: the URL is a module constant computed when the module first runs.

The supported extensions are `.svg`, `.png`, `.webp`, `.jpg`, and `.jpeg`. [`src/assets.ts`](../../../../packages/client/modules/src/assets.ts) in client-modules owns the media-type table, the export key and target, the revision, the emitted name, and the URL, and the preset, the route, and the gates read them from there. The shared Client type root [`scripts/types/client-assets`](../../../../scripts/types/client-assets/index.d.ts), registered in [`tsconfig.base.client.json`](../../../../tsconfig.base.client.json), declares each extension as a module with a string default export; a test keeps it equal to the table.

### Build

The `dsh-package-asset` plugin of the dynamic browser face resolves an import against its source location and fails the build when the file's real path is outside the package's `src/client/assets/` (which also rejects another package's or a dependency's image), when `exports["./assets/*"]` is not exactly `./lib/assets/*`, when the extension is unsupported, when a path segment is `node_modules` or contains `%`, `#`, `?`, `\`, or NUL, which the Host route cannot serve, or when the extension is not lowercase, as the import types are. It emits each file once per build and registers it as a watch input. The three CSS pipelines (CSS Modules, global, and `?inline`) rewrite relative `url()` values through a lightningcss visitor in stylesheets inside the package's own `src/`; `data:`, fragment, scheme, `/`-prefixed, and empty URLs stay unchanged, a relative file reference with a fragment or query fails the build, and dependency stylesheets are not rewritten. lightningcss does not call its `Url` visitor inside `image-set()`, so an `Image` visitor rewrites those options with the same rule. The rewrite writes an identifier placeholder that lightningcss never escapes, so a file name with parentheses or quotes still becomes its resolver call. The Node Client face of a dual-face package rejects asset imports. The browser face is the only writer of `lib/assets/`: a one-shot build deletes files it did not emit, and a watch rebuild keeps them, because the Host still serves the previous bundle generation and pages running it request those names.

### Host route

`bundleResource` matches `/plugins/<package>/assets/<path>` before the bundle tables, and such a path is answered by the asset route alone. For an active client row, the path is percent-decoded once and `createRequire(<package manifest>).resolve('<package>/assets/<path>')` applies the package's own exports, so unexported paths, `.` and `..` segments, missing files, and directories do not resolve. The media type comes from the resolved file's extension, because Node reads `#` and `?` in the subpath as URL syntax. Any resolution failure, an inactive package, and an unsupported type answer 404; the query selects nothing.

A served asset streams from disk on every request; the Host keeps neither its bytes nor a hash, and a request the browser cancels mid-stream ends without a warning. It carries the media type, the bundle `cache-control: public, max-age=31536000, immutable`, `etag` equal to the requested path, `x-content-type-options: nosniff`, and, for SVG, `content-security-policy: script-src 'none'`. An `If-None-Match` equal to the tag answers 304 without opening the file; `HEAD` answers without a body. `fetchBundle()` returns the same responses with a streamed body that closes the file when cancelled.

### WebWorker preview

The preview page runs its Host in a Worker, and a page request for a reference never reaches it. Before any Client bundle runs, the page asks the Worker for `GET /__assets__`, answered by tunnel glue like `GET /__boot__`: an uncompressed tar of every file under `lib/assets/` of each image package that declares `"./assets/*": "./lib/assets/*"`, named by its unencoded `plugins/<package>/assets/<path>`, which fits the ustar name limits the base image already met. The page encodes each entry name into its reference and turns the entry into a Blob URL with the media type of its extension, and its `resolveAsset` returns that URL, or the reference when the image holds no such file. The base image already carries these files, so no network request is added; each boot still walks the image's packages, archives every asset, and copies each entry into a Blob, enabled or not.

### Changes and package manifests

A rebuilt image produces a new file name in a rebuilt `client.js`, which reaches the browser through the existing bundle HMR; assets have no channel of their own. Client-modules reads a package manifest and the bundle metadata on every reconciliation, that is, on each Loader entry construction and disposal, instead of caching the manifest until restart, so an entry that restarts after a reinstall, upgrade, or move publishes its current declaration, client export, and manifest path; a reconciliation that finds the same manifest and bundle metadata leaves the published graph unchanged and reads no bundle bytes.

### Gates and migration

[`check-workspace-constraints`](../../../../scripts/check-workspace-constraints.ts) requires `lib/assets` in `files` when the export is declared. [`verify-client-packages`](../../../../scripts/verify-client-packages.ts) requires the exact export target, allows the export only on dynamic Web Client packages, and keeps the export and the package's references (imports, and `url()` in the stylesheets its Client sources import) consistent in both directions. [`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) treats `./assets/*` as a non-code export. ui-settings-account and ui-chat moved to package assets, and ui-chat's tsdown plugin is gone.

Images that third-party libraries load themselves (PDF.js fonts, cmaps, wasm, and workers), plugin metadata icons, detail-document images, and static-linked packages keep their own delivery.

## Alternatives considered

**Keep data URLs.** No route is needed, but the bytes travel and parse with the JavaScript, and every package that styles with an image writes its own build plugin.

**A plain URL string with no runtime helper.** The served Web app needs nothing more, but the WebWorker preview page cannot request the URL, and changing it afterwards means copying the files to a static deployment or rewriting strings found in bundle text. A static copy is a build-time snapshot that bypasses the Host's rules and misses packages installed at runtime; finding strings in bundle text guesses at code. A synchronous call keeps the build output explicit and lets each carrier decide the URL.

**A Client Cordis service such as `ctx.assets.url(path)`.** Current consumers reference fixed files; a runtime lookup also cannot know the content revision without publishing a per-package asset list.

**Raw files in a package-root `assets/` without the build.** Authors could not preprocess them, so naming and format conversion would stay manual.

**The revision in a `?rev=` query, verified by the Host.** The Host must read a whole file to decide between 200 and 404, so a first request reads it twice and the Host must cache hashes by file metadata; a revision in the file name lets the Host only resolve and stream.

**The `client.js` revision as the asset revision.** That revision comes from the written bundle's metadata after the build, too late to appear in the bundle.

**Images in CSS only through JavaScript style objects.** Masks, backgrounds, and `@supports` fallbacks would move into components, while the URL is known at build time and the same rules rewrite `url()`.

**One plugin file protocol shared with detail documents.** Detail images read any package version from local, npm, or Git sources, need authentication because they trigger Host network access, and cache by source. Joining them would move authentication, source providers, and cache policy into client-modules; the Plugin Manager and Plugin Market detail routes stay separate until another consumer needs files of other packages.

**Manifests from Plugin Manager, or a manifest cache with change checks.** Plugin Manager lists bundles, not every client row, and resolves from the profile installation rather than the Loader resolution of the running entry. The failure was timing: a cache that outlived entry restarts. Rereading on each reconciliation and skipping unchanged results removes the cache instead of adding validation to it.

## Consequences

- The ui-settings-account `client.js` is 214 KB, and the account and ui-chat bundles contain no image data URLs; an image costs one same-origin request when shown and may appear after layout.
- `require.asset` belongs to the bundle factory contract beside `require.async`; a package built outside this repository must emit the call. The WebWorker preview creates a Blob URL for every package asset of its image at boot, enabled or not, and keeps them for the page's lifetime.
- The Desktop forwarder rewrites `/plugins/` cache headers to `no-store`, so Desktop reads an asset again on each display.
- The Host does not compare file contents with the revision in the name: a file under `lib/assets/` edited in place keeps its immutable cache entries. Only the build writes that directory.
- `require.resolve` runs synchronously on each request; a local measurement took about 43 µs for an existing file and 170 µs for a missing one. It reads exports through Node's package configuration cache, so an `./assets/*` export edited in place takes effect after boot HMR expires that package or the Host restarts. The route does not check the resolved file's real path, so a symbolic link under `lib/assets/` that leads outside the package is served.
- A package outside this repository must reproduce the emitted-name rule and the `require.asset` call; the Client module system README records them.
- A development session leaves earlier asset files under `lib/assets/` until the next one-shot build removes them; that pruning assumes the browser face is the directory's only writer.
- An entry restart reads its manifest and stats its bundle; only a changed result reads the bundle and broadcasts a graph frame (about 30 KB for 69 rows). Editing only `package.json`, without an entry restart, still takes effect at the next entry or Host restart.

## Testing

- [package-assets.client.spec.ts](../../../../packages/client/modules/tests/package-assets.client.spec.ts) composes the real Web server and compares every answer with `fetchBundle()`: headers including the SVG policy, 304 without opening the file, `HEAD`, 405, multi-chunk streaming, stream closing on cancel, a browser cancellation that logs nothing, and 404 for excluded subpaths, missing exports and files, `..`, `%2e%2e`, encoded `..`, an empty path, malformed escapes, decoded `%` and `#`, unsupported types, directories, and inactive packages.
- [assets.client.spec.ts](../../../../packages/client/modules/tests/assets.client.spec.ts) covers media types, the revision, emitted names, and references; [client-asset-types.spec.ts](../../../../scripts/client-asset-types.spec.ts) keeps the type root equal to the table.
- [client-bundle-css.spec.ts](../../../../scripts/client-bundle-css.spec.ts) covers emitted names, resolver calls in scripts and stylesheet text, their CommonJS rendering in a complete build, preserved `url()` forms, each build rejection, the Node face guard, one-shot pruning, and watch rebuilds that keep earlier files; [loader.client.spec.ts](../../../../packages/client/modules/tests/loader.client.spec.ts) covers the default and carrier resolvers.
- The gate specs reject each invalid manifest or reference form, and [node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) covers declarations, moved exports, and added or removed client declarations after an entry restart, an unchanged restart that publishes nothing and reads no bundle, and a chunk of a package named `@scope/assets`.
- [desktop-onboarding.e2e.ts](../../../../apps/web/tests/desktop-onboarding.e2e.ts) and [reasoning-preview.e2e.ts](../../../../apps/web/tests/reasoning-preview.e2e.ts) assert the package-asset URLs and decode the images in a browser; [preview-boot.e2e.ts](../../../../apps/web/tests/preview-boot.e2e.ts) decodes the ui-chat mask the WebWorker preview resolves to a Blob URL, and the runtime's [package-assets.spec.ts](../../../../packages/experimental/webworker-runtime/tests/package-assets.spec.ts) covers the archive and resolver.
