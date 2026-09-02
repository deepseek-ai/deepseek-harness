# Agent Note: 裁剪无用的公开与结果接口

Status: proposed

[English](2026-07-04-prune-dead-core-spine-api.md) | 中文

## 问题

若干包根导出、结果字段和便利方法没有生产消费方。它们之所以存活，要么是因为测试通过公开入口导入了内部实现，要么是因为某个类型预期了一个从未出现的调用者。每一项单独看都很小，但合在一起，它们扩大了 SDK 约定、生成的 catalog、文档和回归矩阵，却没有支撑任何已交付的路径。

生产语料库是 `packages/*/*/src`、示例源码/配置和运行时脚本。测试、包 README 和 Agent Note 行文是发布的证据，但不是固定调用者。`cordis_inspect` 使 `packages/extensions/tool-cordis/src/api-catalog.ts` 对模型可见，`cordis_mount` 可以通过受保护的真实服务代理调用注入的服务，因此 catalog 中的服务方法和返回形状是真正的动态产品接口。下表因此区分「没有固定的仓库调用者」与「不可达」：涉及 catalog 词汇的行有意收缩模型编写的 mount 能发现和调用的内容，而包根实现辅助函数并不通过该服务门面可达。精确符号搜索得出以下清单：

| 接口 | 生产证据 | 简化方式 |
| --- | --- | --- |
| `SurfaceManager.invalidate()` | 只有其单元测试调用它；seeding 在惰性创建的 manager 存在之前就已完成，且会话从不替换其日志引用。 | 删除它及其不可能触发的整体替换约定。 |
| `ToolExecutionResult.callId` | 每个钩子已经接收不可变的 `ToolExecution`；循环和 ACP（Agent Client Protocol）通过调用/会话事件关联。没有消费方读取这个重复的结果字段。 | 移除该字段、复制/不匹配守卫，以及证明该重复不可能不一致的测试。 |
| `ReactLoopAgent` 根导出 | 包外的命名导入都是测试；生产代码面向 `Agent` 编程，通过 `ctx.agents` 创建/恢复。 | 将返回类型和接口类型设为 `Agent`，将具体循环类改为包内部；保留有意设计的同步、仅配置的 `AgentLoop.create()` 路径。 |
| `workflow-worker-thread` 的 protocol/runtime/session 再导出与命名的 `WorkerThreadWorkflowEngine` | 所有通过包名导入的消费方都使用默认引擎；工作流 Agent Note 已将 worker 协议格式（wire format）定义为私有。 | 保留默认插件类/配置约定；移除重复的命名类导出，将协议模块保持为源码私有。 |
| `code-runtime-worker` 的 protocol/bootstrap 再导出 | 包外的生产/e2e 消费方使用 `WorkerThreadCodeRuntime` 和配置，而非 `BootstrapPort`、`PatchableStream` 或 worker 消息/启动类型。 | 保留运行时类/配置约定，将其协议格式/bootstrap 词汇改为源码私有。 |
| ACP 的 `agentOptions` 根导出 | 该辅助函数只有同文件和 ACP 测试消费方；唯一的包外生产消费方挂载的是插件命名空间。 | 保留 `name`、`inject`、`Config`、`AcpConfig` 和 `apply`；将 `agentOptions` 改为源码私有，通过桥接层行为测试。 |
| `providerWording` 与 `completedTurnPrefix` 根导出 | 各有一个同包生产调用者；只有 balanced-prefix 辅助函数有一个同包白盒测试。 | 改为源码私有，测试提供方行为。 |
| `depthOf`、`SubagentDepthError`、`waitForExit` 与 `exitsWithin` 根导出 | 生产 subagent 后端消费的是进程内 runner 和子进程构造/dispose（资源释放）辅助函数，而非这些强制机制和测试内部实现。`SENSITIVE_ENV_PATTERN` 不在其中，因为 SDK helper 会将它应用于调用方传入的环境。 | 保留深度与退出行为，但将剩余辅助函数和 error 改为源码私有；通过 spawn 和 dispose 测试。保持共享凭据正则公开。 |
| `LlmError.status` 与回放 status | 适配器/回放填充它，但生产分支基于稳定的错误码/消息判断，从不读取原始 status。 | 移除未读字段和回放管道，保留错误分类。 |
| `BlockAssembler.push()` 返回值 | 两个生产调用者都忽略返回的已完成块。 | 返回 `void`；保留有意公开的 `blocks()`/`message()` 约定。 |
| `compactRegion` 的独立 `session` 参数 | 固定调用方传入的对象就是 `agent.session` 中已有的对象；模型可见的 mount API 也可以调用该方法，但同时接受两个独立对象，会让挂载的插件传入不一致的组合。 | 保留手动 region API，同时有意将其收窄为以 `agent.session` 为唯一真源。 |
| `CompactionResult.startSeq`、`summarySeq`、`endSeq` 与 `summary` | 生产消费方只读取 shadowed range/seq/token 统计；持久日志拥有 summary 和事件标识。 | 移除四个结果回显，保留两个共享的 transcript（文本记录）渲染器。 |
| `BasicCompactionEngine` 的估算/摘要方法可见性 | 没有包外生产调用者调用这五个方法；已实现的 Agent Note 只将 `estimateContentTokens()` 和 `summarize()` 命名为子类钩子。 | 将这两个方法改为 `protected`，其余三个编排专用的估算器改为 private。 |
| `CodeLogEntry.source`/`level` 与 `RunCodeMeta.dispatches` | 每个生产消费方都将日志映射为文本；没有 presenter/模型路径读取其他字段或持久化的 dispatch 计数。 | 将 code-runtime 日志改为字符串（或纯文本条目），移除 result-meta 的 dispatch 管道；保留用于生成确定性 dispatch id 的本地计数器。 |
| `CodeRuntime.language` 与 `CodeRuntime.isolation` | worker 后端提供唯一的生产值，而 PTC mode 及其他所有生产调用方只调用 `run()`。 | 移除未读描述符，同时保留 worker 的语言、隔离、预算、取消与资源释放行为。 |
| `ToolNotFoundError.toolName`、`SystemPrompt.config` 与 `BashTask.command` | 每个存储的公开值都没有生产读取者。 | 移除未读字段，保留错误消息、已解析的配置行为和任务生命周期。 |
| 后端包根实现辅助函数 | 下方精确清单仅通过相对路径的同包导入调用。生产命名空间导入挂载的是保留的插件约定，不读取这些属性；包根命名导入的消费方都是测试。 | 保留每个适配器/提供方/服务及其配置/错误约定；停止在包根导出所列辅助函数/常量。 |
| 消费方包根实现辅助函数 | 下方精确清单只有同包生产调用者。生产命名空间导入挂载的是插件约定，不读取辅助属性；包根命名导入的消费方都是测试。 | 保留插件约定和稳定的错误码；将测试迁移到包内模块或公开行为，停止在包根导出所列辅助函数。 |

### 分组辅助导出清单

- `dsh-llm-deepseek`：`httpErrorCode`、`serializeMessages`、`serializeRequest`、`DONE`、`parseSse`、`mapFinishReason`、`mapUsage` 与 `translate`；`dsh-llm-pi-ai`：`buildModel`、`mapStopReason`、`mapUsage`、`toPiContext` 与 `toStreamChunks`。
- `dsh-bash-local`：`DEFAULT_GRACE_MS`、`ENV_OVERRIDES`、`killGroup`、`OutputCollector` 与 `runBash`；`dsh-bash-sandbox`：`shellQuote`、`classifyDenial` 与 `classifyRunnerFailure`；`dsh-sandbox-local`：`bwrapProfileArgs`、`landlockProfileArgs` 与 `seatbeltProfileArgs`。公开的可变测试注入字段及其类型不在本提案范围内。
- `dsh-fs-local`：`applyLiteralEdit`、`listDirectory`、`probe`、`readForEdit`、`readTextForDiff`、`readWholeText`、`resolveLocalTarget`、`restoreLineEndings`、`streamWholeText` 与 `writeFileAtomic`。
- `dsh-web-fetch-http`：`classifyContentType`、`decoderForCharset`、`isSameOrigin`、`parseCharset` 与 `validateFetchUrl`；`dsh-web-search-exa`：`mapExaResponse` 与 `mapExaResult`；`dsh-web-search-deepseek`：`citationSnippets` 与 `mapAnthropicResponse`；`dsh-web-search-perplexity`：`mapPerplexityResponse` 与 `mapPerplexityResult`。
- `dsh-tool-fs`：`READ_LIMIT`、`STREAM_MIN_SIZE`、`READ_MAX_BYTES`、`READ_MAX_LINE_LENGTH`、`DIFF_CONTEXT`、`applyReadTool`、`parseReadArgs`、`applyWriteTool`、`formatWriteOutput`、`parseWriteArgs`、`applyEditTool`、`formatEditOutput`、`parseEditArgs`、`buildWindow`、`formatReadOutput`、`computeHunkDiffs` 与 `diffsFromMeta`。
- `dsh-tool-web`：`WEB_SEARCH_MAX_RESULTS`、`applyWebSearchTool`、`formatSearchOutput`、`parseSearchArgs`、`presentSearchCall`、`applyWebFetchTool`、`formatFetchOutput`、`parseFetchArgs`、`presentFetchCall`、`renderBody` 与 `htmlToMarkdown`；`dsh-tool-call-timeout-policy`：`toolTimeoutResult`；`dsh-compaction-basic`：`resolveConfig`；`dsh-tool-bash`：`renderResult`。

## 提案

以一次有界的、协调的公开接口清理，移除或降级上述每一行。同步更新包 README、JSDoc、生成的 API/事件 catalog、type-equiv 记录、必要的 exports map 以及测试，使测试通过所属的公开约定验证行为，而非保留仅为测试而存在的入口。不折叠任何能力 seam、LLM（大语言模型）适配器、持久化 provider 或生命周期完全停稳约定。

## 曾考虑的替代方案

**保留测试便利函数和自包含的结果字段为公开。** 公开辅助函数可以让白盒测试更方便，自包含的结果字段看起来更易用，未来的嵌入者可能需要具体循环类或枚举方法。这些好处是假设性的；保留它们会让每处实现和文档都要解释没有已交付调用者能观察到的状态。真正的消费方可以引入它所需的最小约定，其所有权和失败语义明确。

**保留所有 catalog 成员以供模型编写的 mount 使用。** 自引用工具集是一条真实的通用消费路径，而非生成文档的噪音。然而，它的价值来自准确、可组合的服务接口，而非无限期保留重复字段或不一致的参数对；上述每一项 catalog 收缩都移除了在同一次执行、同一个 agent（智能体）或同一结果中其他位置已可获得的事实，并在同一变更中更新 API 参考。

## 验收标准

- 精确符号搜索显示：在本 Agent Note 及任何对已实现 Agent Note 的修正之外，没有被移除的接口。
- 本 Agent Note 列出的每个接口均按指定方式移除或降级；清单之外有意保留的扩展/测试约定不变。
- 工具执行、上下文压缩（context compaction）、两个 LLM 适配器、持久化 provider、工作流隔离以及 agent 创建/恢复保持其已交付行为。
- 类型检查、覆盖率、快照、doc-sync（文档同步门禁）、module-graph 校验、构建和 hygiene 通过。

## 风险

大多数移除在编译时可见但对运行时无影响。上下文压缩参数清理有意禁止会话/上下文不匹配，同时保留手动 region API。外部预发布嵌入者和现有模型编写的 mount 可能导入更少的辅助函数、传递更少的参数或接收更窄的结果形状；这是有意的产品接口收缩，而非仅仅是生成 catalog 的清理。仓库尚未发布，因此承载不受支持的接口才是更大的基础成本。
