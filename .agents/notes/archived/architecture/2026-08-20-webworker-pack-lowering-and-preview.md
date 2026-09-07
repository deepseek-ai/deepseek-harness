# Agent Note: pack-time lowering and the single-build preview

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-webworker-pack-lowering-and-preview.zh.md)

## Problem

The browser worker can neither compile modules at load nor be served by the product webserver: every module body must arrive runnable, and the page must be a static artifact. Both surfaces drifted early. The loader carried a fallback compiler, so a collector gap surfaced as a slow boot instead of a broken image — and `acorn` rode into `lib/worker.js` through the package barrel, a parser a runtime that only wraps pre-lowered bodies never needs. The preview was a second HTML template beside the served one, a page the served index could silently drift away from.

## Decision

**Lowering happens at pack time only.** `@deepseek-ai/dsh-experimental-webworker-packer` composes the profile, materializes the closure, and lowers every JavaScript body; `LOWERING_VERSION` and `WRAPPER_PARAMS` are the pack↔worker contract and live in `src/image-layout.ts` beside the rest of the image layout. The loader wraps bodies exactly as the image holds them: a body still carrying module syntax is a refusal naming the image, and `startWorkerHost` requires the manifest's `lowered` to equal this build's contract before it mounts a single module. `lowerModuleSource` is the transform's only face and the packer its only caller; the same parse feeds reachability with statically named imports, re-exports, and dynamic imports, calls through `require`, and module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named `node:module` or `module` import. Stored results, CommonJS-obtained `createRequire`, computed request names, and other bases stay runtime-only; targets reachable only through those forms require image entry seeds. Inside the worker graph, imports name the module that owns the value — never the package barrel, which is the edge that smuggled the parser in. Source-directory exclusion applies only to workspace and vendored packages whose runtime plane is built `lib/`; installed third-party packages retain JavaScript under `src/` and `dist/` because their published entrypoints may resolve there.

**The preview is the served page plus one tag.** One Vite build emits `dist/index.html` and `dist/preview.html` sharing every chunk; the only difference is a prepended bootstrap entry whose module connects the worker host. Startup then converges on one protocol: whichever side applies the injection table settles the `__DSH_BOOT_READY__` deferred — the served renderer resolves it in a tail script after the rendered rows, the worker bootstrap installs it before its first await and settles it after the last row — and the client entry awaits it before reading any injected state, so the chain from the stock entry onward is the served chain verbatim. Plugin combo scripts and maps travel through the tunnel; the page-side loader embeds each tunnel-only map as a Base64 data URL before executing its script Blob, preserving indexed-map component names in DevTools without another object-URL lifetime. The build uses a relative base so the output mounts under any static directory; the served form anchors deep SPA-fallback paths by rendering `<base href="/">` at serve time, keeping the on-disk pages byte-shared.

**The repository preview carries selectable filesystem sources.** The packer emits one base image and a small overlay archive for each named built-in fixture. Without a source query, `preview.html` waits at a chooser for an empty filesystem, the built-in fixtures, or the separately owned WebFS provider. A valid `preview-fixture=none|<built-in-id>` query selects directly and skips the chooser for deterministic browser runs; its distinct name avoids the Client's existing `fixture` transport switch. The Worker mounts the base and then applies the selected overlays in order, restricted to `home/` and `workspace/`, before it validates the base manifest or boots Cordis. `packages/experimental/webworker-runtime/tests/fixtures/vfs-example/` supplies one built-in overlay without giving the packer Session or Workspace knowledge. Its plaintext JSONL logs use the persistence backend's real project/session directory layout, so Session Persistence reads them cold and Workspace Registry derives the Workspace from their `/dsh/workspace` headers. The main Session exceeds the Client's 50-message page and keeps representative tool results at its tail; persisted one-shot and continuable children exercise the subagent catalog. WebFS authorization and user data remain a separate provider and never share this fixture tree.

Both packages live in `packages/experimental/` as `@deepseek-ai/dsh-experimental-*`, private and outside official releases. The boundary that carries product promises stays in the product packages: the injection table, `__DSH_TRANSPORT__`, and the `/plugins` bundle bytes are owned by `dsh-host-webserver`, `dsh-client-modules`, and `dsh-client-connection`.

## Alternatives considered

**A load-time transform as a safety net.** It turned a broken image into a timing regression nobody attributed, and made "which path lowered this body" unanswerable from outside.

**Contract constants inside the transform, trusting tree shaking.** The transform functions did shake out, but `acorn` declares no `sideEffects`, so the barrel edge alone carried the whole parser into the worker bundle.

**A separate preview template.** The retired `preview.html` template duplicated the served document and drifted (language, title, entry wiring). Deriving the page from the built index at `closeBundle` removes the second document entirely.

**Gating the stock entry on top-level await ordering instead of a deferred.** Sibling module scripts do not wait for one another's top-level awaits; the `??=`-installed deferred makes the handshake order-independent and lets a failed handshake reject into the boot page's failure rendering.

**Generate example state in the Worker at startup.** A preview-only Session or Workspace creation branch would bypass cold persistence loading and make the runtime own test data. Static image files exercise the same discovery and pagination path as existing user data.

**Seed the example through WebFS.** WebFS owns user-selected durable storage and its lifecycle. Coupling the built-in demonstration to it would make a static preview depend on browser persistence state and would blur which bytes came from the deployment.

**Pack one complete base image per fixture.** Full-image variants duplicate the runtime package closure and make combinations quadratic. Restricted overlays keep one immutable base, let the chooser compose zero or more data sources, and give future WebFS hydration the same pre-boot application point.

## Consequences

- `lib/worker.js` contains no parser (423.5 kB → 246.3 kB at the time of the cut, before the shell process layer landed).
- `diff dist/index.html dist/preview.html` is exactly one script tag; `packages/experimental/webworker-packer/tests/image-loadable.spec.ts` pins both halves of the loader contract, the transform semantic suite pins `createRequire` request discovery, and `apps/web/tests/preview-boot.e2e.ts` pins preview usability (boot to an interactive page) in the web browser lane, replacing the retired `apps/web/scripts/preview/` probe scripts.
- The transform corpus imports every built bundle through Node before comparing its lowered exports. Its pinned exemptions name the actual non-importable bundle and fail when one becomes importable: after Win32 process primitives became the Koffi type owner, `win32-process` carries the duplicate-type exemption and `sandbox-windows-acl` does not.
- The served `<base href="/">` anchor exists because relative asset URLs would resolve under the request directory on SPA-fallback paths; remove it only together with the relative build base.
- The image ships as a deterministically gzip-compressed tar (`vfs-image.tar.gz`; MTIME 0, OS byte 0xff): static hosts do not compress binary content types (type allowlists, CDN size caps), so the compression rides the artifact, and the worker inflates the fetch body through the browser's native `DecompressionStream` while it downloads.
- The preview waits at a pre-boot source chooser. Its built-in example opens a reproducible Workspace and cold Session corpus suitable for inspecting tool cards, subagent navigation, and backward pagination without credentials or model calls; the empty selection preserves first-run coverage. Fixture tests validate the physical logs through production readers, and browser acceptance verifies both selections.
