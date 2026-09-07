# Agent Note: 系统提示词是 surface 的第 0 号节点

Status: proposed

[English](2026-09-02-system-prompt-as-surface-node.md) | 中文

## Problem

系统提示词的持久化表示与模型读到的其他所有消息都不同。对话消息是 surface 事件（`user/message`、`assistant/message`、`tool/result`），由 `Session.deriveMessages()` 按 seq 顺序折叠；系统提示词则是仅记日志的 `request/header` 快照中的 `system` 字段，每个 DeepSeek 序列化器把它前置为协议消息 0（`serializeRequest`、`serializeRequestWithImages`）。[可重建请求 Agent Note](../../implemented/architecture/2026-07-05-reconstructable-requests.zh.md) 让两半都成为持久数据，却让一个模型可见的事实拥有两个归属：surface 拥有消息，header 拥有排在这些消息之前的那条消息。

这种拆分迫使每个想知道「模型看到了什么」的读取方都要合并两个来源。压缩摘要器（`buildSummarizationInput`）把 `header.system` 复制到区域派生消息之前；`dsh-token-meter` 从 header 估算系统提示词，却从 surface 为其他每条消息计价；Web 请求提示词卡片、轨迹视图和快照归一化器的 `{{system}}` 占位符各自单独读取 header。循环的变更检测同样被拆开：`headerEquals` 在 `config` 和 `tools` 旁边逐字节比较 `system`，因此提示词变更与工具变更在日志中无法区分（`request/header` 的 reason 都是 `change`），尽管它们是对对话的两种不同操作。

这种拆分还阻塞了下一步。一个把对话中途的 `system` 消息当作提示词替换来接受的模型，需要 harness 向历史追加一条 system 角色消息；当提示词住在 header 里时，没有可追加的 surface 表示，header 也只能靠特例被冻结。[历史内替换提案](../feature/2026-09-02-in-history-system-prompt-replacement.zh.md) 依赖本 Agent Note。

## Proposal

把系统提示词搬到 surface 上。它成为一个普通的 surface 事件 `system/message`，提示词生命周期中的每个操作都是对该事件类型施加现有两种 `SurfaceOp` 变体之一。协议请求不变：surface 折叠产出的消息列表与序列化器今天构建的完全相同，系统消息在最前面。

### 事件

`system/message` 加入 `SurfaceEventType`，与 `user/message`、`assistant/message`、`tool/result` 并列。它的载荷与 `tool/result` 对称：`{ turn, step, message }`，其中 `message` 是 `role: 'system'` 的 `Message`，恰好一个文本块承载渲染后的提示词，source 为 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`。`deriveEventMessage` 逐字投影它，因此 `deriveMessages()` 在其 surface 位置返回系统消息，而两个 DeepSeek 序列化器本已原样透传 `role: 'system'` 的历史消息，会把它作为协议消息 0 发出。`EpochHeader.system` 被移除；header 保留 `config`、`adapterDefaults` 和 `tools`。

### 操作

| 情形 | surface 操作 |
|---|---|
| 会话首个请求且渲染后的提示词非空 | 追加 `system/message` 作为 surface 第 0 号节点，位于该步骤首条 `user/message` 之前 |
| 渲染后的提示词与第 0 号节点不同 | 替换第 0 号节点：`surfaceOp: { op: 'replace', start: <第 0 号节点的 seq>, end: <同一值> }`，`sourceEventSeqs: [<第 0 号节点的 seq>]` |
| 首个请求时渲染后的提示词为空 | 没有系统节点；之后出现非空提示词且 surface 尚无系统节点时，追加为第 0 号节点 |

替换第 0 号节点就是今天的头部重写在 surface 上的表达：提供方前缀从第一个 token 起改变，日志通过 `sourceEventSeqs` 记录被遮蔽的节点，`replaceGeneration` 与压缩替换时一样推进，因此循环现有的 `startsSeries` 检测（`requestSurfaceGeneration !== surfaceGeneration`）无需在 `headerEquals` 中比较 `system` 即可覆盖提示词变更。`request/header` 保留 `initial`、`resume`、`change`、`series` 四种 reason；`change` 现在表示 config 或 tools 变更。

### 循环中的归属

`dsh-agent-loop` 在 `runtime-context.ts` 中与 `RuntimeContextProjection` 并列拥有一个 `SystemPromptProjection`。它从日志恢复当前系统节点（surface 上最新存活的 `system/message`），跟随 `session/event` 观察新的系统节点以及 `sourceEventSeqs` 遮蔽了所保留节点的替换，并在渲染后的提示词不同时返回未提交的追加或替换意图。`turn()` 紧接在该步骤的 `user/message` 事件之前提交该意图，因此日志顺序即协议顺序。`step()` 不再向 `buildRequest` 传递 `system`；请求由 `header.config`、`deriveMessages()` 和 `header.tools` 构成。`dsh-agent-loop/invariant` 伴随组件继续把重建的请求与冻结的请求比较，只是系统消息现在位于 `messages` 内。`docs/architecture.md` 记录新的循环步骤顺序：领取、装配、投影系统提示词、投影运行时上下文、pre-step、提交系统节点、提交用户消息、构建请求。

### 消费方迁移

| 消费方 | 现状 | 变更后 |
|---|---|---|
| DeepSeek 序列化器（`serializeRequest`、`serializeRequestWithImages`） | 前置 `options.system` | 只序列化 `options.messages`；`GenerateOptions.system` 为摘要器、标题提供方等直接单次调用方保留 |
| `compaction-basic` 的 `buildSummarizationInput` | `header.system` + 区域消息 | 第 0 号节点的派生消息 + 区域消息，仍是已路由请求的真实前缀 |
| `compaction-basic` 的 `selectCompactableRange` | 锚定在头部 `surfaceNodes[0]` | 锚定在首个非系统节点；第 0 号节点永不落入压缩范围 |
| `dsh-token-meter` 的系统提示词估算 | `header.system` 长度 | 系统节点与其他每个 surface 节点一样计价；上下文明细按其 source 插件标注 |
| Web 请求提示词卡片、轨迹请求 header 节点、请求检视 | 读取 `header.system` | 读取 `system/message` 节点；卡片保持折叠可检视的呈现，永不作为聊天气泡 |
| 快照归一化器的 `{{system}}` 占位符、断言 `header.system` 的 plan-mode 测试 | header | 系统节点的文本 |
| TypeScript 与 Python SDK 期望输出 | 没有系统事件 | 包含 `system/message` 事件 |
| 人类转录投影（`isAppendSurfaceEvent` 的读取方） | 没有系统事件 | 跳过 `system/message`；它是模型历史，不是对话 |

`RuntimeContextProjection` 与 `SystemPromptProjection` 是对称的：两者都通过 `sourceEventSeqs` 观察自己拥有的 surface 节点及其被遮蔽的情况，都把一条未提交的消息交给循环由 `turn()` 提交。区别在于角色与操作集——运行时上下文只追加 user 角色快照，系统提示词追加一次之后只做替换。

## Alternatives considered

**保留 `header.system`，只为更新添加 `system/message`。** 一个事实两个归属：上述每个消费方都要从 header 读消息 0、从 surface 读后续消息，循环还需要一个在 surface 存在系统节点时让 `headerEquals` 忽略 `system` 的特例。被否决，因为本次变更的目的就是单一表示。

**用专门的仅记日志事件 `system-prompt/change` 重写 header。** 保留 header 作为提示词归属，并把变更记录为独立事件种类，但仍无法表达历史内部的系统消息，历史内替换提案还是需要第二套机制。被否决。

**在适配器内根据相邻 header 合成系统消息。** 适配器逐请求无状态且从不接触日志；依赖适配器状态的协议历史无法从 surface 折叠重建。被否决。

**像运行时上下文那样用 `user/message` 快照表达提示词。** 复用了现有事件类型，却发送了错误的角色，因此把系统消息视为权威的模型不会这样对待它。被否决。

## Acceptance criteria

- `SurfaceEventType` 包含 `system/message`；`deriveEventMessage` 投影它；`Session.append('system/message', …)` 与其他 surface 事件一样要求 `SurfaceIntent`。
- `EpochHeader` 没有 `system` 字段；`headerEquals` 只比较 `config`、`adapterDefaults` 和 `tools`。
- 渲染后的提示词非空的首个请求在该步骤首条 `user/message` 之前追加 `system/message` 作为 surface 第 0 号节点；提示词变更时以指明被遮蔽节点的 `sourceEventSeqs` 替换第 0 号节点；提示词不变时不追加任何内容。
- 对同一会话历史，每个循环步骤的 DeepSeek 协议请求与今天逐字节一致：系统消息在先，随后是折叠后的对话。
- 压缩永不选中第 0 号节点；摘要器回放的前缀以第 0 号节点的派生消息开头。
- `dsh-token-meter`、Web 请求提示词卡片、轨迹与检视视图、快照归一化器、plan-mode 测试以及两个 SDK 的期望输出都读取系统节点；`dsh-agent-loop/invariant` 伴随组件重建请求时系统消息位于 `messages` 内。
- 演练会话中途提示词变更（进入与退出 plan 模式）的无密钥录制快照显示被替换的第 0 号节点，而不是 `request/header` 的 `change`。
- `docs/architecture.md`、`dsh-agent-loop`、`dsh-session`、`dsh-system-prompt`、`dsh-compaction-basic`、`dsh-token-meter` 的 README 以及可重建请求 Agent Note 都把 surface 节点描述为系统提示词的归属。

## Risks

- `header.system` 的每个读取方在一次变更中迁移；遗漏的读取方因字段消失而在编译期失败，这正是预期的失败方式。
- 压缩范围选择新增一条不变量（第 0 号节点永不被压缩）。除 `compaction-basic` 以外、锚定在 `surfaceNodes[0]` 的压缩提供方会遮蔽提示词；`dsh-session` 的 surface 管理器拒绝在第 0 号节点是 `system/message` 时覆盖第 0 号节点的替换，除非替换事件本身是恰好覆盖该节点的 `system/message`，因此不变量在操作发生处被强制，而不只在随发的提供方中。位于更后位置的系统节点没有此类保护：压缩范围可以遮蔽它们。
- 替换第 0 号节点会推进 `replaceGeneration`，今天有些读取方把它理解为「发生了压缩」；这些读取方改为检查替换事件的类型。
- 日志中包含 `header.system` 的录制快照 fixture 需要重新录制；改变的是 fixture，而不是归一化器。
