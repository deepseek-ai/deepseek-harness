# Agent Note: ACP subagent 后端（进程外委派）

Status: implemented
Archived: 2026-09-04

[English](2026-06-22-acp-subagent-backend.md) | 中文

## 问题

subagent seam（[seam Agent Note](2026-06-21-subagent-capability-seam.zh.md)）的设计使多个后端可以按名称共存于 `ctx.subagents`。进程内后端（`-spawn`/`-fork`）将子 agent（智能体）作为第二个 `Agent` 运行在同一个 Cordis 上下文中：开销低，但子 agent 与父 agent 共享进程、模型客户端和工具。seam 的核心意义在于同时支持通过协议到达的进程外子 agent，以证明该抽象可跨进程边界适用。本 Agent Note 添加第一个此类后端：一个 ACP（Agent Client Protocol）客户端。

## 决策

`@deepseek-ai/dsh-subagent-acp` 注册一个 `SubagentProvider`，将每个子 agent 运行在一个通过 spawn 启动的子进程中，并以 ACP *客户端*身份驱动它。它是现有服务端桥接 `@deepseek-ai/dsh-acp`（ACP *agent*）的方向反转孪生体：桥接应答 `initialize`/`newSession`/`prompt`；本后端调用它们并实现 `Client` 回调（`sessionUpdate`、`requestPermission`）。将配置的 spawn 命令指向 `acp-agent` 示例，即可让 harness 与自身进程通信。

### 每次运行启动全新进程

每次 `start` 都 spawn 一个新的子进程，运行恰好一个 ACP 会话（`initialize` → `newSession` → `prompt`），`dispose` 杀死子进程并等待其退出。这是最简单的生命周期，与进程内「每次运行一个子 agent」的形态一致。

### 最小化客户端桩

客户端不声明任何可选能力（无 `fs`、无 `terminal`）：子 agent 在自己的进程中自行处理文件/终端访问。`session/update` 通知被消费：后端将 `agent_message_chunk` 文本累积为结果输出，忽略其余内容（思考、工具调用卡片），因此仅暴露子 agent 的最终回答。`session/request_permission` 由配置的策略自动应答（`reject` 拒绝所有提示，`allow` 通过第一个表示允许的选项批准）——不向人类暴露任何权限提示。将 `fs`/`terminal` 代理回父进程（共享工作区模式）仍为后续工作，如 seam Agent Note 所述。

### 无启动时能力

提供方的 `capabilities` 全部为 `false`。进程外子 agent 无法遵守父 agent 的 `maxDepth`（它无权访问 `parent.options.subagentDepth`）或 `toolFilter`（它拥有自己的工具注册表），本阶段也未实现 `outputSchema`。如果请求需要其中任何一项，服务在 `start` 运行前即拒绝。后端仅注入 `subagents`（而非 `ctx.agents`）；它从 `request.parent` 读取的唯一内容是会话 header 的 cwd（见下方工作区解析）——对话上下文、深度和工具状态都不会跨越进程边界。

### 工作区 cwd 解析

子进程工作目录来自显式解析，绝不使用 harness 进程的 cwd：若已配置部署 `cwd` 覆盖，则相对于启动目录将其转为绝对路径并在加载时验证；否则使用父会话 header 的 cwd 并在启动时验证；如果两者都不存在，则在 spawn 任何进程前响亮拒绝。一个 ACP 服务端进程会服务来自多个工作区的会话，因此 `process.cwd()` 不能代替会话工作区——旧的隐式回退会让子进程在服务端启动目录中运行。候选路径必须是 harness 可以进入的绝对目录（要求 `X_OK`；仅 `statSync().isDirectory()` 会接受 mode-600 的目录，而 spawn 会因 EACCES 失败）；解析出的同一路径同时用作子进程 cwd 与 ACP `session/new` 工作区。

### StopReason 映射

ACP `StopReason` → harness `SubagentStopReason`：`end_turn`→`completed`、`max_tokens`→`max-tokens`、`refusal`→`refusal`、`cancelled`→`aborted`、`max_turn_requests`→`error`（无对等语义，任务未完成）、未知→`error`。spawn、initialize 与会话创建失败会在提供方自有清理后、发布前拒绝 `start()`；发布后的 prompt/RPC/传输失败会把 `result` 确定为 `error`（本地取消后为 `aborted`），而 `result` 在子 agent 级别失败时绝不 reject。非完成结果与生命周期失败只会附加[进程外诊断决策](2026-08-21-out-of-process-subagent-minimal-diagnostics.zh.md)定义的有界 provider stage、粗粒度 category、闭集权限决定和已观测进程事实；原始 ACP 错误与 stderr 仍只留在 Host。

### 安全：清洗子进程环境

子 agent 是独立进程，因此会继承环境变量。形如凭证的环境变量（`/KEY|PASSWORD|SECRET|TOKEN/i`）默认不转发——父 harness 自身的密钥不得隐式泄露到 spawn 启动的进程中（与 bash 执行器采用的策略相同）。子 agent 自己的凭证（它需要模型密钥）通过 `config.env` 显式提供，在清洗之后叠加，因此有意传入的 `DEEPSEEK_API_KEY` 得以保留，而偶然存在的 `AWS_SECRET_ACCESS_KEY` 则不会。子进程的 stderr 继承到父进程的 stderr（诊断信息自然浮现）；spawn 级别的 `error` 事件（如命令不存在时的 ENOENT）被捕获并与 ACP 驱动竞速，因此错误命令的结果为 `error` 而非以未处理错误崩溃父进程。

## 测试

- **无需密钥的单元/集成测试：** 一个脚本化的 ACP 子进程通过真实 stdio 测试提示词输入／输出流程、所有 stop-reason 映射、信号与 dispose 取消（包括 pre-abort、会话前竞态和管道断裂场景）、两种权限策略、被忽略的非消息更新、命令缺失时的清理、提供方重载以及命名空间导出。
- **无需密钥的 Loader 组合测试：** 仅用于测试的 cordis.yml 通过真实 Loader 启动 stdio 应用，并省略后端的 `cwd`；脚本化模型委派一次，脚本化子进程则证明它在父会话工作区中运行，且 ACP 也对外公布了该工作区，从而端到端覆盖 cwd 继承分支。
- **需要密钥的 e2e 测试：** 后端 spawn 真实的 ACP 示例；其模型回答 `PONG`，写入 `proof.txt`，父进程验证该文件。
- **无密钥快照：** ACP 示例通过 Loader 支持的回放启动真实提供方与脚本化子进程，固定前台和一次性后台诊断，同时保持子进程、权限决定、部分输出与清理生命周期确定。
- **快照缺口：** 每个 ACP 子 agent 仍拥有自己的回放会话；`TODO(acp-subagent-replay)` 继续跟踪父进程对回放中子 harness 的回放，而不是诊断场景使用的脚本化协议子进程。

## 曾考虑的替代方案

### 为何继续使用 SDK 0.25.1？

后端只需要 `ClientSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION` 和客户端协议类型，0.25.1 全部支持。0.28 的 fluent API 需要在 ACP 层同时迁移客户端和服务端连接类，却不会改善本后端，因此升级作为独立变更保留。

### 为何不使用持久子进程？

持久进程池（跨运行复用热子进程）是一项性能优化，推迟到后续工作。它增加了会话生命周期和崩溃恢复的复杂度，本阶段不需要；每次 `start` spawn 全新子进程与进程内「每次运行一个子 agent」的形态一致。

## 后果

每次运行都要付出一个全新子进程的代价（spawn + `initialize` + `newSession`）。父进程仅暴露子 agent 的最终回答：`session/update` 中的思考和工具调用卡片被消费后丢弃，权限提示从不到达人类——由配置的策略应答。子进程环境默认经过凭证清洗，因此其自身的模型密钥需通过 `config.env` 显式提供。

## 兄弟产品提供方

[Codex app-server 与 Claude Code Agent SDK 提供方](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)作为按名称注册的兄弟提供方，采用同样的进程外启动/提示词/结算/取消边界。A2A 仍是未来的兄弟传输方式；ACP 后端证明了 subagent seam 能够支持这项边界，而无需负责产品私有协议。
