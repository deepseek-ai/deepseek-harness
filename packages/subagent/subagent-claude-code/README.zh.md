---
description: "面向用户与维护者的一次性 Claude Code subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Claude Code 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

[English](README.md) | 中文

## 概述

`dsh-subagent-claude-code` 注册由 Profile 命名、默认名称为 `claude-code` 的 Claude Code subagent 提供方，它在发起委派的会话工作区中通过官方 Agent SDK 运行真实的 Claude Code CLI 子 agent（智能体）。每次接受的运行提交一个自包含文本任务，并通过共享的 subagent 结果约定返回严格的最终答案——或独立的安全失败诊断。该提供方作为可选的 Profile Bundle 发布：安装会带入锁定的 Agent SDK 与一个兼容的平台 CLI 载荷，而注册的提供方在绑定工具调用前保持休眠。原生 Claude 设置与身份验证继续是权威来源，Profile 选择的 `permissionMode` 决定这个无人值守 query 如何处理权限检查。当子 agent 应该是与父 harness 完全隔离的真实 Claude Code 产品会话时，选择它。

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

当委派应以父级工作区中的真实 Claude Code 会话运行时，挂载本提供方。常用路径是显式的：把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露给模型。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。安装会把锁定的 Agent SDK 与一个兼容的平台 CLI 载荷带入 Profile；声明的 patch 层只注册休眠的提供方，不启动任何 Claude 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方及其私有运行时闭包。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Claude 原生设置 | 为本提供方实例的每次运行固定的可选非空模型名称；省略时不发送 SDK 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式 SDK/CLI 环境 |
| `permissionMode` | `dontAsk` | 为本提供方实例的每次运行固定的原生非交互权限策略 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |

| `permissionMode` 值 | 原生行为 |
|---|---|
| `dontAsk` | 不弹出提示，直接拒绝尚未获授权的操作 |
| `acceptEdits` | 接受文件编辑；其余权限提示由无人值守回调拒绝 |
| `auto` | 由 Claude Code 原生分类器允许或拒绝权限请求 |
| `plan` | 使用原生规划模式，拒绝执行审批，并把完整计划作为最终答案返回 |
| `bypassPermissions` | 显式设置 SDK 的危险确认并跳过权限检查 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给该提供方实例的每次 query；省略时保留原生模型选择。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。提供方省略 SDK 的 `settingSources` 选项，因此 Claude Code 会相对于父会话 cwd 读取宿主机常规的用户、项目与本地设置。它不会复制或过滤这些文件、创建或修改登录状态、检查 `PATH`，也不会回退到宿主 `claude` 可执行文件。

### 暴露工具

每个委派工具行指名一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_claude_code`。

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 Job id，供 `job_output` 或 `job_kill` 使用；base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

### 你会得到什么

前台调用会把严格的最终 Claude Code 答案交给模型；运行失败时则返回带停止原因与可选安全诊断的错误。后台调用先返回 Job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一最终答案或失败状态。Claude Code 的推理、工具活动、中间消息、stderr 与工作区差异绝不会进入父级会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 SDK 启动边界以安全的 `query-start` / `unknown` 失败事实失败；不存在宿主 CLI 回退。原始产品错误只保留在内部 cause 链与提供方 Host 日志中。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何驱动真实 Claude Code CLI，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **每次运行一个全新 query。** 每次运行都拥有独立的 SDK query、取消控制器、CLI 进程与不持久化的产品会话；没有续接、恢复或池化。
- **原生设置是权威。** 提供方故意省略 SDK 的 `settingSources` 选项，因此 Claude Code 读取宿主机常规的用户、项目与本地设置；可选 `model` 与必需的 `permissionMode` 是仅有的 query 级覆盖。
- **刻意无人值守。** `AskUserQuestion` 被禁用，除 bypass 模式外权限提示都会被拒绝，因此 query 绝不会等待用户界面。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | SDK query 生命周期、结果接受与权限处理 |
| [`src/process.ts`](src/process.ts) | dispose 时的 managed-range 逐级终止 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

### 运行流程

一次启动只接受非空的文本块序列，并根据父会话确定子级 cwd。它创建私有 `AbortController`，用精确拼接的任务调用官方 SDK `query()`，并仅在 SDK 的 custom-spawn 钩子已经提供由子进程 seam 管理的活动 CLI 句柄后发布运行。提供方完整迭代消息流，只接受满足 `subtype: "success"`、`is_error: false` 且 `result` 非空白、随后迭代器正常结束的 `result` 消息。其余一切结果都映射为带固定类别的 `error` 诊断，命名生命周期阶段与已观测进程结果——类别集合见 [`src/run.ts`](src/run.ts)。本地取消会在结果竞态中胜出并映射为 `aborted`，且不附带失败诊断。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Codex subagent 提供方](../subagent-codex/README.zh.md)——经官方 app-server 协议的兄弟产品后端。
- [Claude Code 与 Codex 后端](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Claude Code 子级会在一个全新的 SDK query 中接收独立文本任务。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型、环境与非交互权限模式，而省略的模型及其余产品设置来自 Claude 原生配置。可执行版本来自 Bundle 锁定的 SDK 平台载荷。

#### Token 影响

子级需为独立的 Claude Code 上下文和 query 承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Claude Code 自身的模型、指令、工具、原生设置和全新 query。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到符合严格成功条件的 Claude Code 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。该诊断可以区分粗粒度行动类别、生命周期阶段和已观测的进程结果，而不复制原始产品文本或版本专属 subtype 名称。后台调用会先返回 Job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开同一最终答案或失败状态 detail，并允许 `job_kill` 请求取消。Claude Code 的推理、工具活动、中间消息、stderr、工作区差异、用量信息、产品标识符、工具输入和原始协议载荷均不会复制到父会话。

#### Token 影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Claude Code 对比或任务积压。

- **每次运行均新建一个 query 和一个进程**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **宿主设置有意保持权威**——省略 `model` 时由项目与用户设置选择模型；原生设置始终保留其余工具和行为，本提供方不提供经过筛选或与宿主环境隔离的生产模式。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录或改写 Claude 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类。
- **委派时必须存在 SDK 平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次 query 时失败；不会回退到宿主 CLI。
- **没有人工交互路径**——`AskUserQuestion` 被禁用，权限提示会被拒绝，MCP elicitation 会被拒绝，阻塞对话会快速失败而不会挂起。
- **assistant 载荷仅包含最终文本**——失败运行可以额外公开独立的安全诊断；推理、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 92 MB、解包后约 325 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 Agent SDK 0.3.241；升级会锁定新的 SDK 版本，并需要重新运行无密钥真实产品与 loader 组合证据。

</details>

**运行时不变式：** 不发布伴生入口。生命周期配对属于共享 subagent service，受管范围的所有权属于 subprocess service。
