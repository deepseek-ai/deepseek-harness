# DeepSeek Harness 架构

[English](architecture.md) | 中文

改动 `packages/` 下的任何内容之前，请先阅读本文。本文假定你已了解 Cordis；如果尚未了解，请先阅读[入门](cordis-primer.zh.md)或[教程](cordis-tutorial/index.zh.md)。

建议使用 agent（智能体）探索代码库并理解其架构。

## Cordis

[Cordis](cordis-primer.zh.md) 是 dsh 底层的框架：插件向共享上下文贡献服务、类型化事件和可逆的副作用。产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop（智能体循环）本身，因此每个都可以从配置替换。

不存在需要打补丁的特权内核：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。

## Profile 与组合包

运行中的 `dsh` 是一棵插件树，由启动时按序叠加的各层组合而成。

**profile** 是存放在 Harness home 中的具名组装。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` 作为模板随发行版交付。

**组合包**是 Cordis 配置项及其挂载代码的分发格式，因此它插入的内容始终可被其上各层 patch。

两者都在各自的 `package.json` 中通过 `dsh` 字段声明自己：`dsh.profile` 列出一个 profile 的组合包，`dsh.bundle` 指向一个组合包的 patch 文件。

[`dsh-base`](../packages/bundle/base/README.zh.md) 是 `web`、`headless`、`sdk` 与 `acp` profile 的共享第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。[`dsh-web-app`](../packages/bundle/web-app/README.zh.md) 增加浏览器应用，[`dsh-headless`](../packages/bundle/headless/README.zh.md) 增加不带服务器的一次性运行器，[`dsh-sdk-app`](../packages/bundle/sdk-app/README.zh.md) 增加 SDK JSON-RPC 服务器，[`dsh-acp-app`](../packages/bundle/acp-app/README.zh.md) 增加仅用于自动化的 ACP 服务器。[`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.zh.md) 是刻意保留的例外：一个组合包拥有完整的显式 SDK 配置树，不应用 `dsh-base`。

各层按此顺序应用在空条目列表之上：先按 profile 列出的顺序应用每个组合包，然后是 profile 的 `cordis.patch.yml`，然后是 home 级的那份，最后是任意 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。

自定义 profile 默认实时重载 patch。随附的 `web` profile 使用实时重载；`headless`、`sdk`、`sdk-minimal` 和 `acp` 则只在启动时应用一次所有配置层，因为一次性应用或 stdio 应用拥有工作之后，替换其依赖会破坏该生命周期。

要查看你的机器启动的配置树：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

组装机制见 [app-boot](../packages/boot/app-boot/README.zh.md#profiles)；配置字段见生成的[配置目录](config-catalog.zh.md)。

## 应用启动

所有受支持的 Node 应用都从 `dsh` CLI 与具名 profile 启动。随附应用是 `dsh web`（刻意为 `--profile web` 保留的别名）、`dsh --profile headless`、`dsh --profile sdk`、`dsh --profile sdk-minimal` 与 `dsh --profile acp`。TypeScript SDK 会解析其同版本 `dsh` 依赖并选择 `sdk`；自定义插件组合继续由 profile 与有序 patch 文件表达，而不是另一个可执行文件或内联应用树。`sdk-minimal` 是位于同一 launcher 后的仓库自有独立组合包，而不是由调用方提供的 Cordis 配置树。

Vendored CLI、仅用于构建和测试的可执行文件、进程内直接挂载插件以及私有浏览器 WebWorker 预览都不属于 Harness 应用启动器。[`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts)将每个包 bin、可执行源码与根 demo 归入显式类别，并拒绝任何绕过 `dsh` 的 Node 应用路径。

Python SDK 遵循相同的应用架构。其运行时 wheel 把普通 `dsh` CLI 打包为 `deepseek-harness-sdk-runtime-<platform>-<arch>`，客户端默认以显式 Harness home 启动 `dsh --profile sdk`。极简示例选择随附的 `sdk-minimal` profile。Python 暴露 profile 选择与有序 patch 文件，而不是完整 Cordis 树；持久外部插件通过 `dsh plugin` 安装。已删除的私有直读配置载体没有兼容 bin 或回退 parser。

## 核心包

以下是向 Cordis 树贡献内容的部分核心包。

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`core/session`](subsystems/session.zh.md) | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.zh.md) | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.zh.md) | 作用域化的工具注册表和带把关的执行流水线 | `ctx.tools` |
| [`core/agent`](subsystems/core.zh.md) | `Agent` 接口、活跃 agent 注册表和 `agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.zh.md) | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.zh.md) | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| [`llm/llm`](subsystems/llm-streaming.zh.md) | 消息与流式词汇表，以及适配器 seam | `ctx.llm` |
| [`webhook/webhook`](subsystems/webhook.zh.md) | 已认证 delivery 的分派和 Workspace Session 创建 | `ctx.webhookRuntime` |

<a id="events"></a>

## 事件

事件就是扩展点，而选对事件域是大多数改动的第一个决定。

- **会话事件**是追加到日志并通过 `session/event` 广播的持久事实。当某个事实必须在重新加载后仍然存在时，使用它。
- **Agent 事件**（`agent/*`）携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。要观察或拦截进行中的工作时，使用它。
- **能力事件**无需导入循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

[事件映射](event-producer-consumer.zh.md)列出每个事件的生产方与消费方。

<a id="turn-flow"></a>

## 轮次流程

一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*` 和 `tool/*` 是持久会话事件；其余是分属三个事件域的实时扩展点。`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 waterfall（瀑布式事件），其监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件，没有 `next()`。

输入通过同一个 inbox 到达驱动器。有些消息会立即唤醒它；注入的上下文会留在 inbox 中，直到另一条消息将其唤醒。

`agent/pre-step` 决定模型看到什么。监听器可以改写已领取的消息，也可以直接拒绝它们；首次领取被拒绝或被改写为空时，仍会关闭一个不含步骤的持久轮次，因此日志会记录这次尝试。enter 决策还可以设置 `startsRequestSeries` 来开启独立的模型消息序列：loop 会随之记录一个新的 `request/header`（原因为 `series`，或在封装同时变化时为携带 `startsSeries: true` 的 `change`）。重建下游 enter 决策的监听器必须展开它（`{ ...decision, messages }`），该声明才能存活。每个步骤读取插件注册的提示词片段和工具 schema。

详情见[时序图](agent-lifecycle.zh.md)、[工具流水线](tool-execution-pipeline.zh.md)和[取消与错误恢复](subsystems/core.zh.md#the-agent-handle)。

## 会话日志

会话日志是模型所见上下文的来源。`deriveMessages()` 从中投影出模型历史，原始 `assistant/chunk` 事件则保证回放和 UI 保真。fork、恢复、transcript（文本记录）、遥测和持久化都派生自该事件流。

**模型可见即已记录。** 抵达模型请求的一切都必须能从日志重建，并由一项运行时不变量断言这一点。因此，新增一项模型可见输入就需要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。

**投影 seam。** `dsh-session-projection` 提供 `ctx.sessionProjections`：已注册单元增量折叠已提交事件，host 消费方通过 `stateOf()` 读取单个类型化状态，载体通过 `snapshot()` 批量取得裁剪后的客户端视图。host 读取方要么在激活时要求该服务，要么在注册表或必需 key 缺席时明确失败。贡献方可以保留 `ctx.inject(['sessionProjections'], ...)` 注册，但不能为缺失的 host 值静默提供默认值。agent loop 为读取方注册共享的 `turnBoundary` 状态（[决策](../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.zh.md)）。

## 能力 seam

一个 **seam** 是一项可替换能力，包含三种角色：声明接口的 **Service Definition**、实现它的 **Service Provider**，以及使用它的 **Consumer**（通常是面向模型的工具）。一个包可以合并承担多个角色，但单一角色本身不是 seam；添加一项能力意味着把三者一并设计（[能力图](capability-seams.zh.md)）。

seam 正是替换一个提供方就能改变整个产品的原因。文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，也就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。[subagent 提供方](subsystems/subagent.zh.md)在同一个接口之后同样千差万别，从新建一个子 agent，到把一个轮次委派给另一个产品。

[实验性 Agent Teams](subsystems/agent-team.zh.md) 是 `ctx.agentTeams` 上的私有显式启用协作 seam，在可继续 subagent 之上提供持久 roster、任务板和 mailbox。

## 新行为的归属位置

新行为附加到已有文档记录的扩展点。改动循环本身时，本映射随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；其 schema 加入提示词组装 |
| 让某个会话拥有不同的能力集合 | 组装一个 agent preset；其中的服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 上注册；它无需模型轮次即可分派 |
| 添加后台工作 | 在 `ctx.jobs` 上注册；`job_*` 工具负责收集或停止 |
| 从外部 webhook 启动 Session | 在 `ctx.webhookRuntime` 上注册可信规则，并挂载提供方适配器 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 会停止轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；它会落到下一次获准的请求中 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `agent/*` 续跑 |
| 在轮次边界 fork 会话 | `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })`——只有经 agent-loop 发布的会话才会持久化 |
| 在新后端存储会话 | 基于共享的句柄脚手架实现 `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

[扩展实操手册](cookbook/extension-cookbook.zh.md)将功能映射到能力，并索引[包](cookbook/adding-a-package.zh.md)、[工具](cookbook/adding-a-tool.zh.md)、[LLM（大语言模型）适配器](cookbook/adding-an-llm-adapter.zh.md)和[设置卡片](cookbook/adding-a-settings-card.zh.md)的分步指南。[Conversation 子系统](subsystems/conversation.zh.md)负责 Chat node 组装。
