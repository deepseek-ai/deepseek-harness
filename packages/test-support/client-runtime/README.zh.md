---
description: "面向浏览器功能测试的 jsdom slot 测试运行时，供测试作者针对生产机制检验 slot、存储与渲染。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-test-runtime

[English](README.md) | 中文

## 概述

`SlotTestRuntime.create()` 让 Vitest 套件在 jsdom 中驱动生产 slot、store、带类型的 Session 与 Workspace fixture，并对局部 DOM 断言。面向插件激活、重载、重连与清理的测试，`createClientTest` 使用具名端点 Remote mock 启动 web profile 的 bundle roster，无需业务 Host。缺失服务与未打桩调用会明确失败。整机 fixture 拥有启动和销毁，局部 runtime 提供幂等销毁。通过 `devDependencies` 将本包用于客户端测试；它不是产品插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包让浏览器功能测试拥有可挂载的真实运行时：创建测试台，声明你的功能所占用的 slot，挂载功能插件，渲染一个 slot，在局部视图上断言，然后 dispose（资源释放）——全程不存在生产逻辑的第二份实现。

### 搭建功能测试

`SlotTestRuntime.create()` 组装运行时，`declare(children)` 注册一个自动 frame，其逐 key 的 `<div data-slot>` 包裹层成为快照根，`mount(plugin)` 在真实 fiber 上运行功能，`renderSlot(key, owner, opts?)` 返回带限定查询与原位更新的 slot 局部视图：

```text
const runtime = await SlotTestRuntime.create()
await runtime.declare({ 'feature-slot': {} })
const handle = await runtime.mount(FeaturePlugin)
const view = runtime.renderSlot('feature-slot', { owner: props })
expect(view.container).toMatchSnapshot()
await runtime.dispose()
```

`mount` 会预检必需服务，缺失时自明报错——先用 `provide(name, value)` 提供额外服务。运行时提供的 `fileUpload` 替身会拒绝每次调用，直到测试套件替换 `runtime.fileUpload.upload`。`storeOf(key, scopeKey)` 返回渲染器交给 slot 组件的实时存储实例，用于身份与动作驱动写入断言。

可选渲染参数通过 `entryKey` 选择 keyed 条目，或通过 `only` 选择 list 条目；`view.update(owner)` 保留该选择。`runtime.panelInfo` 提供默认的 `usePanelInfo` 数据源，初始不选中全局面板。挂载生产 Layout 所有者之前，先调用 `releasePanelInfoSource()` 释放该数据源。`dispose()` 同时释放默认的工作区与面板信息根数据源；提前释放是幂等的，不会移除替代它们的所有者。

### 局部 DOM 快照

注册的快照序列化器把 CSS-module 哈希类名折回语义名（`_frame_a1b2c3` → `frame`），使 `.snap` 文件只含结构，并把 `<svg>` 内部折叠为 `data-content` 指纹。需要自定义页面 frame 的套件改用 `root.declare(children, Frame)` 而非自动 frame；`dispose()` 沿单一轴拆除视图、功能 fiber、已铸 scope 与持久化存储状态，且幂等。

### 脚本化 Remote 应答与失败

`TestRemote` 是 `ctx.remote` 面的替身：它把自己连同每个被脚本化的命名空间各注册一个服务，使注入 `remote.<name>` 的插件得以解除挂起；`$on` 订阅由显式的测试事件驱动器推动；`$host` 是普通可变字段，套件直接赋值即可脚本化带 home 或非 loopback 的 Host。UI 套件也在本包取用 `RemoteError` 构造器这个值——`dsh-api-remotes` facade 承载不了它，因为从套件发起的值 import 会拉起该装配尚未构建的 `/remote` 产物链。

按 Host 会答的码来脚本化失败，并以生产代码同样的方式断言——判 `code`，绝不判类：

```text
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

remote.goals.create.mockResolvedValue({
  ok: false,
  error: new RemoteError('goal/not-found', 'goal "g1" does not exist', { goalId: 'g1' }),
})
expect(view.getByRole('alert')).toHaveTextContent('goal/not-found')
```

### 整体档

上面的 slot 档把一个功能挂在替身上。整体档起真实装配：`TestClient.start(plan, mock, options)` 进程内 import 每个 roster 行的 `/client` 模块（或取计划里的 `provide` 替换），把 `{ rpc: mock.rpc }` 绑定到该客户端的 Connection 模块，用 `graphFromRoster` 合成启动图并把已加载模块交给生产模块系统，经生产 `bootClient` 启动，按需挂载 `uiRenderer`，再等 `ctx.connection.state === 'connected'`。它藏在深 import 后面，slot 档测试永不加载它：

```text
// @vitest-environment jsdom
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'

const test = createClientTest({ roster: webApp }, { mount: true })
test('registers into the sidebar', async ({ remote, start }) => {
  remote.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
  const client = await start()
  expect(client.ctx.slots.entries('sidebar.settings')).toHaveLength(1)
})
```

`createClientTest` 使用原生 Vitest fixture：每个测试获得已加载 `remoteDefaultResponses` 的新 `mock`、等同于 `mock.remote` 的 `remote` Proxy，以及配置应答后才起机的 `start()`。重复启动共用一个 Promise，调用方必须 await 它来观察启动错误。fixture 收尾等待启动，即使断言失败也销毁客户端、检查漏配，并拒绝测试结束后保存的 `start` 调用。需要分别拥有多个客户端时直接用 `TestClient.start`。这些 fixture 隔离自己的状态，不隔离 `location` 等页面全局。

两档测试的所有命名空间都使用[通用 Remote Proxy](../remote-mock/README.zh.md#remote-proxy)。装配测试使用 `remote` fixture；局部 `TestRemote` 可以接收 `{ settings: mock.remote.settings }`。直接配置返回数据，并读取原生 `.mock.calls`。mutation 应答不会自动更新后续 describe 应答：场景发布新数据时，显式修改 `remote.settings.describe.mockResolvedValue(...)`。Proxy 文档拥有无构建类型说明和必需的构建后本地类型检查规则。

### Roster 与启动行为

`webApp` 是 `web` profile 的浏览器 roster，首次 import 装配入口时从它的 bundle（先 `dsh-base`、再 `dsh-web-app`）按启动器的方式现读，只是匹配不到任何行的补丁在这里抛错、启动器只警告：每个 bundle 的 `dsh.bundle.patch` 列表用 include 插件的 YAML 方言解析、用它的 `applyEntryPatches` 合成，每个未禁用且其包声明 `dsh.client.platform === 'web'` 的行成为一行，带上该声明的 `inject` 与 `immediately`；`bundleRoster(bundles)` 对任意 bundle 列表做同样的事。没有任何东西从 bundle 拷贝出来，bundle 一改下次跑测试就能看见。`webApp.closure(names)` 保留点名的行及其传递注入的全部行（即按 bundle 组合方式起这些插件所需的行），`webApp.pick(names)` 与 `webApp.without(names)` 手工裁剪，三者都对未知名字抛错，`ClientRoster.of(rows)` 内联构造一份。`remoteDefaultResponses` 是 roster 在没有 session、没有 workspace、默认设置下启动时恰好会打的那些 Remote 端点的默认响应；测试用 `mock.load(table)` 在其上叠加自己的 `RemoteTable`，任何没有规则的调用都会在 `dispose()` 时经 `mock.assertNoUnmatched()` 让测试失败。`mount` 要求 roster 提供 `uiRenderer`；否则 `start` 响亮失败而不是返回一个空容器。`client.connection` 是 roster 的 Connection 服务（没有任何 `Context` 增强声明它），`connectTimeoutMs` 限定等就绪的时长，超时消息列出 mock log。`reload(name)` 通过共享的 Client Modules 辅助函数重建一个 Loader entry（先拆 registry，再 `entry.refresh()`）；每个客户端都保留自己的模块系统和绑定实例的 Connection 替换，因此启动与重载可以重叠而无需改写页面全局变量。`unload(name)` 移除 entry 并等待插件清理完成，`flush()` 在 `act` 内让 React 落定。jsdom 既没有 `EventSource`（client-hmr 在 apply 时打开一个）也没有 `ResizeObserver`（布局组件挂载时观察尺寸），所以 `start` 对缺失的全局惰性桩做引用计数，`dispose` 只移除它装的那些——这是 jsdom 的缺口，不是客户端身份通道。每个 roster 里的 `@deepseek-ai/dsh-api-remotes` 行都会被去掉：它生成的 Remote 客户端只存在于构建后的 `lib/`，而 `remote.<ns>` 正是本档要替掉的东西。`start` 改为给 roster 注入的每个 `remote.<ns>` 服务（加上此刻 mock 登记过规则的命名空间；之后才首次登记的命名空间没有代理）提供一个无契约代理；`ctx.remote.<ns>.<method>(...args)` 变成对端点 `<ns>/<method>` 的调用，携带位置参数，mock 登记了 `stream()` 脚本的走流、否则走一元，并沿用生成客户端的结果折叠（载体抛错折成 `gateway/internal`，中止折成 `gateway/cancelled`）。没有规则的端点照样发出，所以 mock 会记下它、`dispose()` 让测试失败。

### 何时使用

当功能套件要在真实运行时下检验 slot、存储、渲染与销毁时使用本测试台——生产 `SlotRegistry`、渲染器与 provide bundle 物化都会被挂载，绝不重实现。它是客户端测试基础设施：永远不触及模型请求，功能包仅以 `devDependencies` 依赖之。

### 可能出什么问题

- **已声明服务未提供**——`mount` 自明报错并列出缺失名称；请先用 `provide()` 提供。
- **在 `declare` 之前尝试渲染**——`renderSlot` 自明报错；请先声明该 key。
- **测试调用会话行为桩上未打桩的动词**——fixture 桩按设计自明报错，缺失的桩会在调用点浮现，而非静默通过。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释测试台的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

测试台不复制生产逻辑：它挂载生产 `SlotRegistry`、生产渲染器与 `UiSession` 适配器。`TestSessions` 与 `TestWorkspaces` 实现功能通过 Cordis 消费的 owner 接口，每个 fixture Session 实现 `SessionFace`，`stubSettingsScope` 实现 `SettingsScope`。`UiSession` 从这些控制器绑定派生标准渲染器数据源。未 stub 的 `ISession` 行为会携缺失方法名失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SlotTestRuntime` 组装、`TestRoot`、自动 frame、`mount`/`dispose` |
| [`src/sessions.ts`](src/sessions.ts) + [`src/workspaces.ts`](src/workspaces.ts) | `ISessions`/`IWorkspaces` 测试替身与 `FixtureSession` 行为桩 |
| [`src/fixtures.ts`](src/fixtures.ts) | 普通 fixture 构造器：会话快照、workspace 列表状态 |
| [`src/snapshot.ts`](src/snapshot.ts) | DOM 快照序列化器（类名哈希折叠、`<svg>` 指纹） |
| [`src/remote.ts`](src/remote.ts) | 用于 host RPC 的 `TestRemote` 替身、`RemoteError` 值转出 |
| [`src/translate.ts`](src/translate.ts) + [`src/locale-env.ts`](src/locale-env.ts) | 翻译与固定浏览器语言测试辅助 |
| [`src/settings-scope.ts`](src/settings-scope.ts) | 带测试驱动发布与写入 spy 的 `stubSettingsScope` |
| [`src/assembly/roster.ts`](src/assembly/roster.ts) | `ClientRosterRow`、`ClientRoster`（`of`/`closure`/`pick`/`without`）、它所标注的 `AssemblyPlan`，以及 `graphFromRoster` |
| [`src/assembly/modules.ts`](src/assembly/modules.ts) | 源码 `/client` 导入及替换，通过生产模块 facade 的待注册工厂队列登记 |
| [`src/assembly/test-client.ts`](src/assembly/test-client.ts) | `TestClient`：绑定实例的 Connection、共享 jsdom 桩、`bootClient`、挂载、等就绪、`reload`/`unload`/`dispose` |
| [`src/assembly/vitest.ts`](src/assembly/vitest.ts) | 测试级 `mock` 与懒启动 `start` fixture |
| [`src/assembly/remote-default-responses.ts`](src/assembly/remote-default-responses.ts) | `remoteDefaultResponses`：roster 启动期 Remote 端点的默认响应 |
| [`src/assembly/remote-proxies.ts`](src/assembly/remote-proxies.ts) | 经 Connection 的无契约 `remote.<ns>` 代理：`remoteNamespacesOf`、`remoteProxiesPlugin` |
| [`src/assembly/bundle-roster.ts`](src/assembly/bundle-roster.ts) | `bundleRoster` 与 `webApp`：用 include 插件自己的 schema 与补丁应用从 bundle 补丁文件读出浏览器 roster |
| — | 不发布运行时不变式伴生入口；本测试支持包不拥有生产事件流或可变数据，而是围绕测试替身组装生产 SlotRegistry 与渲染器。所挂载的生产包拥有各自的不变式，本包行为由本包测试检验。 |

### 生命周期

`create()` 构建全新上下文，挂载 slot 与会话注册表，安装渲染器，并提供 session/workspace 替身和明确失败的文件上传替身。`mount` 在启动 fiber 前对照上下文检查每个已声明注入，使缺失提供方自明报错而非永久挂起。`dispose()` 先卸载 React 树，再 dispose 功能 fiber、释放根注册、dispose 已铸 session scope 并清除持久化存储状态；每个公共修改器都包裹在 act 中，因此测试无需自行处理 SlotCore 微任务批处理或 React `act`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从测试台逐步进入它所挂载的生产机制以及使用它的测试。

- [ui-session](../../client/ui-session/README.zh.md)——从控制器替身派生标准 Slot 数据源的生产适配器。
- [UI slots 包](../../client/ui-slots/README.zh.md)——测试台挂载的 `SlotRegistry` 约定。
- [UI renderer 包](../../client/ui-renderer/README.zh.md)——测试台安装的渲染器。
- [测试策略](../../../docs/testing.zh.md)——覆盖层级与浏览器快照流水线。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无；本包是浏览器侧测试基础设施，不会发起任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本测试台如何被消费。它们是当前包约束，不是任务积压。

- **整体档不运行生成的 Remote 客户端**——`remote.<ns>` 代理转发位置参数，不经过生成的 zod 校验、wire 名映射或 scoped 身份注入；mock handler 直接接收这些参数，生成客户端仍由 built-artifact e2e 车道覆盖。
- **代理调用绕过 Gateway 客户端的 `invoke` 与 `invokeStream`**——不做 `$mount` 生命周期检查，流失败不经 `normalizeConnectionStream` 重新标记，一元拒绝由代理自己用 Gateway 客户端导出的 `carrierFailure` 与 `cancelledFailure` 折叠。`ctx.remote.$stream`、`$on`、`$host` 是真 Gateway 客户端的。
- **未声明的端点按一元调用发出**——代理从 mock 的登记学到每个端点的模式；spec 既没给脚本也没声明（`RemoteTable.streams`、`mock.stream(endpoint)`）的流端点记为 `unary` 漏配，产品代码收到的是折叠结果而不是失败的流。`remoteDefaultResponses` 声明了 roster 启动后才打开的流；无论哪种，`dispose()` 都会让测试失败。
- **本包的 client 编译程序加了 `node` 环境类型**，好让 roster 读取器使用 `node:fs`；slot 档的源码也在这些类型下编译。
- **Session、Conversation 与 Chat fixture 保持分离**——`sessionSnapshot` 只包含 Session 控制器状态，`conversationSnapshot` 包含与目标无关的 Conversation 状态，`chatSnapshot` 包含 Chat 目标状态。组装测试提供 Session 事件条目，而不是向 `SessionSnapshot` 添加 Conversation 或 Chat 字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
