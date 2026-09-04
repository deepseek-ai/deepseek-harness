# 实操手册：扩展插件形态

[English](extension-cookbook.md) | 中文

harness 扩展的参考模式。代码片段省略了 import 和辅助实现，无法直接复制运行。具体编写路径见[包检查清单](adding-a-package.zh.md)、[第一个工具教程](../user/develop/basic/tool.zh.md)、[工具参考](adding-a-tool.zh.md)和 [LLM（大语言模型）适配器指南](adding-an-llm-adapter.zh.md)；系统与扩展点映射由[架构文档](../architecture.zh.md)负责。

## 工具插件

工具在 `ctx.tools` 上注册。带注解的 `defineTool` 示例（类型化的 `execute` 参数、结果构造、`run_in_background` 模式）见 [adding-a-tool.md](adding-a-tool.zh.md)——该指南是工具定义的真源。`ctx.tools.register()` 也直接接受原始 JSON Schema `ToolDefinition`（MCP 来源的工具就是这样到达的）；`defineTool` 是第一方工具使用的类型化辅助函数。

<a id="a-hook-plugin-permission-gate-example"></a>

## 钩子插件（以权限门禁为例）

这个权限门禁是钩子插件的一个示例。它从 `tools/pre-execute` 门禁返回一个类型化的决策，用于允许或拒绝一次调用；沙箱、权限和 plan-mode 插件都可以使用该扩展点。钩子插件也可以拦截其他扩展点，本身并不等同于权限门禁。「原生钩子」是在拦截点上运行的普通 Cordis 插件，不需要外部协议。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

这个 waterfall（瀑布式事件）是可重排的策略层。当不变式需要单调的最终拒绝时使用 `ctx.tools.guard()`；当插件需要包裹分发生命周期时（超时/重试/指标；仅 `exec.signal` 可替换）使用 `tools/execute`；显式结果变换使用 `tools/post-execute`；对不可变最终结果的受限观察使用 `tools/result`。选择规则见[添加工具指南](adding-a-tool.zh.md#execution-policy-and-observation)。

## UI 插件

UI 插件把持久 `session/event` record（Assistant settlement、轮次/步骤边界与工具活动）和用于实时 token 呈现的瞬态 `agent/assistant-stream` frame 组合起来，并通过 `agent.followup()` / `agent.steer()` 将输入驱动回去。如果浏览器插件要向内建 Web Client 贡献业务行，则应注册 `ConversationNodeDefinition` 与 keyed Chat renderer；具体约定见 [Conversation 子系统参考](../subsystems/conversation.zh.md)。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      render(frame.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(brandString<SessionId>('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

## 外部协议驱动

*协议驱动*将协议对端接入 `ctx.agents`；它可以服务于 UI 或自动化客户端。stdio 驱动拥有 stdout，通过工厂创建或恢复 agent（智能体），并将协议请求映射为 `followup()` 或 `cancel()`。底层提示词请求返回其持久入队回执；它不会通过关联 `MessageId` 与 `turn/end` 获得结果。整个 agent 的状态应单独发布。自动化方法可以从回执等待到下一次 idle，并概括这一显式拥有的区间；UI 通常则会持续观察开放式事件流。通过 `AgentHandle.dispose()` 拆除 agent，以使 dispose（资源释放）达到完全停稳。

[`packages/acp/acp`](../../packages/acp/acp) 是仅面向自动化的完整示例：它通过 ACP（Agent Client Protocol）JSON-RPC stdio 提供全新文本会话，发出已提交的助手文本，并为其拥有的 agent 注册一次性机器权限应答器。其 [README](../../packages/acp/acp/README.zh.md) 定义确切的方法、事件顺序和生命周期约定。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'

export const name = 'my-protocol-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export function apply(ctx: Context) {
  // Publish every committed Assistant text delta to the client.
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const { chunk } of expandAssistantStream(event.data.stream)) {
        if (chunk.type === 'text-delta') {
          // sendToClient({ kind: 'message_chunk', text: chunk.text })
        }
      }
    }
  })
  // Inbound "prompt": create/resume an agent, feed it, and return its enqueue receipt.
  // Whole-agent status is a separate notification; no turn end belongs to this prompt.
  // Teardown reaches quiescence via AgentHandle.dispose() (stop + await exit).
}
```

## 可运行的组装示例

交付应用通过 `packages/bundle/*/cordis.patch.yml` 提供 profile 层，产品 `dsh` 启动器通过具名 profile 负责 Web、ACP、SDK 与一次性 headless 执行。可选的用户 overlay 位于 `apps/cli/config/examples/`；profile 集成测试位于 `apps/cli/tests/profiles/`，包专属 Loader 组合则留在对应包的测试目录中。

<a id="the-feature--mechanism-map"></a>

## 功能→机制映射

每个产品功能都映射到一个文档化扩展点上的监听器——微内核声明由此可验证（[微内核 Agent Note](../../.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.zh.md)）。没有任何一行修改循环本身。

`system-prompt/assemble` 是一个专家协作式的整体装配变换：其返回的装配结果具有权威性，因此监听器作者有责任保留活跃的 PTC mode 和结构化输出协议的贡献。对于需要在展示、查找和执行之间保持对齐的工具过滤，优先使用 `ctx.tools.restrict()`。

| 产品功能 | 插件机制 |
|---|---|
| 钩子系统（用户级 + 项目级） | `agent/session-start`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute` 和 `agent/turn-stopping` 上的监听器；waterfall 返回类型化决策，`agent/turn-stopping` 则可通过 steering（中途引导）触发下一步；`dsh-hooks-claude-code` / `dsh-hooks-codex` 桥接器将钩子配置文件映射到这些扩展点上 |
| `/goal` | `ctx.goals` 管理持久状态，`dsh-goal-round-driver` 通过公共 `Agent` 调度同会话 Round，独立的命令/工具生产方分别提供人类/模型控制 |
| `/loop` | 在 `turn/end` 会话事件上 `followup()` 下一次迭代；或强制继续 |
| 动态工作流 | `ctx.workflowEngine` + worker-thread 引擎 + `workflow` 工具；结构化的进程内子任务通过作用域化的提示词/工具注册、单调工具守卫、最终 `tools/result` 提交（包括外层 `run_code`）和结构化输出执行的单调 `concludeTurn()` 标记来强制输出 |
| 排队消息 + steering | 核心 `Agent.followup()` / `Agent.steer()` |
| 上下文压缩（context compaction）（自动 + 手动） | `ctx.compaction` seam + `dsh-compaction-basic`；自动压力检查运行在串行 `agent/pre-step`，标准的溢出恢复机制运行在 `agent/request-error`，手动调用方使用同一个压缩服务（[压缩 Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md)） |
| 系统提示词可配置性 | `ctx.systemPrompt.section()`，支持排序与作用域局部覆盖 |
| AGENTS.md（根目录） | 一个读取该文件的 section 提供方 |
| AGENTS.md（子目录，按需触发）+ 文件变更通知 | 从 watcher / 工具结果监听器调用 `agent.inject()` |
| 内置工具 | `ctx.tools.register()`；schema 自动流入装配——`dsh-tool-*` 系列（bash、fs、web、subagent、todo）是已交付的示例 |
| ToolSearch / 渐进式披露 | 当可见集变化时替换一个作用域化的 `ctx.tools.restrict()` 注册；注册表保持展示、查找和执行三者对齐 |
| 工具截止时间 / 重试 / 指标 | 用 `tools/execute` 包裹核心分发；包装层可替换 `exec.signal`、委托执行，并在同一词法生命周期内检视规范化结果 |
| 最终工具结果指标 / 审计 / 捕获 | 用 `tools/result` 观察不可变的权威结果；仅当插件需要变换结果或附加上下文时才使用 `tools/post-execute` |
| 单调终端轮次策略 | 从成功的终端工具调用 `ToolExecution.concludeTurn()`；同一响应中后续工具调用仍可由守卫阻止，循环在该步骤后停止 |
| 子进程沙箱（landlock / sandbox-exec） | 通过 `dsh-bash-sandbox` 使用 `ctx.sandbox` 后端；能力级别的拒绝使用 `tools/pre-execute` |
| 权限系统 / AskUserQuestion | 从 `tools/pre-execute` 返回 `ask` 并通过 `ctx.approval` 应答；为普通用户提问注册一个独立的面向模型的 ask 工具 |
| Plan mode | [`@deepseek-ai/dsh-plan-mode`](../../packages/plan/plan-mode/README.zh.md)：落日志的 `plan/mode` 状态、`plan:policy` 引导段、`/plan [message]` 入口、`/plan off` 直接退出，以及经用户评审的 `exit_plan_mode` 出口；强制约束留在独立的沙箱/审批轴上 |
| subagent 委派 | `ctx.subagents` 提供方注册表（`dsh-subagent-spawn-in-process`/`dsh-subagent-fork-in-process`/`dsh-subagent-acp`/`dsh-subagent-codex`/`dsh-subagent-claude-code`/`dsh-subagent-dsh-sdk`）+ `dsh-tool-subagent` 向模型暴露一个已配置的提供方 |
| MCP | 每个服务器一个插件：发现工具 → `ctx.tools.register()` |
| skill（技能） | section + 工具注册；调用时通过 `inject()` 注入 skill 内容 |
| 记忆 | section 提供方 + 工具 |
| 定时任务（cron） | 插件注册面向模型的调度工具；定时器触发 → 空闲时 `followup(…, {source: {kind: 'plugin', plugin: 'schedule'}})`／忙碌时 `inject()` 通知 |
| UI（GUI；CLI（命令行界面）输出 JSONL） | 监听 `agent/assistant-stream` 的实时 chunk，并监听 `session/event` 的持久 settlement、边界与工具活动；输入 → `followup()` |
| Web Client Chat 业务节点 | 注册 `ConversationNodeDefinition` 与 `conversation.chat.node` keyed renderer |
| 遥测 / 可回放 trace | `session/event` → JSONL；回放 = `sessions.create(id, { seed })` |
| 模型适配器 | 通过 `registerAdapter` 注册 `LlmAdapter` 子类（`dsh-llm-deepseek`、`dsh-llm-pi-ai`） |
| 插件热重载 | 每个注册都是一个 `ctx.effect` → 随仓库提供的 HMR（热模块替换）直接生效 |
