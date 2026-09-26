# Profile 管理

[English](boot.md) | 中文

[boot 包组](../../packages/boot/README.zh.md)负责 launcher 提供的 profile 访问与插件管理器。[插件管理器](../../packages/boot/plugin-manager/README.zh.md)文档说明持久化、重载与包操作行为。

## 管理记录

`PluginEntryId` 标识一个 Loader 条目；调用方从 `listPlugins` 获取，不自行拼接 patch id。

`PluginInfo` 包含模块标识、实际启停状态、fiber 阶段和可选的展示 `meta`，以及唯一的 `patchId` 或 `readOnlyReason`。

`BundleInfo` 包含包名、可选的安装版本、组合层选择状态、删除可用性及可选的解析错误。它的可选 `meta` 与各行的 `BundleRowInfo.meta` 包含展示文本或元信息诊断；Client 在渲染时选择语言。

`InstallBundleOptions.enabled` 默认为 true，false 表示安装但不选择组合包层。`approvedBuilds` 在安装前向指定的待审批包名授予持久脚本权限。`registry` 指定首先询问的注册表；缺省为配置的那个。

`PluginRegistries` 携带配置的第一个注册表（`null` 即 pnpm 自身配置指定的那个）、随后依次询问的备选注册表，以及 `resolved`——pnpm 自身配置指向的 URL，未读到时为 `null`。`InspectOptions.registry` 指定一次查询首先询问的注册表。

`ChangeResult.changed` 报告磁盘修改，独立于 `application`：`applied`、`restart-required`、`overridden` 或 `failed`。可选的 `error` 包含可本地化的错误码和外部诊断。`packageResult` 记录 pnpm 退出码、有界输出、截断标志及完整诊断日志路径；当管理器终止了一个停止打印的运行，还记录 `timedOut`。被终止的运行不论信号留下什么退出状态都归类为 `timeout`，因此安装与删除都报告失败而非成功，也不会再询问下一个注册表。`pendingBuilds` 列出整个 profile 尚未决定的包；`approvedBuilds` 记录本次操作授予权限的包名；`registries` 按顺序列出一次安装问过的注册表；`failedAt` 说明最后一次失败的运行连不上的是所问的注册表，还是 git 或 tarball spec 自身拉取的主机。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconfigeditor--configeditor"></a>

### `ctx.configEditor` — `ConfigEditor`

Persist complete raw configs and apply them through the normal Loader path.

```ts cordis-catalog
/** Addressable profile rows; nested Includes have independent configuration ownership.
 * @returns Active entries with unique profile patch ids.
 */
entries(): Entry[]

/** Read inherited and explicit profile values for the active entries.
 * @returns Detached layer values alongside their Loader entries.
 */
configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>

/** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
 * @param entry Current Loader entry, also used to detect replacement during the write.
 * @param change Derive a raw config from the current entry and its inherited layer.
 * @returns Fulfillment after Loader reconciliation completes.
 */
async edit( entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>, ): Promise<void>
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/** Read exact plugin-version exemptions saved in this profile.
 * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
 * record or file problem the reader rejected, which the caller reports instead of failing.
 */
@Remote listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }

/** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
 * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
 * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
 * @param enabled Whether to grant rather than revoke the exemption.
 * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
 * @returns Saved and runtime outcomes. Startup-only profiles require restart.
 */
@Remote setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult>

/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
 * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
 * @returns Package versions, manifest descriptions, rows, optional display metadata, activation selections,
 * whether the installation offers the bundle, and removal availability.
 */
@Remote listBundles(): Promise<BundleInfo[]>

/** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
 * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
 */
@Remote async registries(): Promise<PluginRegistries>

/** Read what a spec names before installing it.
 * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
 * @param options The registry asked first.
 * @param signal Ends a registry lookup early.
 * @returns The package the spec names, or why it is refused.
 */
@Remote async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

/**
 * Install a package using the same pnpm implementation as dsh plugin. GitHub
 * repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts;
 * only network failures or timeouts stop installation, while pnpm owns authentication and transport fallback. A run
 * that fails, is cancelled, or adds a package without a bundle patch restores
 * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
 * @param spec One package spec, including local paths relative to the invocation directory.
 * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names,
 * the pending build scripts to allow for this profile before pnpm runs, and the registry asked first.
 * @returns Package-manager diagnostics, the registries asked, and the observed activation outcome.
 */
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Recover the result of an active installation without cancelling it.
 * @param requestId The id supplied when installation started.
 * @returns The installation's outcome after it settles, or null if no active request has that id.
 * Completed results are not retained; null establishes neither success nor cancellation.
 */
@Remote async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>

/** Stop an installation this manager owns and wait until its files are back.
 * @param requestId The id the installation was started with.
 * @returns `cancelled` once the Git check or pnpm exited and the files are restored, `too-late` once the bundle is being
 * applied, `not-running` for any other id.
 */
@Remote async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
 * @param name Installed dependency name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxpluginregistryprobe--pluginregistryprobe"></a>

### `ctx.pluginRegistryProbe` — `PluginRegistryProbe`

Compares public registry responses on the Host; the Client owns the initial selection.

```ts cordis-catalog
/**
 * Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy.
 * Concurrent readers share a probe; a winner cancels and awaits the other request.
 * @returns the first registry with a successful response, or null when disabled or neither responds successfully; results are cached.
 * @throws rejects when the service has been unloaded.
 */
@Remote async fastest(): Promise<string | null>
```

Source: [`packages/client/ui-plugin-manager/src/index.ts`](../../packages/client/ui-plugin-manager/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="app-boot-events"></a>

### `app-boot/*` events

<a id="app-bootconfig-reload--emit"></a>

#### `app-boot/config-reload` — emit

Profile patches were reconciled into the running Loader tree: every entry update settled and no new inactive entry was introduced. Carries no diff; listeners re-read Loader entries.

```ts cordis-catalog
/**
 * Profile patches were reconciled into the running Loader tree: every entry update settled and no new
 * inactive entry was introduced. Carries no diff; listeners re-read Loader entries.
 * @mode emit
 */
'app-boot/config-reload'(): void
```

Source: [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="plugin-manager-events"></a>

### `plugin-manager/*` events

<a id="plugin-managerchanged--emit"></a>

#### `plugin-manager/changed` — emit

The profile's plugins, bundles, or composition changed: a manager operation completed. A patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing here.

```ts cordis-catalog
/**
 * The profile's plugins, bundles, or composition changed: a manager
 * operation completed. A patch generation applied outside the manager,
 * by HMR's watcher after a CLI or hand edit, announces nothing here.
 * @mode emit
 * @param change - what changed.
 */
'plugin-manager/changed'(change: PluginChange): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-log--emit"></a>

#### `plugin-manager/install-log` — emit

One chunk of a pnpm run's output, streamed as the run produces it.

```ts cordis-catalog
/**
 * One chunk of a pnpm run's output, streamed as the run produces it.
 * @mode emit
 * @param chunk - the chunk and the run it belongs to.
 */
'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-state--emit"></a>

#### `plugin-manager/install-state` — emit

An installation moved between its Host phases. `installing` is announced once per registry the installation asks, with the attempt's registry and position; `cancelling` and `applying` once.

```ts cordis-catalog
/**
 * An installation moved between its Host phases. `installing` is announced once per registry the
 * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
 * @mode emit
 * @param progress - the installation's request id and phase, with the attempt while installing.
 */
'plugin-manager/install-state'(progress: PluginInstallProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
