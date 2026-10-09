---
description: "面向用户与维护者的一次性 Codex subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Codex 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

## 概述

当委派工作需要在父会话工作区中的真实无人值守 Codex 会话内运行时，把 `@deepseek-ai/dsh-subagent-codex` 安装进 Profile。每次委派都会为一个自包含文本任务使用全新且隔离的 Codex 线程，并且只返回其最终答案或安全失败诊断。原生 Codex 配置和身份验证继续作为权威来源，而 `permissionMode` 选择非交互式审批和沙箱行为。Bundle 提供兼容的原生 Codex 载荷，并以全局工具形式添加委派工具。

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

当任务需要在父工作区中运行全新的原生 Codex 会话时，在 Web 或 Desktop 插件页启用 **Codex 子智能体**。

### 安装 Bundle

官方条目可离线显示。启用时，普通 bundle 安装器会安装[当前 DSH 安装对应的目标](../../boot/plugin-manager/README.zh.md#use-this-package)并选择其配置层。此层注册提供方，并为所有智能体添加全局工具 `subagent_codex`；实际委派前不会启动原生进程。安装器提示需要重启时，请重启应用。

关闭只会取消选择配置层，保留已安装的包。移除是独立的包操作。启用或关闭会在运行中的 Host 注册或移除该全局工具，正在运行的智能体会在下一次请求时看到变化。

此层只插入 Host 条目，因此任何配置（包括随附的 headless、SDK 和 ACP）都可以选择它。原有仅提供方用法请遵循[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.zh.md)。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `codex` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `model` | Codex 原生设置 | 为本提供方实例的每个线程固定的可选非空模型名称；省略时不发送 app-server 覆盖 |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子进程环境 |
| `permissionMode` | `never` | 为本提供方实例的每个线程固定的原生非交互审批与沙箱模式 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |

| `permissionMode` 值 | `thread/start` 字段 | 原生行为 |
|---|---|---|
| `never` | `approvalPolicy: never`；省略 sandbox | 永不请求审批；在原生 sandbox 下发生的执行失败会返回给模型 |
| `approve-for-me` | `approvalPolicy: on-request`、`approvalsReviewer: auto_review`、`sandbox: workspace-write` | 由 Codex 自动评审权限请求，不等待人工 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`、`sandbox: danger-full-access` | 跳过审批与 sandbox；必须显式选择该值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给每个临时 `thread/start`；省略时保留原生模型选择。提供方不会发现模型、改写别名、选择 `modelProvider` 或 `serviceTier`，也不会设置 fallback。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。

<a id="exposing-the-tool"></a>
### 暴露工具

Bundle 将 `tool-subagent-codex` 作为 Host 条目插入，因此 `subagent_codex` 是所有预设（包括 minimal）都可见的全局工具。后续用户补丁可以按 id 配置或禁用该行。预设自行注册的同名工具会为其智能体遮蔽该全局工具。若要不选择 bundle 层而挂载提供方和工具，在 `cordis.patch.yml` 中插入相同的条目：

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

工具接受任务后返回 child id；任务完成后向父 agent 发送结果通知。外部 activation 只执行一次，不支持追加输入或恢复对话。

### 你会得到什么

完成通知包含 Codex 的最终答案，或停止原因与可选的安全诊断。父会话还独立保存外部任务的身份和完整终态结果；无需创建本地子 Session。产品推理、工具活动、原始 stderr 与工作区差异不会进入父会话。

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
| [`cordis.patch.yml`](cordis.patch.yml) | 注册提供方并添加预设委派工具的 Profile 配置层 |

### 运行流程

一次启动只接受非空的文本块序列，并使用子代理服务选择的子级 cwd。它经子进程 seam spawn 固定命令，完成 `initialize` → `initialized` 握手，把 Profile 选择的模式与可选模型映射为官方 `thread/start` 字段并与 `{ cwd, ephemeral: true }` 一起发送，且仅在 Codex 返回有效的临时线程后发布运行。已发布的结果恰好启动一个轮次，只接受与此次运行的线程和轮次匹配的通知，并等待权威的 `turn/completed` 终态。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。成功完成的轮次若没有非空白答案，结果也会判为错误。失败轮次使用粗粒度类别 `limit`、`access-policy`、`service`、`transport`、`product-error`、`invalid-result` 或 `unknown`；app-server 提前退出使用 `process`，适用的连接与 stream 失败保留数值 `httpStatusCode`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Claude Code subagent 提供方](../subagent-claude-code/README.zh.md)——经官方 Agent SDK 的兄弟产品后端。
- [历史Claude Code 与 Codex 后端](../../../.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-codex)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Codex 子级会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是所选子级工作目录；所选提供方实例会固定已配置的模型、环境、非交互审批策略与沙箱模式，而省略的模型及其余产品设置来自 Codex 原生配置。可执行版本来自 Bundle 锁定的平台载荷。

#### Token 影响

子级需为独立的 Codex 上下文和轮次承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父模型先收到 child id，随后收到 Codex 最终答案或带停止原因与安全诊断的失败通知。诊断只包含固定的阶段、类别和已观测的协议或进程事实。产品推理、中间消息、工具活动、stderr、用量、产品标识符、命令、路径与原始协议载荷不会复制到父 Session。

#### Token 影响

父级输入会增加启动确认与完成通知，包括最终答案或失败信息。子任务 token 不进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

启动确认与完成通知仅追加到可复用的父请求前缀之后。通知可能唤醒新轮次，不会改写已有前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Codex 对比或任务积压。

- **每次运行均新建一个进程、一个线程和一个轮次**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录、信任项目或改写 Codex 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类体系。
- **委派时必须存在原生平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次运行时失败；不会回退到宿主 CLI。
- **兼容性由开发证据锁定**——若要从已验证的 0.153.4 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**——已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；三种 Profile 模式都不会创建 DSH 交互通道或逐次调用 allow 策略。
- **assistant 载荷仅包含最终文本**——失败运行还可公开独立的安全诊断；推理、中间消息、工具通信、用量、stderr 与工作区差异不会进入父 Session。任务身份与终态结果保存在父日志中。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 114 MB、解包后约 282 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 `@openai/codex@0.153.4`；升级需要重新生成上游 schema 证据并重新运行带凭证的随机数测试。

</details>
