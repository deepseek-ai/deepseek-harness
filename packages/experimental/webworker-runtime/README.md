---
description: "Browser-worker harness hosting for maintainers building or debugging the experimental Web preview runtime."
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-runtime`

English | [中文](README.zh.md)

## Summary

The browser worker host: the whole harness plugin tree runs inside one dedicated Web Worker, for preview deployments and packaging regressions ([experimental stance](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.md)). The worker inflates a packed VFS image off its download and mounts it in memory, loads its modules through a CommonJS wrapper loader, and serves the page over a postMessage tunnel that speaks plain HTTP. Use it when a preview must run the packaged harness without a Node host.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Three artifacts from one tsdown pipeline:

- **`lib/index.js` (assembly library)** — `createWorkerHost`/`startWorkerHost` mount the base image and any ordered data overlays (`storage/`), install the module loader (`module-system/`) and the `process` shim, boot the tree through the image's own `dsh-app-boot`, and hand the tunnel its serving seams. Overlays may replace files only under `home/` and `workspace/`; they cannot replace the base manifest, configuration, or modules. The image layout contract (`image-layout.ts`: virtual root, config/manifest paths, empty directories, the `lowered` wrapper-contract gate) is shared with the packer. Boot patches force the deployment-shaped rows: frontend serving off, JSONL session logs on the plaintext path, preset roots onto the image's `config/agent-presets`.
- **`lib/worker.js` (worker bundle)** — the assembly plus this package's Node-compatibility layer as one self-contained ES module. The module proxy table (`module-proxies.ts`) is the only platform fork: `node:*` builtins over VFS/tunnel/browser primitives, structural stubs that fail loud on the console for what a browser cannot do, and native/binary package replacements. `node:module` supplies `createRequire().resolve` and `.resolve.paths()` over the image package root, so unchanged packages can discover manifests without evaluating their modules. The global `process` shim carries Node detection fields including `title`, preventing Worker execution from entering DOM-only branches. The pack-time parser reports statically named module requests, including module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named `node:module` or `module` import, to the packer's reachability walk. Stored, CommonJS-obtained, and rebased `createRequire` calls require image entry seeds. VFS mutations drive `node:fs` callback, polling, and promise watchers; open descriptors retain file identity and access mode across rename, replacement, and unlink; `readable-stream` supplies the stream state machine used by file streams and unchanged image packages such as Chokidar and readdirp. AsyncLocalStorage carries sync-stack causality across `await` through the snapshot/restore faces the pack-time lowering injects. The worker holds no compiler: an image the packer did not lower is refused at mount ([note](../../../.agents/notes/implemented/architecture/2026-08-20-webworker-pack-lowering-and-preview.md)).
- **`src/shell/` (the worker's own process layer)** — a browser worker cannot fork, so `node:child_process` is not a stub but an implementation: `spawn` starts the command in its own Web Worker — this same bundle, told by its first frame to be a shell process — and reports it through the `ChildProcess` surface the subprocess service consumes. The command runs off the host's thread, `SIGKILL` terminates it whatever it is doing, and it reaches the VFS only by message (the host serves those frames). Worker platform executables preserve native-package protocols such as Landlock without replacing their JavaScript packages or coupling their implementations to `node:child_process`; ordinary commands use the package's evaluator and coreutils command table. The grammar is `@yarnpkg/parsers`' `parseShell`, while `execSync`/`fork` still refuse because they need a real process.
- **`lib/client.js` (page half)** — startup has two independent stages. `chooseWorkerHostSource({ image?, fixtureManifest? })` optionally owns the boot barrier and fixture manifest: without `preview-fixture` it waits at the source chooser, while a valid query selects directly; either path returns ordered overlays. `connectWorkerHost(worker, { image?, overlays? })` remains the public base-runtime connector; callers that skip the chooser get an empty overlay list. `apps/web` invokes both and supplies its statically bundled Worker. The opening `init` frame carries the base and ordered overlay URLs, the boot payload delivers the structured index-injection table, and `applyIndexInjections` executes it before the shell entry runs. Script preload rows are advisory and skipped because `/plugins` resources resolve only through the tunnel; `loadBundle` fetches each combo on first demand, embeds its tunnel-only source map as a Base64 data URL, and executes the script as a Blob. The tunnel also exposes fetch-shaped transport, the independent file-upload carrier, and the API client. Request frames preserve Blob bodies through structured clone and transfer `ReadableStream<Uint8Array>` ownership. The Host Worker streams both forms into the route, so neither browser thread creates a complete byte array for a generic-file upload.

Acceptance lives in `apps/web/tests/preview-boot.e2e.ts`, which serves the real built pages and drives the pre-boot chooser plus Worker activation in headless Chromium. The empty selection exercises first-run startup. The `vfs-example` overlay supplies ordinary workspace files and plaintext persistence artifacts for cold Workspace/Session discovery, tool presentation, subagent navigation, and history paging without a model request. The chooser reserves WebFS as a separate user-authorized source; that provider does not read the built-in fixture.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only hosts the tree in a browser worker and answers its `node:*` calls; every model-facing registration belongs to the plugins it boots.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The worker composition writes plaintext session logs** (`compression: 'none'` boot patch): it carries no Zstandard codec, so exported logs are `.jsonl`, never `.jsonl.zstd`.
- **`node:dns/promises`, `node:vm`, `node:net`, `node:sqlite`, `node:worker_threads` are structural stubs**: every call reports its refusal on the console and throws. Rows needing native DNS, a real process, or realm isolation cannot run here.
- **Filesystem watchers observe only the mounted VFS**: image seeding is silent and the VFS has no symlinks or external writers. `persistent`, `ref()`, and `unref()` preserve the Node API but cannot control a dedicated Worker's lifetime because browsers expose no ref-counted event loop.
- **Worker confinement is a VFS boundary, not kernel Landlock**: `read-only` and `workspace-write` run the unchanged `@deepseek-ai/node-addon-landlock-run` JavaScript and launcher argv, but the process layer implements the logical `landlock-run` executable and enforces its grants on every shell filesystem request. `full` therefore covers the Worker command table and mounted VFS only; it does not claim arbitrary native-process execution or Linux kernel isolation.
- **The worker bundle pins a path inside `@yarnpkg/parsers`** — the build resolves the package's own `lib/shell.js` instead of its root, whose barrel also re-exports the Syml parser and so drags js-yaml into a bundle that never parses that format (around 175 kB, plus its module body at worker start). The path is derived from the package manifest, so a layout change fails the build rather than reinstating the barrel; upgrading the dependency means re-checking that the shell parser still lives there.
- **The shell is not bash**: no loops, functions, `case`, job control, or process substitution — the grammar stops at pipelines, `&&`/`||`, subshells, groups, redirections, and expansion. `&` runs its command to completion in place, `sed` accepts only substitution scripts, patterns are JavaScript regular expressions, and the command table holds coreutils only (no `git`, no network tools).
- **A shell process has no synchronous filesystem**: it reads and writes the host's VFS by message, because blocking on a reply would need `SharedArrayBuffer`, which requires a cross-origin isolation GitHub Pages cannot grant. Directory-walking commands therefore cost one round trip per entry, and two concurrent commands can interleave their writes.
- **Transport, worker-host, and page-half coverage needs a browser-grade harness** — the per-file coverage gate is unmet for those modules; unit specs cover storage, ALS, the transform, and the stub contracts.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package is pre-Cordis platform glue — the tree it boots runs the product packages' own invariants, and the assembly's contracts (image contract gate, tunnel refusals) fail loud at boot rather than drifting at run time.
