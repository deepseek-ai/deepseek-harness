---
description: "面向用户与维护者的进程外 SDK subagent 后端，用于选择委派提供方、配置子 Harness 运行时命令或排查远程子 agent 运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-sdk

[English](README.md) | 中文

## 概述

`dsh-subagent-dsh-sdk` 在全新的子进程中把每个被委派的子 agent（智能体）作为完整的 DeepSeek Harness 运行时运行，并经由 TypeScript SDK 客户端通过 stdio JSON-RPC 驱动。它是 ACP 提供方之外的第二个进程外后端，差异在协议格式（wire format）与子进程约定：子进程是完整的对等 harness，拥有由 `cordis.yml` 决定的组合、会话持久化、模型路由与工具。每次运行都会 spawn 子运行时（Node 下解析出的 `@deepseek-ai/dsh` CLI，或配置的 `dshBin`），以配置的提供方与模型路由完成 `initialize` 握手、提交任务，并从子进程的会话事件中读取答案。父级只收到子进程最终的 assistant 文本或安全错误——中间消息与工具流量不会跨越边界。当子进程应该是与父 harness 完全隔离的真实 Harness 运行时时，选择它。

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

当委派应以完整 Harness 运行时在独立进程中运行时，挂载本提供方。常用路径是显式的：挂载 seam、挂载本提供方，并给出一个启动带有自身 `cordis.yml` 的 SDK 运行时的命令。

### 何时选择

当子进程必须是完整的 harness 对等体——拥有自己的组合、会话持久化、模型路由与工具——而不是共享父进程的 agent 时，选择此后端。当子进程必须共享父级组合或遵守父级强制的非路由能力时，请选择进程内后端：本提供方接受 agent 路由选项，但会拒绝结构化输出、深度上限、工具过滤或 persona，而不是静默省略。

提供方声明 `agentOptions: true`，同时保持 `outputSchema`/`depthLimit`/`toolFilter`/`persona` 为 false，并且 `inheritsParentContext: false`。不可变的 `agentRouteDefaults` 会在模型覆盖与确切路由预检前，把配置的 provider／model 基线公开给 `dsh-tool-subagent`；`start()` 则为直接调用方与 `maxTokens` 独立应用同一份配置默认值。Agent 路由值通过显式白名单跨越 SDK 协议；子进程仍是另一进程里的全新运行时，唯一从父 agent 本身派生的值是工作区 cwd。基于本提供方的 `dsh-tool-subagent` 部署应设置 `maxDepth: 'provider-managed'`——子 harness 拥有自己的递归预算。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `dsh-sdk` | `ctx.subagents` 上的注册表名称 |
| `dshBin` | SDK 依赖 | 显式 dsh CLI 模块，在插件加载时解析并校验；省略则使用 SDK 依赖 |
| `profile` | `sdk` | 子进程命名的 profile |
| `patches` | `[]` | 每次启动的有序 profile patch 文件，在插件加载时解析并校验 |
| `dshHome` | 必填 | 每个嵌套子进程的绝对隔离 Harness home |
| `cwd` | 父会话 cwd | 子进程及其 SDK 会话的工作目录覆盖值 |
| `provider` | `deepseek-official` | 写入子进程 `initialize` 的提供方路由 |
| `model` | `deepseek-v4-flash` | 写入子进程 `initialize` 的模型 |
| `maxTokens` | 适配器／提供方路由默认值 | 写入子进程 `initialize` 的单次请求输出 token 上限 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子环境 |
| `shutdownTimeoutMs` | `1000` | dispose 期间协议 `shutdown` 交换的时限 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、平台终止之前的宽限 |
| `disposeGraceMs` | `3000` | 终止后的退出确认宽限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-dsh-sdk)是每个受支持字段及其 JSDoc 的穷尽式真源。

请求 `agentOptions` 会分别覆盖 `provider`、`model` 与 `maxTokens`。`reasoningEffort` 没有提供方实例默认值：请求省略时保持缺省，由所选子模型解析自身默认值。面向模型的 subagent 工具可在每次调用时选择提供方／模型／推理强度；`maxTokens` 仍由工具配置或本提供方默认值在部署侧控制。

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    profile: sdk
    patches: ['./profiles/research-child.cordis.yml']
    dshHome: !!js dshHomePath('children')
    maxTokens: 49152
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

### 你会得到什么

成功的运行会把子进程最终的 assistant 文本（或取消后累积的部分文本）作为结果输出返回。子进程的模型路由、工具与会话来自子运行时自身——父级提供任务、工作目录与 `initialize` 路由。子进程最后一个持久化 `turn/end` 会映射进 seam 词汇：`completed` 与 `max-tokens` 原样通过，`blocked` 变为 `refusal`，意外终态或缺少终态变为 `error`。`aborted` 结果保持中止；只有子进程侧 `disposed` 原因会附加 `child-disposed` 诊断。

### 失败与恢复

已取消的请求会在路径解析或 spawn 之前失败。路由、spawn、握手或发布前取消失败通常只在子进程被回收后拒绝；如果初始化与清理均失败，有序安全事实会保留两项失败，而不会宣称已完全停稳。子运行时在发布后失败时会通过运行本身结算，而不是拒绝；部分输出与安全诊断保持分离。诊断只公开提供方、`initialize`、`session-run` 或 `shutdown` 阶段，以及固定类别。SDK 消息、stderr、路径、任务内容、环境值、凭据和协议载荷绝不会复制到诊断中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端如何驱动子 Harness 运行时，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **完整 harness 对等体。** 每个子进程都是独立进程中的完整 Harness 运行时——拥有自己的组合、会话、模型路由与工具；只有解析后的工作目录与 `initialize` 路由从父级跨越。
- **每次运行一个运行时。** 每次运行都 spawn 全新运行时进程；没有进程池。
- **JSON-RPC 协议格式是序列化边界。** 同进程 subagent 值不会为防御目的克隆；协议才是校验不可信输入的地方。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | SDK 运行生命周期、答案提取与停止原因映射 |

### 运行流程

一次启动会在 spawn 前解析子进程工作目录与一条进程级 SDK 路由。`request.agentOptions` 中每个已声明字段（`provider`、`model`、`reasoningEffort` 或 `maxTokens`）都会覆盖对应的提供方实例默认值；省略时保留已配置的提供方／模型与可选上限，而推理强度只有在请求提供时才会出现。随后，提供方通过 SDK 客户端 spawn 运行时，并在履行前完成 `initialize` 握手，其中包括确切模型与推理强度校验。路由、spawn、握手或发布前取消失败时，只会在子进程被回收后拒绝；工作目录解析失败则会在尚未 spawn 任何内容时拒绝。发布后，提供方拥有一段 SDK 活动，并从子会话事件中读取答案：最后一条完整且非空的 `assistant/message`（记录 usage 的空内容消息会被跳过）；若没有这类消息，则取累积的 `text-delta` 流。dispose（资源释放）是幂等的：先在本地把结果确定为 `aborted`，发出有界的协议 `shutdown` 请求，再经 stdin EOF → SIGTERM → SIGKILL 升级到实际退出。

### 停止原因映射

子进程最后一个 `turn/end` 的原因会映射进共享的停止原因词汇，实现见 [`src/run.ts`](src/run.ts)。

### 进程边界

子进程环境以子进程 seam 的已清理凭据父环境为基础，并在清除之后合并显式 `config.env` 值。子进程由 SDK 客户端 spawn，而不是经由 `ctx.subprocess`——这是 SDK 托管传输的文档化例外——因此本后端会自行执行环境清理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本后端逐步进入它接入的 seam 与它驱动的 SDK。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [ACP subagent 后端](../subagent-acp/README.zh.md)——经 Agent Client Protocol 的兄弟进程外提供方。
- [TypeScript SDK 客户端](../../sdk/client/README.zh.md)——本后端用以驱动子进程的 stdio JSON-RPC 客户端。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-dsh-sdk)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

子运行时的模型会收到作为用户消息的独立任务，以及该运行时自身配置的系统提示词、工具和全新会话。它不会收到父级对话。父级工具调用可以为本次运行选择子级提供方、模型与推理强度；所选路由和部署持有的可选输出上限会固定到这个新子进程。persona、工具过滤、深度强制与结构化输出仍不受支持，并会被拒绝而不是静默省略。

#### Token 影响

子运行时会为独立的完整上下文及其多步骤历史消耗 token。这些 token 绝不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。每个 SDK 子进程只能复用其自身提供方、模型、组合和历史均相同时的前缀；除此之外，子 agent 的步骤仅追加增长。

### 父级工具结果（间接）

#### 模型看到什么

经由 `dsh-tool-subagent`，父级只会收到子运行时最终的 assistant 文本（或累积的部分文本），或该消费方给出的精确停止原因错误；不会收到中间消息或工具流量。带诊断的非完成结果会先呈现安全诊断，再单独呈现保留的部分 assistant 输出；启动与 shutdown 错误使用同一固定事实，不公开原始 SDK 文本。

#### Token 影响

父级输入只增加最终结果或错误，其大小取决于数据，并保留到压缩（compaction）为止。本提供方自身不会向父级添加任何 schema。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 SDK 对比或任务积压。

- **每次运行都使用全新的运行时进程**——不使用进程池；harness 运行时需要启动完整的插件树，因此每次运行的 spawn 成本高于 ACP 后端通常使用的子进程。
- **不支持路由之外的启动时能力**——父级可以选择子 agent 路由，但无法在子进程内强制执行 `outputSchema`、深度限制、工具过滤或 persona；应改为配置所选子 profile 及其有序 patch。
- **子进程的 transcript（文本记录）保留在其自身的会话根目录中**——父级日志只记录委派工具调用与结果；流式会话事件通道只用于提取输出，不会桥接到父级日志中。
- **仅支持本地子进程**——解析出的工作目录是本地路径；远程运行时需要独立的后端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **Spawn 成本**——每次运行加载完整插件树是彻底隔离的代价；池化会改变这一权衡。
- **远程运行时**——远程运行时需要独立的后端与工作区映射。

</details>

**运行时不变式：** 不发布伴生入口。run 生命周期配对由 subagent seam 的不变式检查；backend 自身状态位于子进程中，超出当前 Context 的事件流。
