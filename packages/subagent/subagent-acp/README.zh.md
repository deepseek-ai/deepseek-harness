---
description: "面向用户与维护者的进程外 ACP subagent 后端，用于选择委派提供方、配置子 ACP agent 命令或排查远程子 agent 运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-acp

[English](README.md) | 中文

## 概述

`dsh-subagent-acp` 在全新的子进程中运行每个被委派的子 agent，并作为 Agent Client Protocol 客户端驱动它：子 agent（智能体）拥有自己的运行时、会话、模型配置和工具，可以是任何兼容 ACP 的 agent，而不只是 Harness。它是进程内 spawn 与 fork 后端的进程外替代方案，只与子 agent 共享父会话的工作目录。每次运行都会 spawn 全新进程、初始化 ACP 会话、发送任务并收集流式最终答案；权限提示由配置自动应答，因此无需人工参与。父级只收到子 agent 的最终答案或安全错误——中间消息与工具流量不会跨越边界。当子 agent 必须与父 harness 完全隔离且能说 ACP 时，选择它。

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

当组合需要一个说 Agent Client Protocol 的完全隔离进程外子 agent 时，挂载本提供方。常用路径是显式的：挂载 seam、挂载本提供方，并给出一个启动 ACP agent 的命令。

### 何时选择

当子 agent 必须在独立进程中运行、拥有自己的运行时、模型和工具时选择此后端——例如来自其他项目的 ACP agent——或者你希望委派完全无法触及父 harness 时。当子 agent 必须共享父级组合或遵守父级强制的能力时，请选择进程内后端：本提供方不声明任何可选启动时能力，因此 seam 会拒绝要求 `agentOptions`、结构化输出、深度上限、工具过滤或 persona 的请求，而不是静默省略。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `acp` | `ctx.subagents` 上的注册表名称 |
| `command` | 必填 | 每次运行时 spawn 的可执行文件（子 ACP agent） |
| `args` | `[]` | 命令参数 |
| `cwd` | 父会话 cwd | 子进程及其 ACP 会话的工作目录覆盖值 |
| `permission` | `reject` | 自动应答权限请求：拒绝，或选择第一个 `allow_once` 或 `allow_always` 选项（`allow`） |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子环境 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、平台终止之前的宽限 |
| `disposeGraceMs` | `3000` | 失败后观察结构化进程事实的时限；在 POSIX 上也是 SIGTERM 到 SIGKILL 的宽限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-acp)是每个受支持字段及其 JSDoc 的穷尽式真源。

DeepSeek Harness 子进程使用产品启动器和一个显式的绝对路径 `DSH_HOME`。隔离 home 可防止嵌套 runtime 发现启动者个人的 profile 或凭据；通用 ACP provider 不会把这一要求强加给非 DSH agent。

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: dsh
    args: ['--profile', 'acp', '--patch', '/absolute/path/to/acp.patch.yml']
    permission: reject
    env:
      DSH_HOME: /absolute/path/to/isolated-child-home
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

### 你会得到什么

成功的运行会把子 agent 最终的流式 assistant 文本作为结果输出返回。子 agent 的会话、模型与工具来自子进程自身——父级只提供任务与工作目录。停止原因把 `end_turn` 映射为 `completed`、`max_tokens` 映射为 `max-tokens`、`refusal` 映射为 `refusal`、`cancelled` 映射为 `aborted`，其余值映射为 `error`。已发布运行失败时，部分 assistant 文本保留在 `output`，安全的结构化详情则单独放在 `diagnostic`。

### 失败与恢复

spawn、初始化或新建会话失败会在发布前拒绝，通常先证明 managed range 已经完全停稳。如果清理也失败，拒绝会保留有序、安全的启动与拆卸事实，但不会声称整个 range 已经停稳。非取消错误只暴露固定的提供方、阶段与类别事实；原始失败保留在内部 cause 链与 Host 诊断中。发布后，提示词、传输或进程提前退出会以携带安全诊断的 `error` 结算；本地取消则以不带失败详情的 `aborted` 结算。

### 安全诊断

通用诊断使用固定的一行：`Subagent failure (provider: ACP; stage: <stage>; category: <category>; ...)`。可选的停止原因、退出码与信号只来自封闭协议或受管进程事实。stderr、异常文本、任务内容、工具输入、路径、环境值、凭据与协议载荷绝不会进入诊断；共享结果边界把诊断限制在 4096 个 UTF-8 字节内。请求过权限且未完成的运行可以增加一行固定的策略、工具种类与决定。成功运行和本地取消不包含该行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端如何经 ACP 驱动子 agent，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **完全进程隔离。** 每个子 agent 在全新子进程中运行，拥有自己的会话、模型与工具；只有解析后的工作目录从父级跨越。
- **每次运行一个进程。** 每次运行都 spawn 新进程；没有进程池。
- **ACP 协议格式（wire format）是序列化边界。** 同进程 subagent 值不会为防御目的克隆；协议才是校验不可信输入的地方。

### 启动与所有权流程

一次启动先解析子 agent 的工作目录（配置的 `cwd` 覆盖值，否则取父会话 cwd），经子进程 seam spawn 命令，完成 ACP `initialize` 与 `newSession` 握手，然后才发布运行。兑现意味着远程会话已就绪、所有权已转移给调用方。dispose（资源释放）是幂等的：先关闭 stdin 并按配置的宽限等待协作式完全停稳，再经 SIGTERM 升级到 SIGKILL，并等待整个 managed range 退出。清理失败会作为有序的安全事实保持可观察，且绝不声称已经完全停稳。

### 停止原因映射

运行结果会把 ACP 终态映射进共享的停止原因词汇（`completed`、`max-tokens`、`refusal`、`aborted` 或 `error`），实现见 [`src/run.ts`](src/run.ts)。

### 进程边界

子进程经子进程 seam spawn：先清除疑似凭据的环境变量，再合并显式 `config.env` 值。stderr 继承到父级流，dispose 先应用本提供方的 EOF 窗口，再执行共享的逐级终止。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本后端逐步进入它接入的 seam 与它驱动的协议。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Agent Client Protocol 自动化服务器](../../acp/acp/README.zh.md)——本提供方作为客户端驱动的仅自动化服务器。
- [dsh-subprocess seam](../../subprocess/subprocess/README.zh.md)——每次运行背后的进程 spawn 与清理机制。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-acp)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

远程子 agent 通过 ACP 接收独立任务内容，并使用其自身进程配置的系统提示词、工具和全新会话。它不接收父级对话。本提供方不声明可选启动时能力，因此本地服务会拒绝要求 `agentOptions`、persona、工具过滤、深度强制或结构化输出的请求，而不是静默省略。

#### Token 影响

子 agent 为独立的完整上下文及其多步骤历史支付 token 成本。这些 token 绝不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。每个 ACP 子 agent 只能在其自身提供方、模型、组合和历史均相同时复用前缀；其余情况下，子 agent 步骤仅追加增长。

### 父级工具结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父级只接收子 agent 最终的流式 assistant 文本或该消费方给出的精确停止原因错误，不接收中间消息或工具流量。未完成的结果会先呈现安全诊断，再单独保留部分 assistant 输出。发布前已经取消的请求会精确变为 `Error: subagent request was aborted before the ACP child started`；其他启动失败只包含固定的 `Subagent failure (...)` 行。

#### Token 影响

父级输入只增加最终结果或错误，其内容依赖数据，并保留到压缩（compaction）为止。本提供方自身不会添加父级 schema。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 ACP 对比或任务积压。

- **每次运行使用全新进程**——没有进程池；每次委派都要付出完整的 spawn 与 ACP 握手成本。
- **仅支持本地工作区**——解析后的工作目录是交给同一台机器上子进程的本地路径；远程工作区映射尚未设计。
- **不支持可选启动时能力**——本提供方无法在远程进程内应用 `agentOptions`、`outputSchema`、深度上限、工具过滤器或 persona，因此 seam 会拒绝需要它们的请求。
- **只收集已提交的 `agent_message_chunk` 文本**——自动化服务器把推理（reasoning）、工具活动、计划和其他 trace 数据保留在子 agent 会话日志中，不通过 ACP 发出。
- **权限提示自动应答**（`permission: allow | reject`）——不会把子 agent 的 `session/request_permission` 呈现给人。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **进程池**——持久进程复用是可能的未来优化，但会改变每次运行的隔离模型。
- **远程工作区**——映射远程 ACP agent 的工作区需要独立的后端能力。
- **可继续 ACP 子级**——需要持久化远程会话 id 与逐子级的继续执行能力声明。

</details>

**运行时不变式：** 不发布伴生入口。本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
