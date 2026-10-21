# Agent Note: Host release 变化时提示刷新页面，而不是跨 release 热替换

Status: implemented

[English](2026-10-14-host-release-change-refresh-prompt.md) | 中文

## Problem

`dsh web` 升级后，或开发者在另一个 commit 上重启 `pnpm run dev:web` 后，已打开的浏览器页面会自动重连到新 Host，但页面的静态 shell 仍停在旧 release。协议一旦不兼容，页面会一直重连失败或报错，用户也不知道需要刷新。

技术原因：

- 重连后，[client-hmr](../../../../packages/client/hmr/src/client/index.ts) 会收到新 Host 的完整 graph，[ClientEntries](../../../../packages/client/modules/src/client/entries.ts) 按每行的 `rev`（bundle 的 mtime、ctime 和大小）热替换插件。Vite shell、静态库和 bootstrap 在页面生命周期内从不替换。
- API 连接按精确键集合校验 ready 帧（[remote-events.ts](../../../../packages/api/gateway/src/client/remote-events.ts)），协议一变，旧页面无法自行恢复。
- 页面没有任何途径得知 Host 已换成另一个 release。
- Desktop 不受影响：Host 被替换后，main 进程会重新导航窗口（[main.ts](../../../../apps/desktop/src/main.ts)）。

[client plugin loading model](../architecture/2026-07-23-client-plugin-loading-model.zh.md) 负责加载链与热替换，它写明静态库和 shell 需要刷新页面；本 Note 负责页面如何得知 Host 的 release 变了，以及之后怎么处理。

## Decision

release 指 Host 的版本身份：版本号加可选的源码 commit。名字刻意区别于 build，后者指构建过程和构建产物。

改动落在三处：client-modules（产生、下发和比较 release 身份）、共享 client 构建预设（把 commit 固化进 Host 产物）、ui-settings-general（确认框）。web-app 和 client-hmr 不改。

### 行为

只有当前连接的 Host 提供的是页面启动时的 release，页面才应用 Host 的 graph 和 rebuilt 帧。所以页面运行的每个模块都属于启动 release：要么是原封不动的启动产物，要么是启动产物加上同一 release 的 Host 发布的热替换。

| 场景 | 行为 |
|---|---|
| Host 提供启动 release，graph 与已应用的相同 | 什么都不做。 |
| Host 提供启动 release，部分模块 revision 不同 | 照常只热替换变化了的模块；已弹出的对话框关闭。 |
| Host 提供另一个 release（版本号或 commit 不同） | 不应用它的任何内容，忽略 rebuilt 帧，对话框显示 Host 和页面的版本变化。 |
| 用户选择**刷新以加载新版本** | `location.reload()` 以 Host 的 release 启动页面。 |
| 用户选择**暂不刷新**、关闭按钮、点击遮罩或 Escape | 对话框关闭；页面保持启动 release，不应用该 Host release 的任何内容；该 release 的后续 graph 不再提示。 |
| Host 回到启动 release | 对话框关闭，照常按 revision 对比，只替换变化了的模块，没变的保持不动。 |
| Host 换到被撤回的那个以外的 release | 再次弹出对话框。 |

页面只在内存里记住最近一次撤回的 Host release，不写 localStorage 或 IndexedDB。刷新后以新的启动 release 为比较基准。

### Release 身份

- 字段：`{ version, commit? }`，两个字段都相等才算同一 release。每次完整构建（包括正式发布）都会记录仓库 commit，所以页面比较的是两个字段；发布新版本时两者一起变。
- `version` 取 client-modules 自己 package.json 的版本。所有包同一版本号发布，所以它等于 CLI 版本。
- `commit` 在构建时固化。共享 client 构建预设 [tsdown.client.ts](../../../../packages/client/tsdown.client.ts) 给每个 client 包的 Node 半侧注入与浏览器半侧相同的公开 `process.env.DSH_CLIENT_*` 取值（[`clientBuildValueDefines`](../../../../scripts/client-build-environment.ts) 只替换具体变量，保留 `process.env` 本身）。client-modules 的 Host 代码读 `process.env.DSH_CLIENT_COMMIT_HASH`，在构建产物里是常量。
- 从 TypeScript 源码启动的 Host 没有构建这一步：`pnpm run dev:web` 把构建取值放进 Host 进程环境，因此读到的是同一个 commit；不经 dev-web 的源码启动只发布版本号。
- 字段值属于 wire 数据，对话框原样显示，不做本地化。

### Wire

```
WebBootRelease { version: string; commit?: string }
WebBootGraph {
  rev; entries; batches   // unchanged
  /** Host release identity; absent from a Host that publishes none. */
  release?: WebBootRelease
}
BootManifest { ...; release?: WebBootRelease }
```

- [ClientModuleRegistry](../../../../packages/client/modules/src/index.ts) 在构造时计算一次 release，由 `compose()` 写入每个 graph；`release` 不计入 `graph.rev`。不新增配置项，组合配置不变。
- `__DSH_BOOT__` 和每个 SSE `graph` 帧都带这个字段，所以一个 graph 帧同时携带 Host 的 release 和完整模块图；client-hmr 的 Host 半侧不变。rebuilt 帧与同一条 SSE 连接上前一个 graph 帧来自同一个 Host 进程，因此沿用那一帧的 release。
- `parseBootManifest` 允许 `release` 缺省，拒绝非字符串的 `version` 或 `commit`，并丢弃身份以外的成员，因此相等判断只看这两个字段。`readRelease` 只读取收到的 graph 的 `release` 成员，所以页面先比较 release，再校验其余内容；读不出的 release 视为缺省。不认识该字段的旧页面会忽略它。

### 页面侧

release 比较在 [release-change.ts](../../../../packages/client/modules/src/client/release-change.ts)；`ClientEntries` 在 `sync` 和 `reload` 中调用它。

```
interface ClientReleaseChange {
  /** Release this page booted from; every module the page runs belongs to it. */
  readonly page: WebBootRelease | undefined
  /** Release the Host served before its latest release change. */
  readonly previous: WebBootRelease | undefined
  /** Release of the connected Host. */
  readonly host: WebBootRelease | undefined
}

class ReleaseChangeGate {
  /** Release change to announce; undefined while the Host serves the boot release or a dismissed one. */
  readonly change: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Whether the connected Host serves the boot release; graphs and rebuilt frames apply only then. */
  get matches(): boolean
  /** Record a received graph's release and update the announcement; true when the graph may be applied. */
  observe(release: WebBootRelease | undefined): boolean
  /** Stop announcing the connected Host's release. */
  dismiss(): void
}

class ClientEntries {
  /** The gate's change. */
  readonly releaseChange: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Stop announcing the connected Host's release; updates stay paused until the Host returns or the page reloads. */
  dismissRelease(): void
}
```

调用顺序：

1. `ClientEntries` 以启动 manifest 的 `release` 创建 gate。
2. `sync(graph)` 先用 `readRelease` 读出 graph 的 release 交给 `observe`，再解析其余部分，所以即使页面读不懂另一个 release 的格式也会弹框。启动 release 的 graph 经过解析后照常调和，原有的 revision 对比只替换变化了的模块。其他 release 的 graph 直接返回，不进入调和队列；它首次出现时用 `console.warn` 记录 Host 之前和当前的身份并发布变化，除非它就是最近一次撤回的 release。
3. Host 提供其他 release 期间，`reload(id, rev)`（rebuilt 帧）立即返回。
4. `retry()` 继续调和上次应用的 graph，它始终属于启动 release。
5. UI 的 inject 面通过 `location.reload()` 刷新页面；`ClientEntries` 不负责导航。

### UI

- 归属：[ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts)，它已经拥有连接状态药丸（`ConnectionIndicator`）和 Desktop 更新提示；其 `inject` 增加 `modules`。
- 它通过 `ctx.slots.inject('shell.overlay', ...)` 注册 `shell.overlay` 条目 `host-release-change`，用 `Modal` 渲染。inject 面提供 `hooks: { releaseChange: ctx.modules.entries.releaseChange }`、`dismissRelease` 和 `reloadPage`。
- 文案在中英 locale 字典里：一个标题、一句说明热更新已暂停直到刷新，以及两行灰色标签的版本：
  - **服务**：`previous`（灰）→ `host`（实色），1px 绿色实线箭头，表示 Host 已经切换。
  - **页面**：`page`（实色）→ `host`（灰），1px 灰色虚线箭头，表示刷新后才会切换。两条连接线固定 56px，不撑满对话框。
  - 每行两端版本号不同时显示版本号，否则显示 commit；页面读不出的 release 或字段（包括 Host 没发布的）显示**未解析**。读屏把两行当文字读，箭头只是装饰。
- 按钮为**暂不刷新**（带 `data-modal-autofocus`）和**刷新以加载新版本**（主按钮）。对话框不是用户操作打开的，初始焦点落在保留页面一侧，用户在输入框里按下的回车不会刷新页面、丢掉草稿。关闭按钮、点击遮罩和 Escape 通过共用的 `Modal` 关闭行为等同**暂不刷新**。

## Alternatives considered

- **自动调用 `location.reload()`**：可能丢失尚未保存的输入，而且应当让用户看到并确认刷新。
- **把身份放进 API ready 帧（`ConnectionHostInfo`）**：协议不兼容时 ready 帧本身就可能解析失败，检测根本不会发生；暂停热替换仍然属于 `ClientEntries`。
- **由 web-app 拼身份（CLI 版本 + web-app 版本 + commit），通过 `webApp` 服务和组合配置交给 modules**：要改 web-app 的服务接口、测试、文档和生成的 API 清单，还让 modules 等待 web-runtime 激活；两个版本号一起发布，分开读取没有区别。
- **给 client-modules 加 `commit` 配置项，在组合配置里写 `!!js process.env.DSH_CLIENT_COMMIT_HASH`**：运行时读环境变量，而正式发布的 `dsh web` 不设置这个变量；commit 必须在构建时固化。
- **client-modules 依赖 app-boot 读取 CLI 版本**：要新增依赖边、依赖策略分类、tsconfig 引用和 lockfile 改动，而本包自己的版本就是同一个数。
- **把判断逻辑留在 `ClientEntries` 里**：调和与 release 比较是两件独立的事；拆出 gate 后 `ClientEntries` 只多几行。
- **选择暂不刷新后应用另一个 release 的插件更新**：页面会在一个 release 的 shell 和静态库上运行另一个 release 的插件，其状态无法再用一个 release 描述；回到启动 release 时还得再问一次，而两个选择的结果完全相同。
- **字段命名为 `build`**：容易和构建过程、构建产物混淆。
- **在 client-hmr 里重开被永久关闭的 SSE**：端到端重启测试中从未出现 404 窗口，浏览器自带的重试已覆盖连接被拒；这个缺口记为已知限制。
- **把选择写进 localStorage**：这个选择只关乎一个页面的代码，而刷新会替换这些代码，所以不应比页面活得更久。
- **记住每一个撤回过的 release**：页面在多个 Host release 之间来回切换的情况很少，出现其他 release 后再问一次只多一次点击。
- **身份保持一个不透明字符串，由页面拆出版本号和 commit**：显示规则需要分开这两部分，从拼接字符串里拆解，格式一变就会出错。
- **新建一个独立 UI 包**：要多做三处注册，而 ui-settings-general 已经拥有连接状态和更新提示。

## Consequences

- 升级后的 Host 或换了 commit 的开发 Host，永远不会把插件代码热替换进另一个 release 的页面；页面按自己的 release 继续工作，直到用户刷新。
- Host 提供其他 release 期间，插件更新（包括在 Host 上启用或停用插件）要等刷新后才会到达页面。
- Host 回到页面的 release 时，只替换 revision 不同的模块。revision 取自产物元数据，所以即使重新构建出的代码完全相同，也会把重建过的模块替换一次，不弹框。
- 组合里没有注册确认框时，仍会暂停来自其他 release 的更新并记录警告，用户看不到提示。
- API 连接和 SSE 是两条独立通道，旧页面可能在确认框出现之前就已显示协议错误。
- 重启中的 Host 若在注册路由前对 `/plugins/events` 返回非 200 状态，浏览器会永久关闭这条 SSE，页面在刷新前检测不到 release 变化。
- 不经 dev-web 的源码启动没有 commit，开发期只能检测到版本号变化。
- 每个标签页各自提示、各自记录。
- 单元测试通过 `ClientEntries` 固定 gate 的行为（同一 release 的替换、其他 release 不应用任何内容、回到启动 release 只替换变化了的模块、撤回、缺失 release），并覆盖 manifest 解析、Host 发布的 release、共享预设给 Node 半侧的 define，以及确认框的渲染与回调。
