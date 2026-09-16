# 子系统

[English](README.md) | 中文

每个子系统一页，覆盖 DeepSeek Harness 的全部子系统：它是什么、它操作哪些数据结构，以及——当它由某个 `ctx` 服务或事件作用域支撑时——一段生成的 **Cordis API** 小节，承载其服务与事件参考。本目录与 [architecture.md](../architecture.zh.md) 互补：后者描述跨子系统的*行为*（服务映射、会话/轮次/步骤生命周期、事件分类体系）；这里的每一页是单个子系统词汇与接线的参考。

| 页面 | 负责内容 |
|---|---|
| [boot.md](boot.zh.md) | 当前 profile 插件管理与 launcher 重载协调 |
| [core.md](core.zh.md) | `packages/core` 如何控制 agent loop（智能体循环）：逐包的循环说明、agent 创建与所有权（`AgentHandle`）、`Agent` 句柄的投递/取消/拦截约定，以及全仓通用类型模式（`…Map → derived-union`、品牌化 id） |
| [llm-streaming.md](llm-streaming.zh.md) | `packages/llm` 的对话类型——`Message`/`ContentBlock`、组装完成的模型请求、`StreamChunk` wire protocol 和适配器约定（adapter contract）、`BlockAssembler`，以及 `LlmAdapter` 提供方约定 |
| [token-meter.md](token-meter.zh.md) | 不可变的标量与位置回放度量，附带已消费日志修订号 |
| [scope.md](scope.zh.md) | 作用域注册标识、dispatch 载体，以及拥有的 `Scope` 上下文 |
| [typert.md](typert.zh.md) | 远程调用描述符、lookup/Context 声明、Typert 注册表，以及 Host Gateway/Client API 边界 |
| [goal.md](goal.zh.md) | 持久 goal 标识、生命周期快照、激活、变更记录与 Round 归属 |
| [schedule.md](schedule.zh.md) | 仅限会话内的提醒记录、持久转换、活动视图与普通对话交付 |
| [todo.md](todo.zh.md) | todo 包的整列表条目类型、持久事件所有权、投影和未结束轮次不变式 |
| [commands.md](commands.zh.md) | 人类命令注册表服务：定义、适配器发现、直接调用、结果与解析视图 |
| [session.md](session.zh.md) | 完整的 `SessionEventMap` 变体目录、`TurnEndReason`、`deriveMessages()`、执行封闭与独立事件 |
| [persistence.md](persistence.zh.md) | 持久性 seam：`SessionPersistence`、JSONL 提供方、`session/flush`、崩溃恢复、`SessionHeader` |
| [settings.md](settings.zh.md) | 用户设置 seam：`SettingsNamespace` 注册、分层解析（默认值 → 组合 `base` → 用户文档）、owner scope、热提交 |
| [credentials.md](credentials.zh.md) | 凭据 seam：配置中的 `CredentialRef` 引用（绝不含值）、按操作解析、对 UI 安全的 `CredentialInfo`、提供方来源层 |
| [session-query.md](session-query.zh.md) | 逻辑记录、有界精确事件读取、关系追踪、语义筛选器/文档与全文检索结果页 |
| [feedback.md](feedback.zh.md) | 绑定生命周期的逐消息反馈记录、乐观版本、伴随记录持久化与 Host Remote 约定 |
| [session-title.md](session-title.zh.md) | 持久标题快照、被引用的来源消息 seq 与异步提供方约定 |
| [session-reference.md](session-reference.zh.md) | 结构化跨会话引用：`SessionReferenceInput`/`Candidate`、prepared 消息上下文、稳定错误分类 |
| [system-prompt.md](system-prompt.zh.md) | 逐次组装的上下文、工具提供方结果、提示词段落与协作式组装 |
| [tools.md](tools.zh.md) | `ToolDefinition` 完整字段、schema DSL、`ToolExecution`/`ToolResult`、工具展示 UI 类型，以及受保护的执行流水线 |
| [mcp.md](mcp.zh.md) | 外部 MCP 连接、作用域工具与资源、服务器指令、协议结果与配置归属 |
| [user-questions.md](user-questions.zh.md) | UI 支持的人工问答 seam：`AskUserQuestionRequest`、answer/options 词汇、提供方 API、错误分类体系 |
| [approval.md](approval.zh.md) | 一次性用户审批 seam：`ApprovalRequest`、`ApprovalOutcome`、逐会话策略、审计事件和 answerer 约定 |
| [attachment.md](attachment.zh.md) | 持久图片标识与元数据、校验输入、经校验读取，以及 `AttachmentStore` seam |
| [shell.md](shell.zh.md) | shell 执行器 seam：`ShellExecRequest`/`Spec`、`ShellRunResult`、后台 `ShellProcess` 句柄 |
| [subprocess.md](subprocess.zh.md) | 子进程 seam：完全显式的 `SubprocessSpawnSpec`、基于偏移的输出读取器、不含分类的 `SubprocessOutcome`，以及受管 `DSH_*` 环境词汇 |
| [ssh.md](ssh.zh.md) | POSIX SSH 连接与远程文件系统、子进程和沙箱提供方 |
| [terminal.md](terminal.zh.md) | 持久化终端 ID、后端/会话约定、发送就绪状态、有界读取与 owner 可见快照 |
| [sandbox.md](sandbox.zh.md) | 每会话策略解析与进程约束 seam：文件效果模式、执行/提供方策略、`ConfinedArgv`、强制执行与故障关闭错误 |
| [ptc-runtime.md](ptc-runtime.zh.md) | PTC 执行 seam：`PtcRunRequest`/`Result`、绑定命名空间、捕获日志、`PtcRunFailure` 分类体系 |
| [computer-use.md](computer-use.zh.md) | 按名称独占注册计算机操作提供方，以及 Cua Driver 集成选项 |
| [browser-use.md](browser-use.zh.md) | 按名称独占注册浏览器操作提供方、提供方选项与按 Session 管理的浏览器所有权 |
| [extensions.md](extensions.zh.md) | 带版本的动态 Cordis 插件与包、Host/Client 激活、审批、运行时检查和生命周期清理 |
| [filesystem.md](filesystem.zh.md) | 文件系统 seam：`FsTarget`、读/写/编辑结果、观测到的文件状态、`FsErrorCode` |
| [lsp.md](lsp.zh.md) | LSP 导航 seam：`LspQueryRequest`/`Result`、`LspProvider`/`Service`、四种操作、`LspError` |
| [skills.md](skills.zh.md) | skill（技能）服务：发现优先级、`SkillSummary`/`SkillDefinition`、会话前缀目录、面向模型的 `skill` 加载 |
| [compaction.md](compaction.zh.md) | 压缩（compaction）seam：`compaction/*` 会话事件、`CompactionResult`、`CompactionEngine` 接口 |
| [subagent.md](subagent.zh.md) | subagent seam：命名提供方注册表、`SubagentStartRequest`/`Result`/`Run`、启动时与运行时能力拆分 |
| [agent-team.md](agent-team.zh.md) | Agent Teams：隐式 Lead 身份、具名 continuable teammate、持久 peer mailbox 与共享任务 DAG |
| [web.md](web.zh.md) | Web 访问 seam：`WebSearchRequest`/`Result`、`WebFetchRequest`/`Result`、`WebFetchBody`、提供方可用性、`WebError` |
| [spill.md](spill.zh.md) | spill 存储 seam：`SaveTextSpill`、`SpillOwner`/`SpillSource`、`SpillRef`、品牌类型 `SpillLocator` |
| [workflow.md](workflow.zh.md) | 工作流 seam：`WorkflowStartRequest`、`WorkflowMeta`、`WorkflowRun`/`Result`、`workflow/*` 事件载荷、`WorkflowError` 致命性 |
| [jobs.md](jobs.zh.md) | 后台任务运行时：品牌化 `JobId`、producer 约定、消费方视图和 `ctx.jobs` 服务行为 |
| [permission-presets.md](permission-presets.zh.md) | 权限预设层：`PresetSpec`/`PresetOption`、派生的 `custom` 状态、仅记日志的 `permission/preset` 事件 |
| [plan.md](plan.zh.md) | 计划模式：仅记日志的 `plan/mode` 状态、待定选择的冲刷、`PlanModeConfig`、`exit_plan_mode` 审阅流程 |
| [invariants.md](invariants.zh.md) | 运行时不变式注册表：选择配置 `Config`、`InvariantInstaller`/`InvariantFailure`、空配套插件约定 |
| [web-server.md](web-server.zh.md) | HTTP 载体：`WebRouteKind`/`WebRoute`、匹配顺序、可认领的回退席位、index 渲染挂接点 |
| [webhook.md](webhook.zh.md) | 通过身份验证的提供方交付、任意程序化规则，以及发起 Workspace 会话创建后不等待结果 |
| [storage.md](storage.zh.md) | 存储子系统：后端约定（`StorageBackend`）、`StorageForms`、`DomainSpec`/`Domain`、`domain/changed` |
| [workspace.md](workspace.zh.md) | 工作区注册表：`Workspace`/`WorkspaceId`、注册与解析、与会话 `cwd` 的关系 |
| [web-client.md](web-client.zh.md) | 浏览器架构：启动、Remote 通信、配对的 Client model、UI 适配器、Conversation 组装、slot 与重连语义 |
| [client-modules.md](client-modules.zh.md) | Web 插件表：`dsh.client` 声明、`WebBootGraph` 协议格式组合、bundle 路由与 index 挂接点 |
| [slots.md](slots.zh.md) | 类型化 Web UI 组合：声明所有权、cardinality 与 scope、框架与功能注入、props 推导及已交付的层级结构 |
| [client-resources.md](client-resources.zh.md) | 客户端资源模型：`dsh-resource://<type>/…` 地址、协议提供方与 `ResourceProtocolMap`、`useResource` 全局钩子及其状态、钉住与释放 |
| [sidebar-right.md](sidebar-right.zh.md) | 右侧 Sidebar：资源地址与导航地址、tab 类型注册与路由、`ctx.sidebarRight` 导航服务、pane-tab slot 与 owner props、资源模型及 Workspace Files 服务 |
| [conversation.md](conversation.zh.md) | 目标无关的会话事件组装：上下文标识、位置数据、回放路径、视图构建器与目标自有的渲染节点 |
| [session-projection.md](session-projection.zh.md) | 投影 seam：`SessionProjectionMap`、纯函数 `ProjectionDefinition` 单元、`ProjectionSnapshot` 的一致切面、变更馈送 |
| [session-telemetry.md](session-telemetry.zh.md) | 对外会话上报能力 seam：`SessionTelemetryRecord`/`SessionTelemetrySeverity`、`SessionTelemetrySink` 约定和 `session-telemetry/record` 脱敏 waterfall（瀑布式事件） |

> 这些页面上的类型声明及其 JSDoc 与源码等价，并由 `pnpm run verify-type-equiv` 检查漂移（见 [development.md](../development.zh.md#documenting-types-verbatim-ts-type-equiv)）。普通块保留完整声明；`public-api` 块保留去除实现体的公开 class 声明。Cordis 服务与事件使用每页生成的 **Cordis API** 小节。
