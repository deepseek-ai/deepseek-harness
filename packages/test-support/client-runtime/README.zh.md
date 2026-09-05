---
description: "面向浏览器功能测试的 jsdom slot 测试运行时，供测试作者针对生产机制检验 slot、store 与渲染。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-test-runtime

[English](README.md) | 中文

## 概述

`dsh-client-test-runtime` 让浏览器功能测试拥有真实的 jsdom 测试台：它把 Cordis 上下文、渲染器拥有的 slot 注册表与生产 `UiSession` 适配器组装在带类型的 Session 和 Workspace Controller 替身周围。默认文件上传替身可满足声明该服务的功能；测试若没有替换它却发起上传，就会明确失败。功能套件无需复制生产渲染器或适配器逻辑，即可检验声明、注册、作用域、store、注入、渲染、更新与销毁。套件通过带类型 fixture 发布 Session 生命周期状态、Workspace 状态、projection 值与 Conversation 事件，再使用局部 DOM 快照根、限定范围的 Testing Library 查询与自明的服务缺失检查。它不属于产品插件图（无 `dsh.client`）；feature 包仅以 `devDependencies` 依赖之。

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

`SlotTestRuntime.create()` 组装运行时，`declare(children)` 注册一个自动 frame，其逐 key 的 `<div data-slot>` 包裹层成为快照根，`mount(plugin)` 在真实 fiber 上运行功能，`renderSlot(key, owner)` 返回带限定查询与原位更新的 slot 局部视图：

```text
const runtime = await SlotTestRuntime.create()
await runtime.declare({ 'feature-slot': {} })
const handle = await runtime.mount(FeaturePlugin)
const view = runtime.renderSlot('feature-slot', { owner: props })
expect(view.container).toMatchSnapshot()
await runtime.dispose()
```

`mount` 会预检必需服务，缺失时自明报错——先用 `provide(name, value)` 提供额外服务。运行时会提供不可用的 `fileUpload` 替身，使装配可以挂载；测试上传行为时，需要在挂载前替换 `runtime.fileUpload.upload`。`storeOf(key, scopeKey)` 返回渲染器交给 slot 组件的实时 store 实例，用于身份与动作驱动写入断言。

### 局部 DOM 快照

注册的快照序列化器把 CSS-module 哈希类名折回语义名（`_frame_a1b2c3` → `frame`），使 `.snap` 文件只含结构，并把 `<svg>` 内部折叠为 `data-content` 指纹。需要自定义页面 frame 的套件改用 `root.declare(children, Frame)` 而非自动 frame；`dispose()` 沿单一轴拆除视图、feature fiber、已铸 scope 与持久化 store 状态，且幂等。

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

### 何时使用

当功能套件要在真实运行时下检验 slot、store、渲染与销毁时使用本测试台——生产 `SlotRegistry`、渲染器与 provide bundle 物化都会被挂载，绝不重实现。它是浏览器侧测试基础设施：永远不触及模型请求，feature 包仅以 `devDependencies` 依赖之。

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

测试台不复制生产逻辑：它挂载生产 `SlotRegistry`、生产渲染器与 `UiSession` 适配器。`TestSessions` 与 `TestWorkspaces` 实现功能通过 Cordis 消费的 owner 接口，每个 fixture Session 实现 `SessionFace`，`stubSettingsScope` 实现 `SettingsScope`。`UiSession` 从这些 Controller binding 派生标准渲染器 source。未 stub 的 `ISession` 行为会携缺失方法名失败。

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
| — | 不发布运行时不变式伴生入口；所挂载的生产包拥有各自的不变式。 |

### 生命周期

`create()` 构建全新上下文，挂载 slot 与会话注册表，安装渲染器，并提供 session/workspace 替身和明确失败的文件上传替身。`mount` 在启动 fiber 前对照上下文检查每个已声明注入，使缺失提供方自明报错而非永久挂起。`dispose()` 先卸载 React 树，再 dispose feature fiber、释放根注册、dispose 已铸 session scope 并清除持久化 store 状态；每个公共修改器都包裹在 act 中，因此测试无需自行处理 SlotCore 微任务批处理或 React `act`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从测试台逐步进入它所挂载的生产机制以及使用它的测试。

- [ui-session](../../client/ui-session/README.zh.md)——从 Controller 替身派生标准 Slot source 的生产适配器。
- [UI slots 包](../../client/ui-slots/README.zh.md)——测试台挂载的 `SlotRegistry` 约定。
- [UI renderer 包](../../client/ui-renderer/README.zh.md)——测试台安装的渲染器。
- [测试策略](../../../docs/testing.zh.md)——覆盖层级与浏览器快照流水线。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无；本包是浏览器侧测试基础设施，无一物到达模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本测试台如何被消费。它们是当前包约束，不是任务积压。

- **仅限 Vitest 与 jsdom**——所有消费方都是仓内、面向浏览器的 Vitest 套件。本包不是产品插件，也不是通用 Node 测试框架。
- **Session、Conversation 与 Chat fixture 保持分离**——`sessionSnapshot` 只包含 Session Controller 状态，`conversationSnapshot` 包含 target-neutral Conversation 状态，`chatSnapshot` 包含 Chat target 状态。组装测试提供 Session event entry，而不是向 `SessionSnapshot` 添加 Conversation 或 Chat 字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
