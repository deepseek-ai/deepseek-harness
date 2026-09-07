# Client 模块

[English](client-modules.md) | 中文

Web 插件表：[dsh-client-modules](../../packages/client/modules) 中 client 模块系统的 Node 半，以 `ctx.clientModules`（`ClientModuleRegistry`）形式提供。它扫描宿主 Loader 的 entry，找出声明了 `dsh.client` 的包，组合出 `window.__DSH_BOOT__` entry 图，在 `/plugins` 下提供带版本的单资源或多资源 combo 脚本，并以启动协议行回应每次 index 注入收集——这是同一个服务的四个面。它是 Web GUI 栈的一项可选能力，不属于 agent loop（智能体循环）主干，并且是 [dsh-host-webserver](../../packages/host/webserver) 的消费方：[web-server.md](web-server.zh.md) 所述的载体提供本服务注册的前缀路由与其回应的 `webserver/index-inject` 事件。同一个包的浏览器半（`ctx.modules`，即拉取并物化这些 bundle 的 lazy CJS 模块表）属于内核机件，记录在[包 README](../../packages/client/modules/README.zh.md)中，不在本页。

源码：[`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)

## wire

图是 Node 半与浏览器半之间协议层的唯一真源。宿主从扫描到的包组合出 `WebBootEntry` 行与 `WebBootBatch` 描述，随后在 Vite entry 之前向结构化 index 注入表贡献 registration facade、application preload、bootstrap 脚本与图全局量。`global` 行渲染为 `globalThis["__DSH_BOOT__"]`，其中 `<` 已转义，插件可控的字符串因此无法逃出 script 元素。没有有效 manifest 的页面无法启动：浏览器解析器会拒绝畸形 row 或批次、未知成员，以及未恰好归属一个初始 combo 描述的 entry。

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests (see {@link WebBootGraph.entries}).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Revisioned single-resource combo endpoint used by HMR. */
  url: string
  /** Opaque plugin-artifact revision used for HMR cache busting. */
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

```ts type-equiv
/** Initial scheduling phase for one content-addressed combo script. */
type WebBootBatchPhase = 'bootstrap' | 'application'
```

```ts type-equiv
/** One initial combo script; a scheduling phase may span several descriptors. */
interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application scheduling. */
  phase: WebBootBatchPhase
  /** Content-addressed combo script endpoint. */
  url: string
  /** Revision over the combined plugin script bytes and indexed source map. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
  /** Initial combo descriptors; every entry belongs to exactly one descriptor. */
  batches: WebBootBatch[]
}
```

每个初始 row 的 `rev` 都是不透明的进程 nonce 加序号，因此组合图时不会哈希每个插件产物。HMR 观察到变化后，该 row 的 revision 才改为新 bundle 及其可用 sourcemap 的哈希。初始描述把 row 划入 bootstrap 与 application 两个调度阶段，每个阶段都可以包含多条描述。URL 只含有序 package 资源列表与 revision，阶段名不会进入路由。图组合保持 row 顺序，并在 map 形式 URL 超过 3 KiB 前贪心切分。启动 combo revision 对合并后的插件脚本字节与 indexed sourcemap 求哈希，图 revision 则对 row 与描述一并求哈希。`immediately` 标记第一阶段的 registration barrier；同一 combo 中的 row 共享脚本传输，不同 combo 则独立加载。

## 扫描

包加入这张表的方式，是在自己的 package.json 中声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边、可选的 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle。每个 live row 都从自己的 Loader specifier 与所属 tree `baseUrl` 解析；若 `loader.internal.resolveSync` 可用，则使用 Host face import 所用的同一个实现。最近归属的 package manifest 提供浏览器模块 id，因此相对 source 与 built overlay 仍保留包身份。若不同的 active Loader source 解析到同一包名，组合会失败；一个来源卸载后，仍存活的来源无需重启 fiber 即可提供该 row。

扫描是单包增量的；不存在全量重扫代码路径。fiber 构造或 dispose（资源释放）时的每次 cordis `internal/plugin` 发射都把该 fiber 的 entry 名标脏，一次微任务 flush 把每个脏名与实时 loader entry 对账。激活趟以全部当前 entry 灌入同一个脏集合并同步 flush，因此初扫与稳态共享一条实现——但失败姿态相反。激活时，已加载 entry 中的畸形声明或缺失 bundle 会聚合为一个大声的 `AggregateError`，列出每个损坏的包：该 fiber 进入 FAILED，由启动的大声失败 sweep 上报。稳态下，损坏的包只记录一条警告，且不得殃及其他包。

包元数据——包括「非 client 包」这一否定结论——按 Loader specifier 与所属 tree base URL 缓存至重启。同一来源的 fiber 重启会原样复用其 row 与 rev；bundle 内容变更只经 `rebuilt()` 到达图。

## bundle 路由与 index 注入

`GET`／`HEAD /plugins/??<package-a>/client.js,<package-b>/client.js&rev=<rev>` 提供精确生成的 combo 脚本；单资源请求采用同一形式，也是 HMR 路径。其绝对 `sourceMappingURL` 平行改写每个资源后缀，得到 `/plugins/??<package-a>/client.js.map,<package-b>/client.js.map&rev=<rev>`。即使只有一个资源，map 仍采用 Indexed Source Map v3。组件有自带 map 时直接用于对应 section；没有时则获得 identity section，其 `sourcesContent` 是构建后 bundle，source 名取打包后的 `sourceURL` 或插件路由。每条启动请求 URL 按 UTF-8 字节计算都不超过 3 KiB；切分按更长的 map 形式计算。所有 application URL 都会预加载，所有 bootstrap URL 都会在图全局量与 Vite entry 之前执行。所有已发布响应都使用长期 immutable 缓存。未知或被修改的资源列表、缺少 revision 及陈旧 revision 都返回 404，绝不提供其他字节，也不会让 SPA fallback 把 HTML 当作 JavaScript 返回；其他方法返回 405。注入行在每次 index 渲染时携带当前图，因此重新加载总是基于实时组合启动。

## 服务

```ts type-equiv
/** Filesystem baseline captured before a client artifact snapshot is read. */
interface ClientArtifactBaseline {
  /** Absolute path of the client bundle. */
  readonly path: string
  /** Bundle modification time in milliseconds. */
  readonly mtimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
}
```

`ClientModuleRegistry`（`ctx.clientModules`，定义于 [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)）暴露读取面与重建面；签名见生成的[服务目录](#ctxclientmodules--clientmoduleregistry)。`graph()` 返回当前组合出的图（两次变更之间是同一个稳定对象），`clientPath(id)` 返回 bundle 的绝对路径，`artifactBaseline(id)` 返回读取当前快照前捕获的 bundle stat 值。`rebuilt(id)` 是变化后的 bundle 内容到达图的唯一入口：它把 bundle 与当前 source map 一起重新哈希，只有 rev 真正变化才会重新组合图并发出通知。`onRebuilt` 按发生变化的 bundle 逐个触发并携带新 rev；`onGraphChanged` 在任何一次重新组合了图的 flush 之后触发（行的增删，或 rebuilt 带来的 rev 变化），并采用拉取模型——监听器自行重读 `graph()`。两条通知路径都会兜住监听器异常，因此一个抛错的订阅者既不能让后续订阅者被跳过，也不能杀死触发这次 flush 的一方。

开发环境下，[dsh-client-hmr](../../packages/client/hmr/README.zh.md) 是注册表的监视驱动：它的 Node 半从 module host 读文件前记录的基线出发，对图中每一行的 bundle 做 stat 轮询，只为变化或标脏的 row 调用 `rebuilt(id)`，经 `onGraphChanged` 重新同步监视集合，并通过 SSE（Server-Sent Events）把 rev 变化广播给浏览器半。仅 source map 变化不会触发重载；bundle 变化时，当前 map 会一起进入快照。生产环境的图完全不含 HMR（热模块替换）行；module host 自身从不监视文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The web plugin table service: incremental `dsh.client` scan + wire composition + bundle route + index injection rows. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Serve an advertised revisioned bundle or source map without a Web server.
 * Unknown URLs return 404, unsupported methods return 405, and `HEAD`
 * returns the same immutable headers without a body.
 * @param request - shell-carrier request for a `/plugins` resource.
 * @returns the exact response also exposed by the optional Web route.
 */
fetchBundle(request: Request): Response

/**
 * Filesystem baseline captured before an entry's current bytes were read.
 * HMR compares it with the live files when installing a watch, so a write
 * between startup composition and watch installation cannot disappear into
 * the watcher's initial state.
 * @param id - entry id (package name).
 * @returns the path and baseline, or undefined for an unknown id.
 */
artifactBaseline(id: string): ClientArtifactBaseline | undefined

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
