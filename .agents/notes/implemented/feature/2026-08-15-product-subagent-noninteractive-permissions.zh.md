# Agent Note: 产品 subagent 使用 Profile 选择的非交互权限

Status: implemented

[English](2026-08-15-product-subagent-noninteractive-permissions.md) | 中文

## Problem

[Claude Code 与 Codex 产品提供方](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)都在没有人工界面的情况下运行。因此，原生权限提示、用户对话或 MCP elicitation 不能等待人员响应，但依赖任一产品环境中的默认值仍可能选择交互模式。部署也需要选择更宽松的原生模式，同时不能让父模型或单次工具调用提升自身权限。

失败的产品运行此前只能把终止原因送入 [subagent seam](2026-06-21-subagent-capability-seam.zh.md)。日志可以保留产品错误，但前台父 agent 与[一次性后台 Job](../../archived/feature/2026-08-12-product-subagent-one-shot-background-tasks.md)无法区分权限拒绝和其他失败。若复用 assistant 输出承载该事实，则会把基础设施说明错误归因给子模型。

## Decision

每个产品提供方分别拥有自己的 Profile 级 `permissionMode` 值。两个 Config 字段有意使用各产品的原生名称，而不是共享的受限／自动／完全抽象。提供方会为该插件实例的每次运行固定已解析值。subagent 工具 schema 与 `SubagentStartRequest` 都不包含权限字段，因此模型或单次委派无法改变它。

### Claude Code

Claude Code 默认使用 `dontAsk`，而且只接受锁定版本 Agent SDK 支持的原生非交互模式：

| 值 | 原生行为 |
| --- | --- |
| `dontAsk` | 不弹出提示，直接拒绝尚未获授权的操作。 |
| `acceptEdits` | 接受编辑；其余权限提示由无人值守回调拒绝。 |
| `auto` | 由 Claude Code 原生分类器允许或拒绝权限请求。 |
| `plan` | 使用规划模式，拒绝执行审批，并把完整计划作为最终答案返回。 |
| `bypassPermissions` | 设置 SDK 的显式危险确认并跳过权限检查。 |

提供方继续省略 `settingSources`：可选的实例级模型是独立的直接 SDK 覆盖；除所选模式以外，用户、项目和本地设置、身份验证、工具与沙箱行为仍由 Claude Code 拥有。

每次 query 都禁用 `AskUserQuestion`。非 bypass 模式的权限回调会拒绝请求，而不会返回 SDK 中会无限阻塞的 `null`；plan 模式还会把 `ExitPlanMode` 放入 `disallowedTools`，因此原生 allow 规则无法把无人值守 query 切回执行模式。MCP elicitation 会被拒绝；已支持的拒绝对话会被取消；未声明的对话类型使用 SDK 的无对话失败行为。原生 `permission_denied` 消息会记录同一份当前运行事实。这些路径不会创建审批会话、队列、缓存或重试循环。

### Codex

Codex 默认使用 `never`，并接受 Codex 0.149.1 公开的三种原生非交互模式。提供方启动固定的 app-server 命令，再把所选模式映射为官方 `thread/start` 字段，因为 CLI 全局权限 flag 不会配置之后由 app-server 客户端创建的线程：

| 值 | `thread/start` 字段 | 原生行为 |
| --- | --- | --- |
| `never` | `approvalPolicy: never`；省略 sandbox | 永不弹出提示；执行失败会在原生 sandbox 下返回模型。 |
| `approve-for-me` | `approvalPolicy: on-request`、`approvalsReviewer: auto_review`、`sandbox: workspace-write` | 由 Codex 自动评审权限请求。 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`、`sandbox: danger-full-access` | 跳过审批与 sandbox。 |

提供方只覆盖这些权限与 sandbox 字段。可选的实例级模型是独立的直接 `thread/start` 覆盖；`CODEX_HOME`、项目配置、模型 provider 选择、MCP、hook、skill、身份验证，以及模式未选择的 sandbox 事实仍属于 Codex 原生状态。wire 仍会拒绝任何意外到达的审批、权限、用户输入或 MCP 请求，而不会开放动态 allow 通道。

### 失败诊断

`SubagentResult` 携带可选的 `diagnostic`，用于提供方产生且不属于 assistant 内容的失败说明。提供方在生成它之前会排除工具输入、文件内容、环境值、凭证与原始协议载荷。共享的进程外结果边界会把完整文本限制在 4096 个 UTF-8 字节以内，并在不切断字符的前提下标记截断。[最小诊断决策](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md)负责两个产品通过同一字段承载的非权限行动类别、生命周期阶段、HTTP 事实与进程结果。

每个产品的权限事实都只包含有效模式、请求类别、无人值守决定与固定的安全原因。Claude Code 从 SDK 回调和 `permission_denied` 消息取得这些事实。Codex 从 app-server 请求、被拒绝的 item 与结构化 `sandboxError` 终态取得事实。原始 stderr 仍会转发给 Host，但既不会被分类，也绝不会复制进诊断。两个提供方都会把失败行放在最新参与失败的权限事实之前。成功结果只返回严格的最终答案；本地取消仍以 `aborted` 结算且不附带权限说明；未发布的启动失败仍会拒绝 `start()`。提供方绝不会把任一诊断事实写入 assistant 输出、结构化输出或 `subagent/end.lastAssistantMessage`。

前台消费方依次呈现终止原因标题、可选诊断和任何部分 assistant 输出。一次性后台适配器会在失败 Job 的 detail 中，把同一诊断与终止原因一起保存。没有填写该字段的提供方保持原有行为。

### 所有权与生命周期

| 事实或资源 | Owner | 可观察行为 |
| --- | --- | --- |
| Profile 权限选择 | 各产品提供方 Config | 配置阶段会拒绝无效、交互式或未知值。 |
| 权限与沙箱语义 | Claude Code Agent SDK 或 Codex app-server | 各提供方传入一个原生模式，不镜像产品策略。 |
| 交互决定与安全诊断 | 单次产品运行 | 并发运行分别拥有独立的模式、协议与诊断状态。 |
| 诊断类型与字节上限 | `dsh-subagent` | 消费方收到与 assistant 输出分离的有界可选字段。 |
| 前台与 Job 呈现 | `dsh-tool-subagent` 和通用 Job 运行时 | 调度选择不会改变底层失败事实。 |
| 进程取消与完全停稳 | 产品提供方和 `dsh-subprocess` | 结果结算后仍执行幂等的完整进程树资源释放。 |

## Verification

包测试固定所有允许与拒绝的 Config 值、准确的 SDK 与 app-server 字段映射、危险确认、无人值守终态、诊断脱敏与 UTF-8 上限、成功结果不携带诊断、并发运行隔离、前台顺序、Job detail、stderr observer 释放和进程清理。真实 Claude Agent SDK 0.3.241 与 Claude Code 2.1.241 fixture 证明其安全默认、受限拒绝、显式 bypass 与整棵进程树完全停稳。真实 Codex 0.149.1 app-server fixture 证明线程级 `never` 覆盖环境中的 `on-request`、自动评审可以启动、危险绕过只在测试拥有的临时存储中写入、被拒绝的提权不会留下副作用且诊断不含原始命令或路径、stderr 只供 Host 观测，而且 wrapper／native 进程树会退出。Loader 组装证明非默认模式可以在不启动任一产品的情况下发布；无密钥 ACP snapshot 则记录每个产品的失败诊断如何经过前台与 Job 呈现，同时面向模型的产品工具 schema 不包含权限参数。

## Alternatives considered

**使用产品环境中的权限默认值。** 原生设置可能选择交互模式，使无人值守行为依赖部署环境。提供方必须为每次 query 显式选择非交互模式。

**把权限模式放入面向模型的工具或每次 start 请求。** 这会让任务内容选择权限，并在每次调用中重复一个 Profile 部署决定。

**复制产品设置或映射父级 Harness 沙箱。** 各产品并不共享同一套权限词汇。镜像这些状态会创建第二个权威，并掩盖自动模式与 bypass 模式的原生沙箱后果。

**把提示转发给父 agent、Web 客户端或 CLI。** 一次性产品运行没有由其拥有的人工交互生命周期。新增该能力需要持久请求身份、路由、取消与 timeout 语义，超出本决策范围。

**返回原始产品错误、stderr 或工具输入。** 这些值可能包含命令、路径、工作区数据、环境值或凭证。固定的安全诊断既保留可操作性，也不会暴露产品 transcript。

**单独保存 Job 诊断。** Job 只是同一 `SubagentRun` 的调度适配器；第二个字段会让前台和后台的失败含义发生漂移。

## Consequences

Profile 可以在提供方启动前选择各产品原生的受限、自动、在产品支持时仅规划／编辑放行，或 bypass 行为，而两个安全默认值都绝不会询问人员。更宽松的模式仍是显式部署选择，并保留其原生沙箱后果。

权限失败会同时到达前台父 agent 和一次性后台 Job，且不会把基础设施文本伪装成 assistant 回答。同一字段还可以承载由另一项决策负责的结构化失败事实。它可以沿普通消费路径进入模型上下文、Job 通知、API 投影与 Job UI，因此提供方必须在结果结算前对完整文本完成脱敏和限长。

本改动不增加产品会话持久化、人工审批通道、动态权限操作、进度流、重试策略或回滚。其他提供方无需产生诊断或公开权限模式 Config，仍然保持合法。
