---
description: "面向用户与维护者的一次性 Codex subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Codex 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

## 概述

`dsh-subagent-codex` 注册由 Profile 命名、默认名称为 `codex` 的 Codex subagent 提供方，它在发起委派的会话工作区中通过官方 app-server 协议运行真实的 Codex 子 agent（智能体）。每次接受的运行以 `app-server --stdio` 启动包内 Codex wrapper，创建一个临时 Codex 线程，提交一个自包含文本任务，并通过共享的 subagent 结果约定返回选定的最终答案——或独立的安全失败诊断。该提供方作为可选的 Profile Bundle 发布：安装会带入官方 wrapper 与一个兼容的原生平台载荷，而注册的提供方在绑定工具调用前保持休眠。原生 Codex 配置与身份验证继续是权威来源，Profile 选择的 `permissionMode` 会映射进线程的 approval、reviewer 与 sandbox 字段。当子 agent 应该是与父 harness 完全隔离的真实 Codex 会话时，选择它。

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

当委派应以父级工作区中的真实 Codex 会话运行时，挂载本提供方。常用路径是显式的：把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露给模型。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。安装会把官方 wrapper 与一个兼容的原生平台载荷带入 Profile；声明的 patch 层只注册休眠的提供方，不启动任何 Codex 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方及其私有运行时闭包。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `codex` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Codex 原生设置 | 为本提供方实例的每个线程固定的可选非空模型名称；省略时不发送 app-server 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子进程环境 |
| `permissionMode` | `never` | 为本提供方实例的每个线程固定的原生非交互审批与沙箱模式 |
| `disposeGraceMs` | `3000` | 共享进程树责任方各终止层级之间的宽限 |

| `permissionMode` 值 | `thread/start` 字段 | 原生行为 |
|---|---|---|
| `never` | `approvalPolicy: never`；省略 sandbox | 永不请求审批；执行失败会在原生 sandbox 下返回模型 |
| `approve-for-me` | `approvalPolicy: on-request`、`approvalsReviewer: auto_review`、`sandbox: workspace-write` | 由 Codex 自动评审权限请求，不等待人工 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`、`sandbox: danger-full-access` | 跳过审批与 sandbox；必须显式选择该值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给每个临时 `thread/start`；省略时保留原生模型选择。提供方不会发现模型、改写别名、选择 `modelProvider` 或 `serviceTier`，也不会设置 fallback。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。

### 暴露工具

每个委派工具行指名一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_codex`。

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 Job id，供 `job_output` 或 `job_kill` 使用；base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

### 你会得到什么

前台调用会把选定的最终 Codex 答案交给模型；运行失败时则返回带停止原因与可选安全诊断的错误。后台调用先返回 Job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一最终答案或失败状态。Codex 的过程说明、推理、工具活动、原始 stderr 与工作区差异绝不会进入父级会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 `initialize` 阶段以安全 `unknown` 类别和任何已观测进程结果失败；不存在宿主 CLI 回退。原始 wrapper 文本只保留在 Host stderr。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何驱动真实 Codex app-server，以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **每次运行一个全新进程、线程与轮次。** 每次运行都会 spawn 全新 app-server、创建一个临时线程并恰好执行一个轮次；没有续接、恢复或池化。
- **原生配置是权威。** Codex 配置与身份验证经父级 cwd、`HOME` 与 `CODEX_HOME` 保持原生；提供方只覆盖可选模型以及线程的 approval、reviewer 与 sandbox 字段。
- **刻意无人值守。** 审批、用户输入与 MCP 请求都会在无人参与的情况下被应答或拒绝；未知服务器请求会使运行失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | 运行生命周期、轮次执行、结果选择与诊断 |
| [`src/wire.ts`](src/wire.ts) | 最小的 app-server JSON-RPC 协议实现 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

### 运行流程

一次启动只接受非空的文本块序列，并根据父会话确定子级 cwd。它经子进程 seam spawn 固定命令，完成 `initialize` → `initialized` 握手，把 Profile 选择的模式与可选模型映射为官方 `thread/start` 字段并与 `{ cwd, ephemeral: true }` 一起发送，且仅在 Codex 返回有效的临时线程后发布运行。已发布的结果恰好启动一个轮次，只接受与此次运行的线程和轮次匹配的通知，并等待权威的 `turn/completed` 终态。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。成功完成的轮次若没有非空白答案，结果也会判为错误。失败轮次使用粗粒度类别 `limit`、`access-policy`、`service`、`transport`、`product-error`、`invalid-result` 或 `unknown`；app-server 提前退出使用 `process`，适用的连接与 stream 失败保留数值 `httpStatusCode`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Claude Code subagent 提供方](../subagent-claude-code/README.zh.md)——经官方 Agent SDK 的兄弟产品后端。
- [Claude Code 与 Codex 后端](../../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Codex 子级会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型、环境、非交互审批策略与沙箱模式，而省略的模型及其余产品设置来自 Codex 原生配置。可执行版本来自 Bundle 锁定的平台载荷。

#### Token 影响

子级需为独立的 Codex 上下文和轮次承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到选定的 Codex 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。该诊断可以区分粗粒度行动类别、协议阶段、适用的数值 HTTP status 和已观测的进程结果，而不复制产品正文或 stderr。后台调用会先返回 Job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开同一最终答案或失败状态 detail，并允许 `job_kill` 请求取消。Codex 的过程说明、推理（reasoning）、工具活动、原始 stderr、工作区差异、用量信息、产品标识符、命令、路径和协议载荷均不会复制到父会话。

#### Token 影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Codex 对比或任务积压。

- **每次运行均新建一个进程、一个线程和一个轮次**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录、信任项目或改写 Codex 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类体系。
- **委派时必须存在原生平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次运行时失败；不会回退到宿主 CLI。
- **兼容性由开发证据锁定**——若要从已验证的 0.149.1 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**——已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；三种 Profile 模式都不会创建 DSH 交互通道或逐次调用 allow 策略。
- **assistant 载荷仅包含最终文本**——失败运行可以额外公开独立的安全诊断；推理、过程说明、中间消息、工具通信、用量信息、原始 stderr 和工作区差异不会进入父会话，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 114 MB、解包后约 282 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 `@openai/codex@0.149.1`；升级需要重新生成上游 schema 证据并重新运行带凭证的随机数测试。

</details>

**运行时不变式：** 不发布伴生入口。生命周期配对属于共享 subagent service，process-tree 所有权属于 subprocess service。
