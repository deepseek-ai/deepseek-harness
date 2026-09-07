---
description: "动态 Cordis 包的浏览器半说明，供选择、组合或排查页面如何应答运行请求并装载浏览器半代码的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-client-runner

[English](README.md) | 中文

## 概述

`dsh-cordis-client-runner` 让页面运行动态 Cordis 包的浏览器半：它应答 host 的运行请求、把浏览器半源码装载进页面成为活插件，并在 host 撤回该次运行时把它移除。人可以批准或拒绝一次运行——也可以直接启动一次——而本包回报的结果变成模型读到的 `cordis_run` 工具结果。激活时什么都不装载，刷新后也不恢复；一页只在有人应答运行请求或在此主动要求时，才运行动态包。

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

在组合里同时挂载了 host runner 的 web 客户端中挂载本插件——host 半跑在进程里，浏览器半跑在页面里。当某个带浏览器半的动态包被运行时，打开的页面会收到一次运行请求；本包在本页执行装载，UI 包（`ui-cordis`）则渲染人用来应答它的面板与卡片。纯 host 包不需要浏览器半，也就不需要页面：host 自己运行它们。

### 页面会做什么

浏览器半用纯 JavaScript 编写——无 JSX、无 TypeScript、不能 import 模块——并作为一个 async 函数运行。它拿到一组固定的名字——`React`、`console`、`styles` 与 `host`——而 `fetch`、`setTimeout` 这类浏览器全局不可用。返回的插件只能使用生命周期动词，以及它自己在 `inject` 里声明的服务。从已装载半调用 `host.call(method, args)` 会到达它自己的 host 半。React 渲染已装载半时发生的崩溃会上报 host，点名槽位、崩溃是否已把条目摘掉，以及写给作者的 message。

### 运行界面提供什么

运行界面可以应答一次待审批的 host 请求——批准它（可选地同时覆盖同一插件的未来版本）或拒绝它——也可以按用户自己的手势启动一个定义，该手势本身就是授权。每个定义最多有一个在途活动，因此基于该状态构建的控件能在 remount 后存活。界面就本页显示的内容都是页面本地的：每包最后一次渲染崩溃、本页自己的尝试为何失败，以及某个包是否已在本页装载——绝不是 host 眼中「在跑」的视图。

### 生命周期边界

装载是幂等的：要求装载这一页已在运行的 revision 不会改变任何东西，更新的 revision 顶替已装载的那个，同一 revision 在 retract 之后再装则重新装载。同一定义的操作串行执行。刷新按设计从干净状态开始——host 仍持有定义，本页在再次被要求之前不运行它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释浏览器半背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

浏览器半建立在一个原则之上：动态包必须与静态包共享同一套激活门控、fiber effect 清理与状态投影。求值后的插件被塞进模块表，并经 `loader.create` 挂载；卸载 = 移除 entry + 失效 factory + 撤下样式。guard 是一份白名单——生命周期动词加已声明服务——与 host 侧沙箱门面对称，因此包作者在两侧面对同一个约定。一个观察者供两个出口：只有这里监视槽位注册表的 entry 错误接缝，凡属于本 runner 落座过的包的崩溃，一路上行给 host（给模型），一路发布到本包自己的 `renderFailures`（给面板）。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：runner、编排器、inspect 注册表、转发事件订阅 |
| [`src/client/runtime.ts`](src/client/runtime.ts) | 装载引擎：按运行标识收敛、guard 挂载、撤回 |
| [`src/client/orchestrator.ts`](src/client/orchestrator.ts) | 运行编排：先 host 半、再取源码、再浏览器半、一次结算 |
| [`src/client/evaluator.ts`](src/client/evaluator.ts) | 闭包求值：符号面及其教学陷阱 |
| [`src/client/guard.ts`](src/client/guard.ts) | 已装载浏览器半收到的白名单 `ctx` façade |
| [`src/client/inspect-registry.ts`](src/client/inspect-registry.ts) | Client Inspect Provider 与待答查询路由器 |
| [`src/client/providers.ts`](src/client/providers.ts) | 第一方 client Inspect Provider（slots、theme、events） |
| [`src/client/timer.ts`](src/client/timer.ts) | 动态包注入的 client 定时器服务 |

### 一次 run 如何执行

一条 `cordis/request-run` 事件问这一页要不要运行某个定义。作答的一方——审批后的页面，或按下运行的用户——驱动编排：先 host 半（host 半失败会在浏览器动作之前短路），再取源码，再浏览器半，最后一次结算带上发生的一切。浏览器半源码作为 async 函数体求值，符号面就是参数；返回的插件经 guard 包装后通过 loader 挂载；结算报告已装载的 revision，或失败阶段加闭包、guard 或 fiber 的消息。`host.call` 经 Remote namespace 路由；省略的入参以 `null` 过线，而生成 codec 拒收的载荷会变成一条点名「哪次调用 + 约定是什么」的教学错误。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从浏览器半逐步进入发问的 host、其运行被应答的工具，以及渲染它的界面。

- [Host runner](../cordis-host-runner/README.zh.md)——本包应答的注册表与运行往返。
- [工具包](../tool-cordis/README.zh.md)——运行请求到达本页的模型侧工具。
- [UI 包](../ui-cordis/README.zh.md)——操作这个面的面板与卡片。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.dynamicCordisRunner` API 与 `cordis/*` 事件。
- [客户端外壳与动态包 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-15-client-shells-and-dynamic-packages.zh.md)——浏览器半的包归属与构建面。

-----

<a id="model-experience"></a>
## 模型体验

### 由模型发起那次 run 的最终回答

#### 模型看到的内容

本包自己不贡献任何工具、提示词或上下文；它撰写并到达模型的第一样内容，是为一次 `cordis/request-run` 往返发回的回答——host 把它变成那个被阻塞的 `cordis_run` 的结果。成功时带上已装载的 revision，以及（当浏览器半挂在这一页没有的服务上时）那些服务的名字。失败时带一个 reason：用户拒绝的 `rejected`、`host-half-failed` 或 `client-half-failed`；后者还带上本包自己的文本——出错阶段（`evaluate`、`module-import` 或 `activate`）加上闭包、guard 或 fiber 的消息。guard 的教学错误（未声明的服务、被遮蔽的浏览器全局、返回值里没有 `apply`）正是经这个字段到达模型的。而装载之后、React 渲染时才发生的崩溃，走下面那条独立的事后通道。

#### Token 影响

有条件且有界：每次 run 请求最多一个回答，花在 host 本来就会发出的那个 `cordis_run` 结果里。文本随数据而定（某个定义自己的错误消息），本包跨请求不留存任何东西——一页后续的装载失败是页面本地诊断，在模型侧没有任何承载物。

#### KV Cache 影响

只追加。回答只作为「本来就在途的那次请求」的工具结果到达模型、延长历史尾部；本包撰写的内容不会重写或重排更早的请求 token，因此原本可复用的前缀仍然可复用。同一定义的多次运行各自产出各自的结果，而不是替换更早那一个。

### run 落定之后的渲染期失败

#### 模型看到的内容

一个装载得干干净净的浏览器半，仍可能在 React 渲染时崩溃，而那次崩溃发生在 run 已经被回答之后——否则模型只会被告知「ok」，永远学不到。凡是本页落座过的包，其 entry 边界的每一次崩溃都会发回 host（`reportRenderFailure`）：点名槽位、说明这次崩溃是否已把 entry 从格位上摘掉（`abdicated`：包的 UI 是没了、而不只是坏了），以及一条写给作者的 message。host 每包只留最后一条，用它 steer 所属会话，并经由 `cordis_inspect_self` 暴露；这条通道上的任何东西都不会进入 run 的最终回答。

#### Token 影响

有条件，且其上界由 host 的留存策略决定、不由这一页决定：每次崩溃一条报告，而 host 每包只留最新一条——所以一个反复崩溃的 entry 对模型的代价是一条消息，而不是一张越来越长的清单。报告本身不会自带任何工具结果：模型只在被 steer 或主动去问的时候才为它付费。

#### KV Cache 影响

自身没有。报告经 RPC 送出并被存起来，而不是追加进对话；模型通过一条 steer 消息或自己发起的查看读到它们，那次查看与任何工具结果一样只延长尾部。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明浏览器半何时需要特别小心。它们是当前包约束，不是任务积压。

- **被拒绝的回答不会重试**——`resolveRequestRun` 的 ack 不读，所以当 host 拒绝一个陈旧的成功答复（`accepted: false`——这一页装载期间定义的 revision 被顶掉了），这一页会保留已装的东西、也不再重新编排。那次请求仍可作答（别的页面作答或调用方取消都能收尾），而顶掉 revision 的那次 stop 会 retract 掉陈旧装载。
- **host namespace 存在之前插件一直挂起**——它声明 `remote.dynamicCordisRunner`，因此绝不会装载一个永远够不到自己 host 半的浏览器半。
- **槽位准入没有载体**——下发行声明的是服务，不是目标槽位，因此按部署的槽位允许／拒绝清单无处可驮。
- **guard 白名单是手抄的孪生**——浏览器 guard 复刻 host 侧沙箱门面；抽取共享规格留待后续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。live Plugin 与 Plugin Run ID 的关系只存在于浏览器侧 service，Host 不变式无法观察；包内 load/teardown 测试直接覆盖该关系。
