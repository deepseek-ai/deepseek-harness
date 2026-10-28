# Agent Note: Boot the Preview Worker from the shipped profile and fetch lazy chunks on demand

Status: implemented

English | [中文](2026-10-14-webworker-preview-profile-parity.zh.md)

## Problem

The browser Preview ([webworker-runtime](../../../../packages/experimental/webworker-runtime/README.md), [webworker-packer](../../../../packages/experimental/webworker-packer/README.md)) can receive its boot configuration at pack time: the packer runs `dsh --profile web --dump-config` against a temporary home and writes the output to the image's `config/cordis.yml`; the Worker then inserts the whole configuration back as the profile's own patch (one `insert`). Measured on such an image, this has three consequences:

| Symptom | Cause |
|---|---|
| The Plugins page shows no optional bundle | The image only collects rows that appear in the dump, so none of the 11 default-off `OPTIONAL_BUNDLES` is included; the Worker's `installAnchor` points at the profile's own package.json, which declares no installation dependencies |
| Even when added, some bundles do not take effect after they are enabled | Bundle layers apply before the profile patch, when the base rows do not exist yet: the session-titles disable patch is skipped, agent-team produces 4 `entry not found` warnings, and rows a bundle inserts move to the front |
| The image is 12.79 MiB | 4 lazily loaded chunks (documentpreview's pdf, excel, and frontmatter chunks and sidebar-terminal's terminal chunk, about 4.4 MiB together) download together with the code needed at startup |

Measured: with no bundle enabled, the two compositions differ in only one of 188 rows, the `compression: none` setting of `session-persistence-jsonl`. The differences come from how the configuration is layered, not from the data itself.

## Decision

### Boot the same profile as the served Web deployment

The served launch path (apps/cli, app-boot) carries no Preview-specific code; the webworker packages reproduce it:

- **packer**
  - Package roster = `PROFILE_TEMPLATES[profile].bundles` + `OPTIONAL_BUNDLES` + the rows named in those bundles' patch files; the bundle packages themselves also enter the image (patches, locale, and icon through the publish view). Both tables are read from `@deepseek-ai/dsh-official-bundles`, the same source the Plugins page uses.
  - The image carries a manifest-only `node_modules/@deepseek-ai/dsh/package.json` (a verbatim copy of `apps/cli/package.json`) as the installation anchor, and the image manifest names it in `installation`.
  - The image carries no composed configuration and no `config/cordis.yml`; the image manifest records the `profile` the Worker boots.
  - The image carries a home patch, `home/cordis.patch.yml`: for each row the runtime's `PLATFORM_ENTRY_CONFIG` names (`session-persistence-jsonl`), the config the template's bundle layers compose with the required fields over it (`compression: none`). A patch replaces a row's whole config, so the composed fields stay; the bundle files read at pack time are the ones in the image.
- **Worker**
  - The image's app-boot `loadProfile` initializes `home/profiles/<profile>` from the template, the Worker writes an empty root `cordis.yml`, and `readProfilePatches` composes the layers.
  - profileContext is filled the way `runProfile` fills it: name, dir, patchPath, installAnchor, startedBundles, cwd, home, and an empty overlay list, so the Worker calls `readProfilePatches` once, as the launcher does without `--patch`.
  - The Worker provides a launchEnvironment snapshot and mounts `PluginPackages` without a resolution.
- **Retained platform differences**: jsonl `compression: none` through the image's home patch (ConfigEditor rejects edits to that row's config, as it rejects any row a home patch overrides), the module loader (the Worker's own CommonJS loader, provided through the Node internal-module interfaces in the next section), log output, command-line arguments, appReady timing, no pnpm, and no process-level proxy or signal handling.

The Worker uses existing app-boot exports; app-boot has no Preview override or injection point.

### Node internal-module interfaces in the Worker

Plugin metadata reads (`readPluginMeta`), configuration schema dumps, and HMR do not go through ctx: they take Node internal modules directly through `ModuleLoader.fromInternal()` or `node-addon-require-builtin.requireBuiltin(id)`. A Worker that hides those modules, for example by reporting `process.versions.node` as `0.0.0` so that `fromInternal()` returns undefined, breaks these callers once `PluginPackages` is mounted: every bundle on the Plugins page reports "Plugin metadata requires the Node module resolver", and HMR, which finds no `loadCache`, returns `restart-required` for every switch.

- **Interfaces only**: the Worker replaces `node-addon-require-builtin` with a static module whose `requireBuiltin(id)` answers the 5 modules callers read, under Node v24.18.0 ids, with Node's member names and signatures; every other id throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. `process.versions.node` reports `24.18.0`, and `execArgv` carries no `--expose-internals`.
- **`internal/modules/esm/loader`**: the cascaded loader's `resolveSync(parentURL, request)` and `import` delegate to the Worker's existing loader, and failed resolution carries Node's `ERR_MODULE_NOT_FOUND` or `ERR_PACKAGE_PATH_NOT_EXPORTED`; `loadCache` is an empty `LoadCache`; `getOrCreateModuleJob` exists and refuses when called. The Worker loader instance owns the cascaded loader.
- **Members HMR replaces**: `Module` from `internal/modules/cjs/loader`, `package_json_reader`, the `modules` binding from `internal/bootstrap/realm`, and `ResolveCache` from `module_map` keep Node's member names so HMR can replace and restore them; they refuse when called. The Worker's own `require` does not route through them.
- **One cascaded loader**: the Worker does not override `ctx.loader.internal`; the Cordis Loader and static callers reach one cascaded loader through `fromInternal()`.
- **Node behavior for measured callers**: `node:path.win32.isAbsolute` (icon path validation) and `node:util.inherits` (`http-errors`), both following Node's source.

### Inspector degradation on platforms without worker_threads

The Worker's structural stubs throw errors carrying `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. The Inspector Host degrades only when its Worker fails to start with that code: it warns once, the bootstrap route answers 503, and it registers no DevTools route, injects nothing, and provides no `inspector` service; every other startup failure fails the fiber. `serve-static` and `open` load after the Worker starts, so a degraded start never loads them. Session Inspector in the same bundle therefore runs.

### Separate archives for lazily loaded chunks

- **Classification**: the client build preset emits package-local chunk requests only as `require.async("./client.<name>.js")`, and `verify-client-packages` forbids synchronous chunk requires. The packer's `lazyChunksOf` scans every page asset in the swept image (each package's `lib/client.js` and `lib/client.*.js`) for these literals, so a chunk that another chunk requests is found without following requests from the `./client` entry. A target that a package's `./client` export names under any condition (such as `client.browser.js`) loads eagerly and stays in the base image; every other target leaves it. A request for a chunk the package does not publish fails the pack.
- **Archives**: each chunk gets one deterministic tar.gz named `lazy/<sha256>.tar.gz` after the SHA-256 of the compressed archive. The base manifest's `lazy` list records each archive as `{ archive, files: [{ path, size }] }`, with no file mode. There is no size threshold.
- **Registration**: the Worker registers each listed file with `MemoryVfs.deferArchive`, which creates its parent directories and gives it the VFS default file mode; an image that lists lazy archives must be fetched from a URL, against which the archive names resolve. `exists`, `stat`, and `readdir` answer synchronously from the registration.
- **Fetch**: the asynchronous faces of the Worker's `node:fs` and `node:fs/promises` that read a registered file wait for its archive: `fs.promises.readFile`, `fs.promises.open` (so every FileHandle opens after arrival), `fs.promises.cp`, and `fs.createReadStream`. The first of them fetches the archive, inflates it, checks that it carries exactly the registered paths at the registered sizes, and materializes the files; concurrent readers share one fetch. The digest in the archive name is not verified. A failed fetch fails only the reads waiting on it; the files stay registered and the next asynchronous read fetches again.
- **Before arrival**: synchronous reads, and writes, appends, truncation, chmod, renames, and links in their synchronous and promise forms, are refused with `ERR_DSH_VFS_DEFERRED`, naming the archive; a directory rename that would move a registered file is refused before the destination changes, so the destination stays as it was. Unlink and recursive removal drop the registration, and seeding the path replaces it; an archive that arrives afterwards leaves those paths as they are.
- **client-modules**: `chunkResponse` reads a chunk with `fs.promises.readFile` inside `lazyBody`, which shares one read among concurrent requests and drops a rejected read once it settles, so the next request reads again. Under Node the asynchronous read returns the same bytes as a synchronous one.

### Watching and Client plugin delivery

- Worker `fs.watch` and `fs.watchFile` listeners run in the async context where the watcher was created, as Node delivers watch events from the watch handle, not in the context of the code whose write produced the event. HMR's configuration watcher therefore runs outside the writer's HMR transaction, and a configuration write made inside a transaction does not make the follow-up reload fail as a nested transaction.
- The browser half of `@deepseek-ai/dsh-client-hmr` reads `/plugins/events` through the page's `__DSH_TRANSPORT__.fetch` when a shell provides one (the Worker preview tunnel), otherwise through `EventSource`. The Client plugins of a bundle enabled in the Preview therefore mount without a page reload.

## Alternatives considered

**Keep the pack-time composition and wrap it in a synthetic base bundle inside the Worker.** The change is smaller, but the synthetic bundle appears in the plugin list, the self-composed pack-time configuration remains, and the Preview still differs from the served Web deployment.

**Fetch chunks with synchronous XHR in the Worker.** client-modules stays unchanged, but the whole Host tree blocks while the download runs.

**Prefetch in the tunnel by recognizing chunk request URLs.** The tunnel would need a copy of client-modules' `/plugins/<id>/<file>` routing rules.

**Combine archives per package or above a size threshold.** Each `require.async` needs exactly one file, so one archive per chunk fits best; a threshold would be a tunable with no supporting evidence.

**Port Node v24's CommonJS loader and resolver into the Worker and replace the Worker's whole `require` pipeline.** Resolution would match Node exactly, but it requires Node's condition set (changing image contents), cjs-module-lexer for named exports, and about 300 KB more in worker.js, while callers need only the internal-module interfaces.

**Inject a resolver into `readPluginMeta`.** It changes an app-boot public function to accommodate a platform difference, and other `fromInternal()` callers such as the configuration schema dump still get no loader.

**Emulate `--expose-internals`.** Without that flag, the vendored Loader, HMR, and app-boot all fall back to `node-addon-require-builtin`, so replacing that package covers every caller.

## Consequences

The Preview boots the composition the served Web deployment boots. With no bundle enabled, the Worker composition differs from the served Web composition only by the jsonl platform override, and enabling any bundle skips no patch. The Plugins page and Settings → Built-in plugins list every `OPTIONAL_BUNDLES` entry with its title and icon and no metadata error. Switching each of the 11 optional bundles on and then off returns `applied` both times; after enabling, every enabled row it changes is active, and after disabling, the plugin list returns to its prior rows. Enabling session-titles disables `@deepseek-ai/dsh-session-title-first-prompt-llm` (row `session-title-llm`) and enables `@deepseek-ai/dsh-session-title-all-prompts-llm`, as in the served Web deployment; enabling inspector-profile runs Session Inspector and starts the NodeJS Inspector degraded. Degradation requires `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, so a served `dsh web` runs the full Inspector.

Size (MiB, measured): the base image is 9.20 (12.79 with pack-time composition and eager chunks, −28%) including 11 optional bundles, plus 5 lazy tar archives totaling 4.45 (pdf 2.88, excel 1.39, terminal 0.13, frontmatter 0.05, Inspector bottom panel 0.00). The base image contains no lazily loaded chunk, and the page fetches an archive only when it requests the chunk.

The trade-off costs:

- HMR replaces no modules: the Worker's ES module cache stays empty, so a module file changed in the VFS keeps running its loaded code while HMR reports `applied`. The Preview image changes no module files (package operations fail with the `execa` refusal).
- The Node internal-module members that exist only by name refuse when called; a future caller that invokes them fails explicitly in the Preview.
- Reporting `process.versions.node` as `24.18.0` can change third-party code that branches on the version; a scan of the image found only undici selecting wasm SIMD by version on ppc64, which does not apply to the Worker.
- CommonJS `require('stream')` returns the module namespace rather than the `Stream` constructor, so code that passes it to `util.inherits` fails at load.
- Capabilities in optional bundles that cannot run in a browser (sqlite, terminals, local speech recognition) fail when used: enabling them reports no error, and using them does. A degraded NodeJS Inspector keeps only its bootstrap route, which answers 503.
- The image layout carries no `config/cordis.yml`, `WorkerHostOptions` has no `configPath`, and an image manifest without `profile` fails validation, so an image packed with a composed configuration must be repacked.
- Deferred files require readers to use the waiting asynchronous faces; a new synchronous reader fails explicitly in the Preview instead of degrading. The Worker checks only the registered paths and sizes of an arrived archive, not the digest that names it.

## Testing

- [profile-image.spec.ts](../../../../packages/experimental/webworker-packer/tests/profile-image.spec.ts) pins the roster (template bundles, every optional bundle, and the packages their patch rows name) and an image that records the profile and installation and carries only the installation manifest.
- [lazy-chunks.spec.ts](../../../../packages/experimental/webworker-packer/tests/lazy-chunks.spec.ts) pins one archive per `require.async` chunk, identical archive names and bytes across packs, refusal of an unpublished chunk, and `./client` export targets kept in the base image.
- [lazy-archive.spec.ts](../../../../packages/experimental/webworker-runtime/tests/storage/lazy-archive.spec.ts) pins registration answers, `ERR_DSH_VFS_DEFERRED` refusals, the unchanged rename destination, removal and seeding, one shared fetch, retry after a failed fetch, and the waiting `node:fs` faces.
- [require-builtin.spec.ts](../../../../packages/experimental/webworker-runtime/tests/node/require-builtin.spec.ts) pins the provided internal modules, refusal of other ids with the platform code, the cascaded loader, the members HMR replaces, and the reported Node version; [fs-watch-context.spec.ts](../../../../packages/experimental/webworker-runtime/tests/node/fs-watch-context.spec.ts) pins watcher listeners running in the watcher's creation context.
- [bootstrap-route.host.spec.ts](../../../../packages/experimental/inspector/tests/bootstrap-route.host.spec.ts) pins Inspector degradation; [transport.client.spec.ts](../../../../packages/client/hmr/tests/transport.client.spec.ts) pins the page-transport event stream; [node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) pins the chunk read retry.
- [preview-boot.e2e.ts](../../../../apps/web/tests/preview-boot.e2e.ts) boots the packed Worker deployment, requests a lazy chunk through the tunnel, switches every optional bundle on and off, checks the session-titles and inspector-profile rows, and mounts an enabled bundle's Client plugin without a reload. The image sizes are measured, not pinned by a test.
