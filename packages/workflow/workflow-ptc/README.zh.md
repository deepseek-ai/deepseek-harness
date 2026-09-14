---
description: "通过共享的沙箱化 PTC Node 进程运行时执行工作流编排，保留工作流钩子、subagent 路由和调用方拥有的取消能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-ptc

[English](README.md) | 中文

## 概述

在全新 Node 进程中按调用 Session 的文件沙箱策略运行 JavaScript 工作流。脚本保留 `agent()`、`parallel()`、`pipeline()`、`phase()` 和 `log()` 钩子，委派的工作由 subagent 完成。同一个执行提供方服务 PTC 与工作流，包括需显式启用的 Ralph 循环。运行没有整体经过时间截止；取消会停止受管进程并释放子 agent。所选沙箱与子进程提供方决定强制能力和清理限制。

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

在提供 subagent、沙箱策略和 [Node PTC 运行时](../../ptc-runtime/ptc-runtime-node/README.zh.md)的组合中挂载本引擎。它为 `dsh-tool-workflow` 及显式启用时的 `dsh-tool-ralph` 提供工作流执行。Ralph 在已发布默认组合中保持禁用。引擎在加载时拒绝非 TypeScript 的 PTC 提供方。Python PTC 组合必须禁用 `workflow-ptc`、`tool-workflow` 以及任何已启用的 `tool-ralph` 条目。

### 最小配置

上述依赖可用后，挂载引擎及其面向模型的消费方：

```yaml
- name: '@deepseek-ai/dsh-workflow-ptc'
- name: '@deepseek-ai/dsh-tool-workflow'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `spawn` | `agent()` 调用使用的宿主侧 subagent 提供方。 |
| `maxConcurrentAgents` | `0` | 并发 `agent()` 上限；`0` 根据可用 CPU 并行度解析。 |
| `maxTotalAgents` | `1000` | 一次运行最多启动的 `agent()` 调用数。 |
| `maxItemsPerCall` | `4096` | 一次 `parallel()` 或 `pipeline()` 调用接受的条目数。 |
| `syncTimeoutMs` | `5000` | 脚本最初同步片段的 VM 超时时间，单位为毫秒。 |

负责运行的消费方可以为一次运行设置 `WorkflowStartRequest.subagentProvider` 并降低 `WorkflowStartRequest.maxTotalAgents`。脚本钩子不能更改这两项选择。进程堆、输出、控制通信和终止限制由 Node PTC 提供方负责；引擎不增加整体经过时间定时器。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workflow-ptc)定义可接受的引擎字段。

Node PTC 提供方的 `maxPendingCalls` 也限制工作流并发：子 agent 启动、结果等待与资源释放会占用这些名额。进度批次至多再占用一个名额。设置 `maxConcurrentAgents` 时应预留余量。

### 结果与失败

脚本支持顶层 `await`；`meta` 和 `args` 作为 JSON 数据传入。每次 `agent()` 调用使用配置的 subagent 提供方及运行固定的父级。最终的无损 JSON 返回值成为运行结果；普通子 agent 失败使 `agent()` 以 `null` 兑现。

无效元数据、无法解析的正文、不可用的提供方路由或高于上限的单次运行上限，在运行发布前被拒绝。执行期间，钩子误用与超出协作式上限会使工作流失败。进程失败、所需约束不可用，以及超出 PTC 输出或控制限制也会使运行失败。

### 文件策略与取消

引擎为 PTC 执行解析调用 Session 的常设文件策略与 cwd。VM 保留文档说明的辅助 API，但它不是安全边界：触达 Node 的代码仍受所选 OS 文件策略约束。程序可见的环境为空。文件策略不限制网络访问。

工作流向 PTC 请求 `timeoutMs: null`。最初的 VM 片段仍受 `syncTimeoutMs` 限制，调用方的中止信号仍然生效，包括外层工具的截止。取消立即中止 PTC 进程及待启动或活跃的 subagent。调用方必须释放每次运行并等待子 agent 清理；不另设工作流清理定时器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工作流引擎负责编排；PTC 提供方负责进程启动、OS 约束、分帧传输与受管进程清理。

### 设计理念

一个自包含的 guest 程序在 PTC Node 进程中运行既有 VM 与工作流辅助函数。Host 绑定将该程序连接到 `ctx.subagents` 和工作流观察器。引擎在运行启动时捕获运行时与 subagent 服务，因此已接受的运行在引擎卸载后仍保有依赖。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 引擎配置、请求校验与运行创建 |
| [`src/host.ts`](src/host.ts) | PTC 执行、子 agent 归属、结算与资源释放 |
| [`src/guest.ts`](src/guest.ts) | 基于 PTC Host 绑定的 guest 适配器 |
| [`src/guest-source.ts`](src/guest-source.ts) | 自包含 guest 程序源码 |
| [`src/runtime.ts`](src/runtime.ts) | VM 求值、辅助函数约定与组合器 |
| [`src/realm.ts`](src/realm.ts) | 跨 VM realm 的无损 JSON 物化 |
| [`src/meta.ts`](src/meta.ts) | 元数据校验与规范化 |
| — | 不发布运行时不变式伴生入口；工作流服务负责事件配对，PTC 负责受管进程观测。 |

### 值与子 agent 归属

guest 在 PTC 传输前将出站值物化为无损 JSON。特殊原型、函数、symbol、循环、稀疏数组、非有限数与嵌套 `undefined` 被拒绝。子 agent 结果以 JSON 返回；同进程观察事件保留自身的克隆和回调异常隔离规则。

Host 分别跟踪待完成的提供方启动与已发布子 agent。共享中止信号关闭这两条路径；取消后才就绪的子 agent 会被释放。每个已发布子 agent 的资源释放由所有清理路径共享。PTC 停止程序后，进行中的 Host 绑定仍由工作流适配器负责。

### 取消与结果

第一个被接受的终态拥有运行结果。取消立即停止进程，不等待 guest 确认。进程结算与子 agent 清理仍是两项独立义务；公开资源释放操作等待两者。既有工作流开始／结束配对与子 agent 生命周期投影保持不变。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

共享执行保证与工作流约定见以下参考。

- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——请求、结果和事件定义。
- [工作流服务](../workflow/README.zh.md)——调用方拥有的运行与清理。
- [Node PTC 运行时](../../ptc-runtime/ptc-runtime-node/README.zh.md)——文件策略、进程限制与部署选择。
- [workflow 工具](../tool-workflow/README.zh.md)——面向模型的脚本编排。
- [Ralph 工具](../tool-ralph/README.zh.md)——需显式启用的固定全新 agent 迭代。
- [工作流沙箱复用](../../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md)——执行归属与取舍。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

脚本每次调用 `agent()`，都会把提示词原样发送给 subagent 提供方，并附带可选模型或结构化输出 schema。每个子 agent 看到该提供方自己的上下文；phase 与 log 叙述只留在观察器事件中。

#### Token 影响

每个子 agent 消耗自己的模型上下文。协作式并发、agent 总数与条目上限限制普通脚本的扇出；子 agent 历史不会直接加入父级历史。

#### KV Cache 影响

与父级请求缓存及同级子 agent 相互独立。每个子 agent 只能在自己的提供方、模型、提示词和 schema 下复用逐字节相同的前缀。

### 父级工具结果（间接）

#### 模型看到什么

工具消费方呈现最终 JSON 值与子 agent 数量，或工作流失败。中间子 agent 输出仍可供脚本使用。脚本解析、辅助函数误用、子 agent 基础设施失败与 PTC 执行失败会产生错误；普通子 agent 失败产生 `null`，由脚本处理。

#### Token 影响

引擎不直接向父级增加 token。PTC 限制外层程序结果，工具消费方负责其面向模型的渲染与保留。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定工作流执行与清理。

- **文件约束与清理继承提供方限制**——Node PTC 与子进程提供方定义强制能力完整度和受管进程范围。
- **工作流上限是协作式的**——辅助函数计数器限制普通脚本；它们不是 Host 强制的安全配额或后代 token 预算。
- **没有整体经过时间截止**——运行可以持续到完成、失败或取消。调用方截止仍然适用。
- **子 agent 清理遵循提供方约定**——适配器等待资源释放与待完成启动，不另设放弃等待的定时器。
- **VM 不是安全边界**——不提供的全局变量用于指导脚本作者；OS 策略约束触达 Node 的代码。
- **跨 realm 错误在脚本内无法通过 `instanceof Error`**——根据 `name` 与 `code` 等稳定字段分支。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
