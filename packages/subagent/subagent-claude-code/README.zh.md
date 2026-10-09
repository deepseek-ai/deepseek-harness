---
description: "面向用户与维护者的一次性 Claude Code subagent 提供方，用于选择产品后端、安装 Profile bundle 或配置无人值守的 Claude Code 委派。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

[English](README.md) | 中文

## 概述

当委派任务应在父工作区中以全新、无人值守的 Claude Code 会话运行时，安装这个 Profile Bundle。每次运行接受一个自包含文本任务，并返回最终答案或安全的失败诊断；推理、工具通信、stderr、用量信息和工作区差异不会进入父 Session。Claude 原生设置与身份验证继续是权威来源，而 Profile 配置选择模型、环境和 `permissionMode`。针对平台锁定的运行时仅在需要时启动，并且绝不会回退到宿主 `claude` 可执行文件。当隔离和真实 Claude Code 行为比续接或提示更重要时，选择本包。

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

当任务需要在父工作区中运行全新的原生 Claude Code 会话时，在 Web 或 Desktop 插件页启用 **Claude Code 子智能体**。

### 安装 Bundle

官方条目可离线显示。启用时，普通 bundle 安装器会安装[当前 DSH 安装对应的目标](../../boot/plugin-manager/README.zh.md#use-this-package)并选择其配置层。此层注册提供方，并为所有智能体添加全局工具 `subagent_claude_code`；实际委派前不会启动原生进程。安装器提示需要重启时，请重启应用。

关闭只会取消选择配置层，保留已安装的包。移除是独立的包操作。启用或关闭会在运行中的 Host 注册或移除该全局工具，正在运行的智能体会在下一次请求时看到变化。

此层只插入 Host 条目，因此任何配置（包括随附的 headless、SDK 和 ACP）都可以选择它。原有仅提供方用法请遵循[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.zh.md)。

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

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)是每个受支持字段及其 JSDoc 的穷尽式真源。已配置的 `model` 会原样传给该提供方实例的每次 query；省略时保留原生模型选择。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的 API 密钥必须在该配置中显式提供。提供方省略 SDK 的 `settingSources` 选项，因此 Claude Code 会相对于所选子级工作目录 读取宿主机常规的用户、项目与本地设置。它不会复制或过滤这些文件、创建或修改登录状态、检查 `PATH`，也不会回退到宿主 `claude` 可执行文件。

<a id="exposing-the-tool"></a>
### 暴露工具

Bundle 将 `tool-subagent-claude-code` 作为 Host 条目插入，因此 `subagent_claude_code` 是所有预设（包括 minimal）都可见的全局工具。后续用户补丁可以按 id 配置或禁用该行。预设自行注册的同名工具会为其智能体遮蔽该全局工具。若要不选择 bundle 层而挂载提供方和工具，在 `cordis.patch.yml` 中插入相同的条目：

```yaml
- insert:
    - id: subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-claude-code'
    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: claude-code
        toolName: subagent_claude_code
        maxDepth: provider-managed
```

工具接受任务后返回 child id；任务完成后向父 agent 发送结果通知。外部 activation 只执行一次，不支持追加输入或恢复对话。

### 你会得到什么

完成通知包含 Claude Code 的最终答案，或停止原因与可选的安全诊断。父会话还独立保存外部任务的身份和完整终态结果；无需创建本地子 Session。产品推理、工具活动、原始 stderr 与工作区差异不会进入父会话。

### 失败与恢复

省略 optional dependencies、当前平台不受支持或所选载荷缺失的安装会让提供方保持休眠，并在第一次委派时于 SDK 启动边界报告安全的 `query-start` / `unknown` 失败事实；不存在宿主 CLI 回退。原始产品错误只保留在内部 cause 链与提供方 Host 日志中。被取消的运行以 `aborted` 结算。

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
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | SDK query 生命周期、结果接受与权限处理 |
| [`src/process.ts`](src/process.ts) | dispose（资源释放）时的 managed-range 逐级终止 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册提供方并添加预设委派工具的 Profile 配置层 |

### 运行流程

一次启动只接受非空的文本块序列，并使用子代理服务选择的子级 cwd。它创建私有 `AbortController`，用精确拼接的任务调用官方 SDK `query()`，并仅在 SDK 的 custom-spawn 钩子已经提供由子进程 seam 管理的活动 CLI 句柄后发布运行。提供方完整迭代消息流，只接受满足 `subtype: "success"`、`is_error: false` 且 `result` 非空白、随后迭代器正常结束的 `result` 消息。其余一切结果都映射为带固定类别的 `error` 诊断，命名生命周期阶段与已观测进程结果——类别集合见 [`src/run.ts`](src/run.ts)。本地取消会在结果竞态中胜出并映射为 `aborted`，且不附带失败诊断。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方逐步进入它接入的 seam 与兄弟产品提供方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [Codex subagent 提供方](../subagent-codex/README.zh.md)——经官方 app-server 协议的兄弟产品后端。
- [历史Claude Code 与 Codex 后端](../../../.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)——产品提供方的设计记录。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-claude-code)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

Claude Code 子级会在一个全新的 SDK query 中接收独立文本任务。它的工作区是所选子级工作目录；所选提供方实例会固定已配置的模型、环境与非交互权限模式，而省略的模型及其余产品设置来自 Claude 原生配置。可执行版本来自 Bundle 锁定的 SDK 平台载荷。

#### Token 影响

子级需为独立的 Claude Code 上下文和 query 承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 Claude Code 自身的模型、指令、工具、原生设置和全新 query。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父模型先收到 child id，随后收到 Claude Code 最终答案或带停止原因与安全诊断的失败通知。诊断只包含固定的阶段、类别和已观测的协议或进程事实。产品推理、中间消息、工具活动、stderr、用量、产品标识符、命令、路径与原始协议载荷不会复制到父 Session。

#### Token 影响

父级输入会增加启动确认与完成通知，包括最终答案或失败信息。子任务 token 不进入父级上下文。本提供方自身不添加父级工具 schema。

#### KV Cache 影响

启动确认与完成通知仅追加到可复用的父请求前缀之后。通知可能唤醒新轮次，不会改写已有前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 Claude Code 对比或任务积压。

- **每次运行均新建一个 query 和一个进程**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改提供方与模型，而且每个公开工具都需要唯一的 `toolName`。
- **宿主设置有意保持权威**——省略 `model` 时由项目与用户设置选择模型；原生设置始终保留其余工具和行为，本提供方不提供经过筛选或与宿主环境隔离的生产模式。
- **身份验证与账户状态仍由原生机制管理**——Bundle 会提供 CLI，但不会创建账户、登录或改写 Claude 设置；配置与身份验证失败会公开其生命周期阶段与安全的 `unknown` 回退，而不会增加单独的公开分类。
- **委派时必须存在 SDK 平台载荷**——省略 optional dependencies 的安装、不受支持的平台以及缺失或损坏的载荷都会在第一次 query 时失败；不会回退到宿主 CLI。
- **没有人工交互路径**——`AskUserQuestion` 被禁用，权限提示会被拒绝，MCP elicitation 会被拒绝，阻塞对话会以拒绝方式失败而不会挂起。
- **assistant 载荷仅包含最终文本**——失败运行还可公开独立的安全诊断；推理、中间消息、工具通信、用量、stderr 与工作区差异不会进入父 Session。任务身份与终态结果保存在父日志中。
- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **载荷体积披露**——当前 darwin-arm64 平台载荷压缩后约 92 MB、解包后约 325 MB；这些是披露数字，不是安装阈值。
- **版本锁定的协议**——运行时依赖锁定为 Agent SDK 0.3.263；升级会锁定新的 SDK 版本，并需要重新运行无密钥真实产品与 loader 组合证据。

</details>
