# Agent Note: subagent 能力 seam

Status: implemented

[English](2026-06-21-subagent-capability-seam.md) | 中文

> 完整 seam 已交付：`dsh-subagent` 接口与 `dsh-tool-subagent` 消费方；两个进程内后端（`dsh-subagent-spawn-in-process`、`dsh-subagent-fork-in-process`）；嵌套 agent（智能体）快照基础设施（[逐会话快照回放](../../archived/testing/2026-06-22-subagent-snapshot-replay.md)）；以及进程外的 ACP（Agent Client Protocol）、Codex 与 Claude Code 后端（[ACP Agent Note](../../archived/feature/2026-06-22-acp-subagent-backend.md)、[产品提供方 Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)）。

## 问题

harness 有一个长期搁置的 seam 用于 **subagent**：一个 agent 将工作委派给另一个 agent。这一意图在 `Agent`/`AgentLoop` 接口中已有草案（[packages/core/agent/src/types.ts](../../../../packages/core/agent/src/types.ts)、[packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)）：一个创建选项引用父 agent（fork = 用父会话的事件日志初始化子会话；spawn = 全新会话），子 agent 以 `Agent` 句柄返回，使 steering（中途引导）和事件订阅可以统一工作。

**多种 subagent 实现必须在运行时共存。**一个父 agent 可能在同一个会话中既需要一个廉价的进程内子 agent 处理有限范围的子任务，又需要一个隔离的进程外子 agent（通过 ACP）。传输方式：

- **进程内**：在同一个 `Context` 上创建一个具体的子 `Agent`（最廉价，且鉴于现有 agent 工厂几乎零成本）；
- **ACP**：作为 ACP *客户端*驱动另一个 agent 进程（可以是自身的另一个实例）；
- **Codex app-server 与 Claude Code Agent SDK**：当前的一次性同类提供方，将同一个命名提供方约定应用于官方产品进程（[产品提供方 Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)）；
- 后续：**A2A**，采用同样的进程外形态：「启动子 agent、发送提示词、结算、取消」。

## 曾考虑的替代方案

### 为何不采用 bash seam 的形状

bash seam（[能力 seam](../architecture/2026-06-13-capability-seams.zh.md)）在每个上下文中只注册恰好一个 `ShellExecutor`；加载第二个会抛异常。这对 bash 是正确的（一台机器、一种执行命令的方式），但对这里是错误的：共存才是需求。因此 subagent 服务是一个**命名提供方注册表**——每个实现以唯一名称注册，调用方按名称选择——镜像 **LLM（大语言模型）适配器注册表**（`LlmRuntime.registerAdapter`），而非单服务的 bash 执行器。seam 仍然是由三类包构成的结构（Service Definition / Service Provider / Consumer）；只是「一个 vs. 多个实现」这个维度不同。

## 决策

### 由三类包构成的边界

新建包组 `packages/subagent/`：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 接口：`SubagentRuntime`（`ctx.subagents`）、`SubagentProvider`、`SubagentRun`、请求、结果、能力词汇、`subagent/*` 事件 |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 实现：通过 `ctx.agents.create` 创建全新的进程内子 agent |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 实现：用父 agent 日志快照初始化的进程内子 agent |
| `@deepseek-ai/dsh-subagent-acp` | 实现：作为 ACP 客户端驱动已配置的子进程 |
| `@deepseek-ai/dsh-subagent-codex` | 实现：一次性官方 Codex app-server 进程 |
| `@deepseek-ai/dsh-subagent-claude-code` | 实现：通过 Agent SDK 运行的一次性官方 Claude Code 进程 |
| `@deepseek-ai/dsh-tool-subagent` | 消费方：基于 `ctx.subagents` 的面向模型的 `subagent` 工具 |

### 原语：异步 `start → SubagentRun`

提供方暴露 `start(request) → Promise<SubagentRun>`。完成时发布一个子 agent，并将其运行句柄转交给调用方。发布前失败的工作会拒绝 `start()`，而发布后的提示词、轮次、取消与基础设施结果会通过 `run.result` 结算，且不会隐藏 child id。同一个信号覆盖发布前后的取消；`dispose()`（资源释放）取消剩余工作并等待完全停稳。启动被拒绝时会清理未发布资源，且不发出生命周期事件；发布后的结果失败则会结束已经发布的生命周期事件对。`start` 与传输方式无关；`spawn` 仅指代全新的进程内后端。

### 两类可选能力，两种发现方式

- **启动时功能**（`agentOptions`、`outputSchema`、`depthLimit`、`toolFilter`、`persona`）挂在静态的 `provider.capabilities` 描述符上。服务在委派之前检查每个被请求的功能，如果提供方不支持则**响亮拒绝**（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不接受后静默忽略。这些功能必须在 run 存在之前检查，因此不能是运行时方法。
- **可继续创建**使用可选的 `SubagentProvider.prepareContinuable` 方法；方法是否存在本身即为能力，TypeScript 类型收窄即为发现机制，因此不需要可能与实现失同步的独立 flag。继续执行管理器直接通过 `AgentHandle` 负责后续投递与冷恢复，而一次性 `SubagentRun` 没有 steering 或 resume 操作，具体由[可继续 subagent](2026-07-28-continuable-subagent-conversations.zh.md) 细化。

### Fork 与 fresh 是独立后端，而非一个 flag

全新子 agent 与 fork 子 agent 是独立的提供方，而非请求中的一个 flag。`dsh-subagent-spawn-in-process` 启动隔离的子 agent；`dsh-subagent-fork-in-process` 用一个平衡前缀初始化子 agent，该前缀仅包含已完成的父轮次。进行中的轮次被排除，因为其 subagent 调用尚无结果，无法构成有效的回放历史。

### 子 agent 隔离与父日志

每个进程内 subagent 运行在**自己的 `Session`** 中（独立 id、`parentSession` 谱系），独立持久化。远端 ACP 和一次性产品提供方则会生成一个父级作用域的生命周期 id，且不暴露本地 `Agent` 或子 `Session`；其内部状态留在远端进程中。两种形式下，父日志都仅记录 spawn `tool/call` 及其 `tool/result`（子 agent 的最终输出，或带可选提供方诊断的失败结果），而子 agent 的步骤和工具调用均留在父日志之外。

### 同步收集（首版）

`dsh-tool-subagent` 将其执行信号传给 `start()`，等待子 agent 结果，并在报告前 dispose 该 run。非完成态的结果变为错误结果，而非成功的部分输出；它会把由[非交互权限决策](2026-08-15-product-subagent-noninteractive-permissions.zh.md)负责的可选安全诊断与部分 assistant 文本分开呈现。结果与 dispose 的拒绝仍可彼此独立地观察。

### 传输提供方选择是配置，不面向模型

`dsh-tool-subagent` 绑定到恰好一个 subagent 传输提供方名称（`Config.provider`）。若要暴露多种传输方式，请多次加载该工具插件，每次绑定不同的提供方和不同的 `toolName`（工具注册表拒绝重名）。*服务*持有多提供方注册表；*工具*选择其中一个——schema 中没有 subagent 传输/type 参数。后续 opt-in 增加了子 agent LLM 提供方/模型字段，但没有改变这项传输决策；见[模型选择的 subagent 路由](2026-08-18-model-selected-subagent-routes.zh.md)。

## 测试

注册表与工具测试仅用包内脚本化提供方替换非确定性的子 agent，同时测试真实的 `SubagentRuntime`、生命周期、任务集成和面向模型的工具。loader 回归测试仍覆盖提供方与消费方的 export，以防止[事故复盘（postmortem）0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md) 中描述的失败。注册表测试覆盖重载安全性、重名和启动时能力拒绝；嵌套 agent 场景通过[逐会话快照回放](../../archived/testing/2026-06-22-subagent-snapshot-replay.md)进行无密钥回放；进程内后端还有真实循环的单元测试和带密钥的 e2e 测试。

## 后果

- **递归。** 如果不设限制，进程内子 agent 能看到委派工具并递归调用。进程内后端实现了可选的绝对深度限制和有作用域的实时全局 `toolFilter`；ACP 声明这两项能力为关闭状态，并拒绝此类请求。[subagent 组合控制 Agent Note](2026-07-12-subagent-persona-tool-filter-and-depth.zh.md) 负责定义它们的确切语义和安全边界。
- **阻塞父轮次。** 前台收集在子 agent 的整个持续时间内保持父 agent 的步骤打开。后台委派使用共享的 `ctx.jobs` 运行时与通用 `job_*` 工具，与后台 bash 共用同一套收集机制；subagent seam 本身仍不感知任务。
- **实时进度。** 仅暴露生命周期事件与最终结果；逐分片的子→父更新流推迟到后台重新设计时一并处理。
- **ACP 客户端接口。** 将 ACP 子 agent 的 `fs`/`terminal` 代理回父 agent（共享工作区模式）是后续工作；该后端不声明这两项能力，子 agent 在自己的进程中自行服务。
