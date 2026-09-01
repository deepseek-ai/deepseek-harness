---
description: "应用 Remote 装配：为 Client 消费方选择带类型的 Host 能力与转发事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remotes

[English](README.md) | 中文

## 概述

为本应用选定的 Host Remote 能力提供双侧 BFF。Host 入口拥有转发事件名单并向 API Gateway 注册应用事件 source；Client 入口以运行时值形式导入生成的 `/remote` 产物，通过 `ctx.remote.$mount()` 挂载每项贡献，并重新导出对应的声明合并。Client 业务包依赖该外观，而不依赖 Gateway 实现或单独的 Remote 运行时入口。

## 目录

- [使用本包](#use-this-package)
- [转发的 Host 事件](#forwarded-host-events)
- [构建边界](#build-boundary)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[`@deepseek-ai/dsh-api-session-controller`](../session-controller/README.zh.md) 拥有 Agent 与 Session 身份策略，包括供其他 namespace 使用的 Typert lookup resolver。本包只选择并挂载生成的 Session contribution，不复制激活策略。

Client 组合挂载 Commands、凭据、settings、Goal、动态 Cordis、文件与 Session 引用、只读 Host 插件清单、消息反馈、Session Controller 和 Workspace Controller contribution。该组合卸载时，Cordis effect 的所有权机制会撤回所有贡献；`@deepseek-ai/dsh-api-gateway/client` 负责描述符校验、可追踪 namespace Service、直接与作用域方法、调用、流与取消。Client 入口通过 Cordis 消费共享的 `TypertClientRemote` 接口，不导入具体 Gateway；它只以 type-only 形式重新导出 Gateway Client face 的声明合并，因此消费端经由本外观取到转发事件词汇时，运行时不会多出一条通往 Gateway 实现的边。

本 facade 同时是 Client 包指称 wire 类型词汇的正门。它以 type-only 方式转出 Remote 失败词汇（`RemoteResult`、`RemoteFailure`、`RemoteErrorCode`、`RemoteErrorDetailsMap`）、Host 事实（`RemoteHostFacts`），以及各已选领域的浏览器安全载荷类型，因此 Client 功能包只 import 一个 specifier，不必伸手进 `dsh-typert-protocol`、Gateway 或某个拥有方的 Host 入口。有两类包刻意不走这道门：本装配自己选中的 api 层包——反向 import 会形成依赖环——以及它们的测试，后者直接从 `dsh-typert-protocol` 取失败词汇。UI 包的测试则从 [`dsh-client-test-runtime`](../../test-support/client-runtime/README.zh.md) 取 `RemoteError` 构造器。

本包不拥有物理传输或 Host 服务发现。它只把应用选择投影为生成的 Remote contribution 和唯一的 Host Cordis event source；API Gateway 负责 endpoint、carrier、取消与重连。Web 或未来的 TUI 只要提供同一份不依赖 React 的 `ctx.remote` 约定，均可复用其 Client face。

-----

<a id="forwarded-host-events"></a>
## 转发的 Host 事件

`src/remote-events.ts` 持有 `API_REMOTE_FORWARDED_EVENTS`，即本应用不改名转发给消费端的 Host Cordis 事件名单；每个条目还会选择普通发送或 Agent-scoped waterfall 投递。该名单同时就是 `ctx.remote.$on` 的合法键集，只含类型的 `src/types.ts` 派生其选择面。多转发一个事件只需在该数组里加一项：类型投影、消费端键面与 Host 转发循环全部由它派生。

监听器签名不在此处重写。名单内每条事件的 Cordis `Events` 声明都住在其 owner 包 client-safe 的 `./types` 出口，本包两个 face 都把那些声明纳入编译面。Host face 还会把每个条目断言给 `TypertForwardableEventEntry`：`emit` 条目必须是已声明的单向事件，`waterfall` 条目则必须是已声明的 Agent-scoped waterfall，且其最后一个参数是返回相同结果类型的 `next()` 回调。

Host entry 为每条 Client stream 独立注册 allowlist listener 和队列，并在普通事件入队前拒绝非 JSON 参数。对于 waterfall，它只投影顶层 Agent 身份与 JSON 请求字段；Client 结果也必须能无损表示为 JSON，而 `next()` 会委托给后续 Host listener。该 source 在 `ctx.typertGateway.registerRemoteEvents()` 暴露 Gateway 内部的 `$events` logical stream 前同步挂好所有 listener，因此首个 `ready` 项既能证明增量投递已就绪，也会携带供 Client 显示路径的 Host home。撤回注册会中止活动 stream。

<a id="build-boundary"></a>
## 构建边界

仓库中的多数包只属于一个 TypeScript face：Host 包登记在根 `tsconfig.host.json`，Client 包登记在根 `tsconfig.client.json`。本包需要拆分，因为 Host 入口要参与 Host Typert 图，而 `src/client/index.ts` 必须等 Host tsdown 生成业务包的 `/remote` 声明后才能编译。

本包根 `tsconfig.json` 只是引用 `tsconfig.host.json` 与 `tsconfig.client.json` 的 solution。Host aggregate 和 Host 直接消费方引用前者，Client aggregate 和 Client 直接消费方引用后者；禁止把包根 solution 放进任一 aggregate 的依赖图。两个 project 拥有互不重叠的源码和 `.tsbuildinfo`，但共享 `lib/types` 输出目录——只有一处刻意的例外：`src/remote-events.ts` 与 `src/types.ts` **同时**列进两个 face 的 `files`，因为转发事件名单是「消费端能收到什么」的唯一控制点，Host 转发循环与 Client 的 `ctx.remote.$on` 键面必须读同一份声明，而不是两份可能彼此漂移的声明。

这条例外不止是一行 `files`。根 `tsconfig.base.json` 把 `@deepseek-ai/dsh-api-remotes/types` 映射到 `src/types.ts`——**源平面**，与其余所有 workspace 子路径一致，也与生成的 `/remote` 产物相反（后者没有 `paths` 条目，靠 `exports` 命中构建产物）。于是两个 face 都把同一份名单与类型投影收进各自的 program，并向 `lib/types` 发射逐字相同的 `remote-events` 与 `types` 输出；`.tsbuildinfo` 仍各自独立。没有任何门禁强制两个 face 的源文件互不重叠——`scripts/project-reference-faces.ts` 只校验「引用一个 split project 必须指到对应 face」——因此本段记录这次双列为何是有意的。

包内 `clientBundle(..., { hostPhase: true })` 让 Host tsdown 打包 Host 入口，让后续 Client tsdown 只打包 browser 入口。普通 Client 插件仍使用单一 Client project，并在 Client tsdown 阶段一起生成 Node loader 入口和 browser bundle；只有两组源码需要不同 compiler face 时才拆分。

<a id="model-experience"></a>
## 模型体验

无，因为该 BFF 只选择 Remote 应用方法和转发事件，不注册任何模型接口。

#### KV Cache 影响

无直接影响；其触发的任何模型可见行为均由已挂载的 Host 能力负责。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 能力集合由构建时显式导入的值固定确定；Client 不会在运行时发现 Host 中已启用的服务或 Remote 定义。
- 若要增加能力，必须显式导入相应的 `/remote` 值并在此组合中挂载。
- 只有仍在等待的作用域 waterfall 会在重连后重放；单向通知仍是相互隔离的 best-effort 投递。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。被观察的关系由 Typert 以及 Agent、Session 注册表负责。
