# Agent Note: Pi 扩展桥接

Status: proposed

[English](2026-10-03-pi-extensions-bridge.md) | 中文

## 问题

Pi 1.0.0 的扩展是进程内的 TypeScript 工厂函数 `(pi: ExtensionAPI) => void`。工厂函数订阅约四十个生命周期、上下文、工具与提供方事件，注册模型工具、斜杠命令、模型提供商与 MCP server，并通过 `ctx.ui` 与用户交互（[扩展指南](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md)、[API 类型](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/extensions/types.ts)）。该 API 已发布并被广泛使用：截至 2026 年 10 月，npm 上约有 11,000 个包带有 `pi-package` 关键字。

DSH 已为另外两个生态提供桥接：为 Claude Code 与 Codex 编写的 shell 钩子（[hooks 组](../../../../packages/experimental/README.zh.md)），以及 Claude Code mods（[兼容性页面](../../../../docs/subsystems/claude-code-mods.zh.md)）。Pi 的扩展 API 比两者都宽。它允许一个进程内模块改写单次请求的消息、编辑工具参数、追加自己的持久记录，并让已经结束的运行继续。用 DSH 扩展点提供这套 API 可以回答两个问题：为另一个 harness 编写的扩展有多少能原样运行，以及 DSH 的哪些核心机制比 Pi 窄。

## 提案

新增一个实验性桥接，加载未修改的 Pi 扩展源码，并用现有的 DSH 扩展点提供 Pi 的 `ExtensionAPI`。该桥接是一次能力演示：凡现有 DSH 机制能承载的行为，就让扩展原样运行；其余部分不提供，并在兼容性页面列出每一处差异。除扩展状态所需的受限插件记录（缺口表第 9 行）外，每项核心缺口都由单独的变更弥补。

### 包与组合

- `@deepseek-ai/dsh-experimental-pi-extensions` 是 Host 包，提供 `ctx.piExtensions`。`@deepseek-ai/dsh-experimental-client-ui-pi-extensions` 是 Web 包。两者都不是可选 bundle；与 Claude Code mods 桥接一样，由一个按需启用的 overlay 组合它们。
- cordis.yml 的一行指定一个扩展来源：一个文件、一个含 `index.ts` 或 `index.js` 的目录，或一个在 `package.json` 中列出 `pi.extensions` 的 Pi 包目录。该行同时携带扩展的 flag 值。行的顺序就是 Pi 的加载顺序，也是其 handler 的分发顺序。
- 桥接不扫描 `~/.pi` 或 `.pi`，不安装包，也不判定项目信任。Pi 包中的 skill、提示词模板与主题不会被加载。

### 加载与执行

- 桥接有自己的 loader 与事件分发器。`@earendil-works/pi-coding-agent` 不是依赖。
- 源码由 `jiti` 导入，因此 TypeScript 在已构建的安装中也能加载。loader 解析 Pi 提供给扩展的那些导入：`typebox` 与 `@earendil-works/pi-ai` 解析到桥接自己的依赖；`@earendil-works/pi-coding-agent` 解析到桥接的一个模块，它实现了不需要 Pi 运行时的辅助函数（`defineTool`、工具事件类型守卫、截断辅助函数、`withFileMutationQueue`、`getAgentDir`）；`@earendil-works/pi-tui` 在部署安装了该可选对等依赖（peer dependency）时解析到它。扩展导入了 loader 无法解析的模块时加载失败，错误信息会指出该模块。
- 与 mods 一样，扩展代码在 Host 进程中以进程的全部权限运行。
- 每个拥有进程内 Agent 的 Session 都有自己的运行时：每行的模块只求值一次，其工厂函数对每个 Session 运行一次，正如 Pi 为每个 Session 重新运行工厂函数。扩展保存在模块作用域的状态由 Host 进程中的所有 Session 共享；Pi 同样在一个进程的多个 Session 之间保留同一个模块实例，但同一时间只运行一个 Session。subagent 的 Session 有独立的运行时，处于 Pi 的 `print` 模式且 `hasUI: false`，因此 subagent 发起的工具调用与根 Agent 的调用经过同样的扩展 handler。

### 提供 API

| Pi API | DSH 机制 |
|---|---|
| `session_start`、`session_shutdown` | `agent/created`（在首个轮次之前等待完成）、`agent/disposed` |
| `input`（在 inbox 准入之后，见第 7 行）、`before_agent_start` | `system-prompt/assemble` 与 `agent/pre-step`：被认领的用户消息可被改写或丢弃，返回的 `systemPrompt` 替换该轮次已组装的提示词，返回的消息加入该步骤 |
| `tool_call` | `tools/pre-execute`：`block` 成为拒绝；handler 抛出异常时拒绝该调用 |
| `tool_result` | `tools/post-execute`：被替换的内容安装为结果内容 |
| `agent_before_settle` | `agent/turn-stopping`：返回的自定义条目被记录，带 `continue` 返回的消息被 steer 进该轮次 |
| `agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_end`、`tool_execution_start`、`tool_execution_end`、`model_select`、`session_info_changed`、`session_compact` | 会话事件与 `agent/status`，作为通知按顺序送达 |
| `registerTool`、`ctx.executeTool` | Agent 作用域的 `ctx.tools` 注册；嵌套调用走完整的工具管线；内置名称遵循下文的转换 |
| `registerCommand`、`getCommands` | Agent 作用域的 `ctx.commands` |
| `sendUserMessage`、`sendMessage` | `agent.followup()`、`agent.steer()`、`agent.inject()` |
| `appendEntry`、`setLabel`、工具 `details`、`ctx.sessionManager` | ignorable Session 记录与 `tool/result` 元数据，读回时还原为 Pi 条目 |
| `getActiveTools`、`setActiveTools`、`getAllTools` | `ctx.tools.schemas()`；`setActiveTools` 对全局工具使用作用域内的 `ctx.tools.restrict()`，并增删桥接自己在 Agent 作用域的注册，因为限制不会隐藏作用域内的工具 |
| `setModel`、`getThinkingLevel`、`setThinkingLevel` | `agent/request` 覆盖 |
| `exec` | `ctx.subprocess`，不经 shell 的 argv |
| `ctx.ui.select`、`confirm`、`input`、`editor` | `ctx.userQuestions` |
| `ctx.ui.notify`、`setStatus`、`setWidget`、`setTitle`、`setEditorText` | 由 Web 包渲染的 Remote 流 |
| `registerFlag`、`getFlag`、`events` | 行配置；每个 Session 运行时一个进程内事件总线 |

同一个 Session 的所有 Pi handler 都经过一个有序队列。通知不会越过更早的通知；`tool_call` 这类需要等待的钩子，在排在它之前的所有通知之后运行。这样就保持了 Pi 的等待式分发给 handler 的顺序。

Web 与 Desktop GUI 对扩展呈现为 Pi 的 `rpc` 模式且 `hasUI: true`；headless、SDK 与 ACP Session 呈现为 `print` 模式。扩展本来就处理这两种模式：`ctx.ui.custom()` 这类仅限终端的调用返回 Pi 的 `rpc` 模式所返回的值。

### Pi 视角下的内置工具调用

DSH 与 Pi 共有 `bash`、`read`、`edit`、`write` 与 `grep` 这些名称，但参数不同，而 Pi 的 `find` 是 DSH 的 `glob`。Pi 的安全类扩展会读取 `event.input.path` 或 `event.input.command`。因此，桥接把这六个工具的每次调用以 Pi 的名称和 Pi 的参数名呈现给 handler，由 DSH 调用转换而来。其他工具原样传递。有一项测试加载已注册的 DSH 工具 schema，在被映射的参数改名或被移除时失败，在工具新增了映射表尚未归类的参数时也失败。

反方向使用同一张映射表。`getActiveTools()` 与 `getAllTools()` 对这六个工具报告 Pi 名称，对其他工具报告 DSH 名称；`setActiveTools()` 接受同样的名称。`ctx.executeTool()` 收到 Pi 名称时，把参数转换为 DSH 调用；`edits` 中多于一项的 `edit` 调用会被拒绝，因为一次 DSH `edit` 调用只做一处替换。以 Pi 内置名称注册的扩展工具会替换该 Agent 中对应的 DSH 工具，正如它在 Pi 中替换 Pi 自己的工具（`find` 替换 `glob`）。

### 不提供的功能

- DSH 无法触发的事件：注册时接受，永不触发，并在扩展加载时的警告中列出名称。
- DSH 无法提供的 `pi` 或 `ctx` 成员：抛出指明该成员的错误。
- Pi 在哪里失败关闭，桥接也在哪里失败关闭。编辑 `event.input` 的 `tool_call` handler 会使该调用被拒绝并附带原因，否则已记录的调用会与实际执行的调用不一致。

### 扩展状态

Pi 扩展在 `session_start` 时根据自己此前写入的内容重建状态。桥接把这些状态保存在 Session 日志中，使其跟随 resume 与 fork：

- `appendEntry` 与 `setLabel` 写入类型以 `plugin:` 开头的 ignorable 记录。追加它们的是一项受限的核心操作，只能由实验性包调用。它们不是 `SessionEventMap` 成员，因此持久化目录及其类型历史不变。不带该桥接的构建在读取当前格式时保留并跳过它们，这是 [ignorable 事件决策](../../implemented/architecture/2026-08-30-retain-ignorable-external-session-events.zh.md)的要求。之后的格式迁移边以尽力而为的方式携带它们：能保留时以原名称保留，否则说明丢弃哪些；Alpha 历史格式迁移边则拒绝所有未知事件（[决策](../../implemented/architecture/2026-08-31-alpha-historical-unknown-event-refusal.zh.md)）。
- 工具的 `details` 保存为 `tool/result` 元数据，由工具的输出声明投影得出。
- `sendMessage` 的内容记录为普通的用户来源消息，扩展的内容保持不变。一条伴随的 ignorable 记录携带 `customType`、`display` 与 `details`。

### 比 Pi 窄的核心机制

按各自阻塞的 Pi API 数量排序，并列出跟踪每一项的 GitHub issue。第 1、3 行源自 DSH 的规则：请求由 Session 日志派生，而日志是线性的。其余各行是缺失的扩展点。

| # | 机制 | 被阻塞的 Pi API | DSH 现状 | Issue |
|---|---|---|---|---|
| 1 | 按请求改写模型输入 | `context`、`context_with_system`、`before_provider_request`、`prepareLoadout` 隐藏声明 | 循环从日志派生每个请求并将其冻结；`llm/stream` 监听器只读取它。改写需要一个可等待的钩子，以及一个每个日志读取方都会应用到该请求上的核心事件。 | #5661 |
| 2 | 改写工具参数 | 编辑 `event.input` 的 `tool_call` | `PreToolDecision` 不包含输入改写（[提案](2026-06-30-pre-tool-input-rewrite.zh.md)）。 | #5662 |
| 3 | Session 树与 assistant 消息替换 | `navigateTree`、`session_before_tree`、`session_tree`、`message_end` 替换 | 日志是线性的，fork 会创建新的 Session，`assistant/message` 不能替换另一条。 | #5663 |
| 4 | 可等待的步骤结束钩子与提交前钩子 | `turn_end` 的条目与 `continue`、`message_end` | `step/end` 与 `assistant/message` 是已提交的事件；会话事件监听器不能追加事件。 | #5664 |
| 5 | 工具进度与结果替换 | `onUpdate`、`tool_execution_update`、把错误变为成功的 `tool_result`、工具 `usage` | `ToolRunContext` 没有进度通道，`tools/post-execute` 不能替换失败结果的值。 | #5665 |
| 6 | 按工具设置可见性 | `codemode`、`deferred` 与 `hidden` exposure | 呈现方式按 Agent 选择，模型看不到的工具拒绝执行。 | #5666 |
| 7 | 输入准入 | 在提示词被保存之前的 `input` | 提示词在 `agent/pre-step` 之前就已持久保存在 inbox 中；被吞掉的提示词会留下一个没有步骤的轮次。 | #5667 |
| 8 | 插件发起且被记录的模型调用 | `ctx.modelRegistry.complete`、`stream`、`streamSimple` | 没有会话事件记录插件自己的模型请求，这同样阻塞了 mods 的 `$.model.complete`。 | #5668 |
| 9 | 插件拥有的持久记录 | `appendEntry` | `Session.append()` 只接受已声明的事件类型。受限的 `plugin:` 记录为实验性包补上了这一点。 | #5669 |
| 10 | 定制压缩 | `session_before_compact` | 摘要由唯一的 `CompactionEngine` 负责，`/compact` 不接受指令。 | #5670 |
| 11 | 生命周期原因 | `session_start` 的 `new`、`fork` 与 `reload` 原因；`session_shutdown` 的原因 | `agent/created` 报告 `startup` 或 `resume`；`SessionStartSource` 还声明了尚无生产者的 `clear` 与 `compact`；`agent/disposed` 不带原因。 | #5671 |
| 12 | Host 插件在 GUI 中的显示 | `ctx.ui.notify`、`setStatus`、`setWidget` | 没有共享机制；每个桥接各自附带 Client 包。 | #5672 |
| 13 | 命令能力 | 参数补全；把用户带到另一个 Session 的 `newSession`、`fork` 与 `switchSession` | `ctx.commands` 接受非结构化文本，没有 Client 侧效果。 | #5673 |
| 14 | 提供方请求钩子 | `before_provider_headers`、`after_provider_response`、`provider_stream_event` | 请求头、响应与原始流事件都留在各适配器内部。 | #5674 |
| 15 | 故障隔离 | 扩展的缺陷只中止一个 Pi 进程 | Host 中未捕获的异常会为所有 Session 释放整个应用。 | #5675 |

终端渲染（`ctx.ui.custom`、自定义编辑器、渲染器、快捷键）不在此列：DSH 的 GUI 不是终端，Pi 自己的 `rpc` 模式也不提供这些。

## 考虑过的替代方案

**依赖 `@earendil-works/pi-coding-agent` 并复用其 loader 与 runner。** 这样可以精确复现 Pi 的 handler 顺序与错误规则，并提供扩展导入的全部辅助函数。否决的原因是：这项工作要用 DSH 的机制承载 Pi 的 API，而不是嵌入 Pi 的 harness。该 runner 构造于 Pi 的 `SessionManager` 与 `ModelRegistry` 之上，这个包会带入 Pi 的全部依赖闭包，而且它的内置工具工厂会在 DSH 的文件系统与沙箱策略之外运行 Pi 自己的文件与 shell 实现。

**像 `defineMod` 那样为每个扩展写一个包装模块。** Pi 扩展本身就是默认导出的工厂函数，没有需要替代的 manifest，因此包装只会给每个扩展多加一步，并且无法直接加载已发布的 Pi 包目录。

**自动发现 Pi 自己的位置。** 加载 `~/.pi/agent/extensions` 与项目的 `.pi/extensions` 会执行 DSH 用户并未组合进来的代码，这需要 DSH 尚不具备的项目信任判定。mods 桥接出于同样的组合原因移除了它的目录 loader。发现机制可以作为之后按需启用的一层。

**为每个 Session 在独立进程中运行扩展。** 这样未捕获的扩展错误会以事件的形式到达 Host。但每个需要等待的钩子都会变成一次跨进程往返，Pi 的就地编辑事件对象也必须通过回传变更来复现。待真实扩展表明确实需要这种隔离时再做。

**为每个 Session 各求值一次扩展模块。** 这样并发的 Session 不会共享模块作用域的状态。否决的原因是：Pi 在一个进程的多个 Session 之间保留同一个模块实例，扩展可能依赖模块状态在切换 Session 后仍然存在；而且按 Session 求值会为每个 Session 与 subagent 重复转译。

**只为根 Session 运行扩展。** 这需要显式过滤，因为 `agent/created` 对每个 Agent 都会触发；它还会让 subagent 的工具调用绕过 Pi 的安全类扩展。

**把 DSH 的工具名称与参数原样传给 handler。** Pi 自己的 `protected-paths` 示例读取 `event.input.path`；遇到 DSH 的 `file_path` 时它会抛出异常，而写法稍有不同的 handler 会放行这次写入。

**声明 `pi/*` 会话事件与 `pi-extension` 消息来源。** 归属是正确的，但两者都是读取时必需的持久化类型：目录与类型历史会改变，没有该桥接的构建会拒绝这个 Session。

**把扩展状态保存在日志之外的 storage domain 中。** 状态不会跟随 fork，`ctx.sessionManager.getBranch()` 也看不到扩展写入的内容。

**触发 `context` 与 `before_provider_request` 但不记录其效果。** 模型会看到 Session 日志无法重建的输入。

**拒绝加载订阅了不提供的事件的扩展。** 多数扩展同时使用多项功能；mods 桥接已经采用“发出警告并让其余部分继续工作”的做法。

**先构建共享的 GUI 通知机制。** 它也能服务 mods 桥接，但属于核心新增；在它出现之前，本桥接的 Web 包渲染自己的流。

## 验收标准

- Pi 以 MIT 许可发布的示例扩展原样提交为 fixture，且只提交有测试覆盖的那些。在使用 mock 模型的真实 agent loop 中：权限扩展拒绝一次工具调用，模型看到原因；模型调用扩展工具，其 `details` 在恢复的 Session 中仍然存在；扩展命令可以运行；扩展替换某个轮次的系统提示词；resume 之后，`appendEntry` 的状态在 `session_start` 时被重建。
- subagent 的工具调用到达它自己运行时的 handler。
- 被映射的 DSH 工具参数变化时，工具转换测试失败。
- Loader 组合测试从 cordis.yml 启动桥接，释放测试表明桥接卸载时每项注册都被移除。
- 一个录制的 Session 快照覆盖一次被扩展拒绝的工具调用和一次扩展工具调用。
- `docs/subsystems/pi-extensions.md` 列出每个事件与成员及其状态，以及每一处行为差异。
- 新包的 `src/` 覆盖率为 100%，`doc-sync` 通过。

## 风险

- 扩展代码拥有 Host 的全部权限，一个未捕获的错误会中止所有 Session。只挂载你愿意作为插件运行的扩展。
- 保真度取决于桥接对 Pi 1.0.0 分发规则的理解；它经过 Pi 示例的检验，但没有在 Pi 的代码上执行。之后的 Pi 版本可能改变桥接所提供的事件或辅助函数。
- 扩展导入了桥接未实现的辅助函数时会加载失败，即使它只在某一条代码路径上用到该函数。
- 无法携带插件记录的未来 Session 格式迁移边，会使迁移之前写入的 Session 丢失扩展状态。
- 把按 Session 区分的状态放在模块作用域的扩展，会混用并发 Session（包括 subagent）的状态。
- 扩展发送的消息，在读取伴随记录的 Web 包之外的所有地方，都归属于用户。
