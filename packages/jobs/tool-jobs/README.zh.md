---
description: "面向模型的背景任务控制，供选择、配置或排查 job_output、job_list、job_kill 与完成通知的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jobs

[English](README.md) | 中文

## 概述

`dsh-tool-jobs` 为 agent 提供三个与 kind 无关的后台工作工具——`job_output`、`job_list` 与 `job_kill`——因此 agent 启动的任何任务，无论是后台命令、PTY 发送还是 subagent，都可以通过同一套控制读取、列出和取消。任务完成时，拥有它的 agent 会在会话内收到通知：繁忙的 agent 在下一步收到通知，空闲的 agent 则被一个 follow-up 轮次唤醒，两者均按所有者设限。加载插件还会附加让生产方能够启动后台工作的任务控制器。这些工具是基于 `ctx.jobs` 的通用 UI 卡片；配置用于调节等待超时与完成投递。

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

在 agent 需要启动、观察和停止后台任务的任何组合中加载本插件：它注册三个工具、附加生产方所需的控制器，并投递完成通知。它需要组合中已提供的 `ctx.tools`、`ctx.jobs` 与 `ctx.systemPrompt` 服务。

### 三个工具

- `job_output(job_id, wait?, timeout_ms?)`——读取任务输出。流任务只返回自上次读取以来的输出；最终输出任务在结算后返回其结果。每个响应都以 `[status: ...]` 结尾。除非 `wait: true`，否则读取是非阻塞的；`wait: true` 最多等待到配置上限，超时时仍让运行中的任务保持存活。
- `job_list()`——列出你的后台任务及其 id、kind 与状态，每行一个：`<id> [<kind>] <status> — <label>`。
- `job_kill(job_id, reason?)`——立即请求取消运行中的任务；任务在其工作真正停止后以 `killed` 结算。终止任务返回其当前快照，可选的原因会被记录并转发给任务。

三个工具依次返回 `{ text, job }`、`PublicJobSnapshot[]` 与 `{ outcome: 'cancellation-requested' | 'already-finished', job }`。公共快照携带 id、kind、label、status/detail 及开始／结束时间，并省略归属与通知簿记字段。三个工具都通过通用 UI 卡片渲染：output 和 list 用 `read`，kill 用 `execute`。

### 完成通知

任务完成时，拥有它的 agent 会收到会话内消息 `background job <id> (<kind>: <label>) finished [status: ...]. Read its output with job_output.`。繁忙的 agent 会在下一步收到注入的通知——inbox 尚有内容时轮次无法结束，因此同时结算的多个任务只花掉一步，而不是各占一轮。空闲的 agent 则被一个 follow-up 轮次唤醒，因为无人领取的通知等于模型永远不会知道的完成。kill 或针对终止任务的 read/wait 会把完成标为已报告并抑制重复通知；排空 owner 或服务的 teardown 取消同样如此。

唤醒是有界的：每个所有者最多可被唤醒 `maxConsecutiveWakes` 次，此后的通知降级为注入；领取任何用户撰写的消息都会恢复预算。设界是因为这条链会自激——被唤醒的一轮可能启动某个后台任务，而它的完成又会唤醒同一个所有者。`completionDelivery: quiet` 让空闲所有者也在注入通道上，确定性 transcript 需要的正是这一点。

### 最小配置

不带配置加载插件是常用路径；`waitTimeoutMs` 高于 `maxWaitTimeoutMs` 时会在加载时失败。

```yaml
- name: '@deepseek-ai/dsh-tool-jobs'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `waitTimeoutMs` | `30,000` | `wait: true` 省略 `timeout_ms` 时使用的等待时间 |
| `maxWaitTimeoutMs` | `600,000` | 模型所给等待时间的上限；更大的值向下收敛到它 |
| `completionDelivery` | `wakeup` | `wakeup` 为空闲所有者开启一轮；`quiet` 让通知继续待领 |
| `maxConsecutiveWakes` | `3` | 一个所有者可由唤醒开启的轮数，超出后通知降级为注入 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-jobs)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可能出什么问题

组合中未加载 `tool-jobs` 的 agent 无法启动后台工作：本插件的控制器正是生产方 `ctx.jobs.start()` 得以启用所依赖的。模型给出的等待时间超过 `maxWaitTimeoutMs` 时会向下收敛到上限，超时的等待返回 `[status: running]` 并让任务保持存活，而不是失败。待领于空闲所有者的完成通知无法在该所有者释放后存活。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **与 kind 无关的控制。** 同一套三个工具读取、列出和取消每种生产方 kind 的任务——bash、subagent、PTY——因为它们都通过通用的 `ctx.jobs` 运行时注册。
- **投递归本插件，收件人归注册表。** 插件决定未报告的完成如何到达所有者——注入繁忙的一步，或唤醒空闲所有者的一轮——而注册表把每次结算路由给其所有者 scope 链所能抵达的监听器，因此某个 preset 下的挂载永远看不到另一个 preset 的 agent，无论挂载了多少 preset，一个 agent 每次完成都只读到一条通知。
- **生产方自有的输出上限。** 生产方提供 `outputLimitBytes` 时，完整的模型侧结果——输出读取、终止 kill 快照或完成通知——会在添加状态与通知元数据之后被施加上限；省略该字段的生产方保持无界行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、完成监听器、提示词区段、输出上限 |
| — | 不发布运行时不变式伴生入口；执行关系归能力 seam 所有。 |

### 输出上限

`job_output` 与 `job_kill` 会在策略运行前于前置的 pre-execute 监听器中捕获调用方可见任务，因此生产方上限适用于完整渲染结果。`job_output` 在策略保留默认渲染时保持其输出／状态拆分，对输出尾部与 `[status: ...]` 后缀设界；其他单文本结果——拒绝、短路、规范化工具或流水线失败、替换与阻止——按单个文本设界，而结构化多块策略结果保持自身形状。有界完成通知先为稳定的 `background job <id>` 前缀与 `job_output` 收集指令预留空间，再把剩余字节用于可变的 kind、label、status、detail 与截断标记，因此在 PTY 支持的 64 字节下限下通知仍可操作；已有的生产方截断标记会被复用，不会重复添加。

### 通知投递通道

`onJobDone` 跳过已报告或无所有者的任务。`wakeup` 投递在预算内为空闲所有者开启一轮，按确切 `Agent` 记录在 `WeakMap` 中；领取用户撰写的消息（`agent/inbox/claimed`）会重置该所有者的预算。繁忙的所有者——或超出预算的任何通知，以及 `quiet` 投递——改为注入 next-step inbox。teardown 结算抵达时已标记为 `reported`，因此释放永远不会花一次模型请求来宣布无人能读的通知。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从任务类型逐步进入注册表约定与生成 schema。

- [后台任务运行时子系统](../../../docs/subsystems/jobs.zh.md)——任务类型、快照字段与 `ctx.jobs` 的 cordis 接口面。
- [jobs 组映射](../README.zh.md)——同级组页面及其包表格。
- [注册表约定](../jobs/README.zh.md)——工具背后的抽象 `ctx.jobs` 服务。
- [进程本地注册表](../jobs-local/README.zh.md)——任务在本进程中的运行位置。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jobs)——`job_output`、`job_list` 与 `job_kill` 的确切 schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-jobs)——每个受支持配置字段及其源声明。
- [任务注册表 seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md)——按所有者隔离的注册表约定及其理由。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

该插件注册 scope 中的每次请求都包含以下指引。按 agent（智能体）scope 过滤工具时，可能会隐藏工具，却不会移除独立注册的提示词区段。

##### 后台任务指引

```markdown
Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.
```

#### Token 影响

激活期间，每次请求都会产生少量固定的输入 token 开销。

#### KV Cache 影响

只要插件 scope 与指引文本不变，前缀就保持稳定。激活或释放可能使从该提示词区段起的复用失效。

### 工具 schema

#### 模型看到什么

该工具集可见时，会看到生成的 [`job_output`、`job_list` 和 `job_kill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-jobs)。

#### Token 影响

工具可见时，每次请求都会产生固定的 schema token 开销。

#### KV Cache 影响

只要工具定义与可见性不变，前缀就保持稳定。注册生命周期或 scope 限制可能使从第一个发生变化的 schema token 起的复用失效。

### 结果与通知

#### 模型看到什么

读取会返回输出或 `(no new output)`，随后是 `[status: <status>]` 和可选 detail。空列表返回 `(no background jobs)`。kill 返回 `requested cancellation of job <id>` 或现有终止状态。尚未报告且有所有者归属的完成使用上述通知。

#### Token 影响

结果与通知在压缩（compaction）前保留于父级历史。流读取不会重复已消费的输出；生产方提供的 `outputLimitBytes` 会限制每次完整读取或通知。在 `wakeup` 下，抵达空闲所有者的通知还会额外买下一次用户并未要求的模型请求，其数量按所有者由 `maxConsecutiveWakes` 封顶；抵达繁忙所有者的通知则只是给它已经在支付的那一轮加一步。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适。它们是当前包约束，不是任务积压。

- **落在 driver 退休窗口内的结算仍会让通知搁浅**——在轮次循环最后一次检查 inbox 与 driver 提交 idle 相位之间，所有者读起来仍是繁忙，因此通知走注入且无人唤醒。steer 有同样的洞；堵上它属于 `agent-loop`。
- **已花掉的唤醒预算不会随时间恢复**——只有用户撰写的输入才能补充，因此预算耗尽的无人值守 agent 要等到其他原因开启下一轮时才收走剩余通知。
- **待领于空闲所有者的通知无法在该所有者释放后存活**——释放时的取消会清空未领取的 inbox，日志保留插入/取消这一对作为记录。
- **流读取只有单一消费方**——独立观察者需要另一套运行时 API。
- **无 owner 的任务没有会话隔离**——外部调用方必须提供策略或避开这些任务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
