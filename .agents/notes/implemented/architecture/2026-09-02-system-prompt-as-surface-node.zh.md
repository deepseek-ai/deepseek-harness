# Agent Note: 系统提示词是 surface 的第 0 号节点

Status: implemented

[English](2026-09-02-system-prompt-as-surface-node.md) | 中文

## Problem

放在 surface 之外的系统提示词，其持久化表示与模型读到的其他所有消息都不同。对话消息是 surface 事件（`user/message`、`assistant/message`、`tool/result`），由 `Session.deriveMessages()` 按 seq 顺序折叠；而存放在仅记日志的 `request/header` 快照 `system` 字段中的提示词，必须由每个序列化器前置为协议消息 0。[可重建请求 Agent Note](2026-07-05-reconstructable-requests.zh.md) 让两半都成为持久数据，但这种布局让一个模型可见的事实拥有两个归属：surface 拥有消息，header 拥有排在这些消息之前的那条消息。

这种拆分迫使每个想知道「模型看到了什么」的读取方都要合并两个来源：压缩（compaction）摘要器把 header 中的提示词复制到区域派生消息之前，`dsh-token-meter` 从 header 估算系统提示词却从 surface 为其他每条消息计价，Web 请求提示词卡片、轨迹视图和快照归一化器的 `{{system}}` 占位符各自单独读取 header。变更检测同样被拆开：在 `config` 和 `tools` 旁边逐字节比较 `system` 的 `headerEquals`，让提示词变更与工具变更在日志中无法区分（`request/header` 的 reason 都是 `change`），尽管它们是对对话的两种不同操作。

这种拆分还阻塞了下一步。一个把对话中途的 `system` 消息当作提示词替换来接受的模型，需要 harness 向历史追加一条 system 角色消息；当提示词住在 header 里时，没有可追加的 surface 表示，header 也只能靠特例被冻结。[历史内替换决定](../feature/2026-09-02-in-history-system-prompt-replacement.zh.md) 依赖本 Agent Note。

## Decision

系统提示词住在 surface 上。它是一个普通的 surface 事件 `system/message`，提示词生命周期中的每个操作都是对该事件类型施加现有两种 `SurfaceOp` 变体之一。协议请求不变：surface 折叠产出的就是序列化器发送的消息列表，系统消息在最前面。

### 事件

`system/message` 是 `SurfaceEventType` 的成员，与 `user/message`、`assistant/message`、`tool/result` 并列（`packages/core/session/src/types.ts`）。它的载荷与 `tool/result` 对称：`{ turn, step, message }`，其中 `message` 是 `role: 'system'` 的 `SystemMessage`，一个文本块承载渲染后的提示词，source 为 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`。空的 `content` 记录「没有系统提示词」：该节点保持其 surface 位置，`deriveEventMessage` 把它投影为 `null`，因此不贡献任何协议消息。非空节点逐字投影，因此 `deriveMessages()` 在其 surface 位置返回系统消息，而原样透传 `role: 'system'` 历史消息的 DeepSeek 序列化器把它作为协议消息 0 发出。`EpochHeader` 是 `{ config, adapterDefaults?, tools? }`；`packages/core/session/src/request-header.ts` 中的 `canonicalHeader` 与 `headerEquals` 只比较 config、适配器默认值和工具。

### 操作

| 情形 | surface 操作 |
|---|---|
| surface 上没有存活的 `system/message`（包括渲染后的提示词为空时） | 追加 `system/message`；在会话的首个步骤中它是 surface 第 0 号节点，位于该步骤首条 `user/message` 之前 |
| 有存活的 `system/message` 且渲染后的提示词与其文本不同（包括提示词变为空） | 恰好替换该节点：`surfaceOp: { op: 'replace', startSeq: <该节点的 seq>, endSeq: <同一值> }`，`sourceEventSeqs: [<该节点的 seq>]`；空提示词产生一个投影为无消息的空内容节点 |
| 渲染后的提示词与存活节点的文本相同 | 无操作 |

当初始渲染的提示词为空时，循环在初始接纳的用户消息之前预留空系统头部，使稍后首次变为非空的提示词仍替换第 0 号节点。省略该空节点会让后来的提示词追加在用户历史之后，pi-ai 会将其转换为用户消息，而不是 `systemPrompt`。替换第 0 号节点是头部重写在 surface 上的表达：提供方前缀从第一个 token 起改变，日志通过 `sourceEventSeqs` 记录被遮蔽的节点，`replaceGeneration` 与压缩替换时一样推进。因此循环的 `startsSeries` 检测（`requestSurfaceGeneration !== surfaceGeneration`）无需在 `headerEquals` 中比较 `system` 即可覆盖提示词变更。`request/header` 保留 `initial`、`resume`、`change`、`series` 四种 reason；`change` 表示 config 或 tools 变更，提示词替换之后跟随的未变 header 记为 `series`。

`packages/core/session/src/surface.ts` 在 `assertSystemHeadRewrite` 中强制头部不变量：当第 0 号节点是 `system/message` 时，范围覆盖第 0 号节点的替换会被拒绝，除非替换事件本身是恰好覆盖该节点的 `system/message`。位于更后位置的系统节点没有此类保护；压缩范围可以遮蔽它们。

### 循环中的归属

`dsh-agent-loop` 在 `packages/core/agent-loop/src/runtime-context.ts` 中与 `RuntimeContextProjection` 并列拥有 `SystemPromptProjection`。它在每次投影时从当前 surface 读取存活的 `system/message` 节点，因此同一步骤中更早运行的压缩或替换已经反映在内。`project(rendered, { inHistory, startsSeries })` 返回 `{ message, intent }`——没有系统节点存活或[历史内规则](../feature/2026-09-02-in-history-system-prompt-replacement.zh.md)适用时 `intent` 为 `{ surfaceOp: 'append' }`，否则是对最新存活系统节点的精确替换——最新节点已持有渲染文本时返回 `undefined`。

在 `packages/core/agent-loop/src/agent.ts` 中，`preStep` 用 `renderPrompt(assembly)` 渲染提示词，并在 `agent/pre-step` waterfall 之后投影它，因此压缩提供者在该 waterfall 内做出的替换对决定可见；`turn()` 紧接在 `step/start` 之后、该步骤的 `user/message` 事件之前提交 `system/message`，因此日志顺序即协议顺序。`buildRequest` 不在请求上设置 `system`：请求由 `header.config`、`session.deriveMessages()`（系统消息在先）和 `header.tools` 构成。循环步骤顺序为：领取收件箱 → `systemPrompt.assemble()` → 投影运行时上下文 → `agent/pre-step` waterfall → 投影系统提示词 → `step/start` → 提交 `system/message`（有变化时） → 提交各条 `user/message` → `agent/request` waterfall → `request/header` → `request/context` → 流式请求。`dsh-agent-loop/invariant` 伴随组件（`packages/core/agent-loop/src/invariant.ts`）断言循环构建的请求满足 `system === undefined` 且 `messages` 等于 `deriveMessages()`。

`dsh-token-meter` 把用量锚定到成功的 `assistant/message` 之前的已计价 surface，而不是 `step/start`。循环在步骤开始之后接纳系统提示词与用户消息，重试恢复还可能在重建请求之前替换节点。捕获当前 surface 会让每个已接纳输入恰好计入一次；内嵌的提供方输出仍单独计价，因此持久 assistant 改写保留其带符号增量。开放步骤只保存 turn 与 step 以验证生命周期，不保存第二份节点快照。

### 消费方

| 消费方 | 读取内容 |
|---|---|
| DeepSeek 序列化器（`serializeRequest`、`serializeRequestWithImages`） | `options.messages`，把 `role: 'system'` 的历史消息作为协议消息 0 透传；`GenerateOptions.system` 为标题提供方等直接单次调用方保留 |
| `dsh-llm-pi-ai` | 开头的 system 历史消息映射为 pi-ai 的 `systemPrompt` |
| `compaction-basic` 的 `buildSummarizationInput` | 第 0 号节点的派生消息前置于 `SummarizationInput.messages` 中的区域消息，无单独的 `system` 字段；空内容头节点不投影为消息，但仍受保护而不能被压缩 |
| `compaction-basic` 的 `selectCompactableRange` | 锚定在首个非系统节点；第 0 号节点永不落入压缩范围 |
| `dsh-token-meter` | 系统节点作为 surface 节点计价，归入 `systemTokens` 明细 |
| Web 请求提示词卡片、轨迹请求节点、请求检视 | `system/message` 节点；被替换的第 0 号节点显示为提示词变更，追加的历史内节点显示为提示词更新，各自以折叠可检视的卡片呈现，永不作为聊天气泡 |
| 快照归一化器的 `{{system}}` 占位符、plan-mode 测试 | 系统节点的文本 |
| TypeScript 与 Python SDK 预期输出 | 包含 `system/message` 事件 |
| 人类 transcript（文本记录）投影 | 跳过 `system/message`；它是模型历史，不是对话 |

`RuntimeContextProjection` 与 `SystemPromptProjection` 都把一条未提交的消息交给循环由 `turn()` 提交。两者在观察 surface 的方式与操作集上不同：运行时上下文跟随 `session/event` 观察自己拥有的 user 角色快照且只做追加，而系统提示词在每次投影时扫描当前 surface 上的系统节点，因为它的决定取决于有多少节点存活，并按路由追加或替换。

### V2-to-V3 结构转换

[V2 到 V3 规范](../../../../packages/session/session-format-v2-to-v3/README.zh.md#system-head)负责系统头节点转换与消息身份；其[引用规则](../../../../packages/session/session-format-v2-to-v3/README.zh.md#sequence-references)和[源拒绝](../../../../packages/session/session-format-v2-to-v3/README.zh.md#source-audit)定义保留内容与不支持的输入。迁移布局与原生请求语义等价，而非与原生录制逐字节相同。有效 V2 源在当前步骤不变量下可能没有保持顺序的转换方式；拒绝它优于移动历史或放宽归属。历史接收坐标不得变为对转换后日志的确认。

[已发布格式策略](2026-08-31-released-session-format-migrations.zh.md)保留每条已发布转换的语义；已有目标格式代际不会重跑其入边。投影缓存版本独立于 Session 格式版本。

[规范信封规范](../../../../packages/session/session-format-v2-to-v3/README.zh.md#canonical-envelopes)定义与结构转换的组合；[规范信封决策](2026-09-06-v3-canonical-session-envelopes.zh.md)负责严格准入的依据。

## Alternatives considered

**保留 `header.system`，只为更新添加 `system/message`。** 一个事实两个归属：上述每个消费方都要从 header 读消息 0、从 surface 读后续消息，循环还需要一个在 surface 存在系统节点时让 `headerEquals` 忽略 `system` 的特例。被否决，因为本次变更的目的就是单一表示。

**用专门的仅记日志事件 `system-prompt/change` 重写 header。** 保留 header 作为提示词归属，并把变更记录为独立事件种类，但仍无法表达历史内部的系统消息，历史内替换提案还是需要第二套机制。被否决。

**在适配器内根据相邻 header 合成系统消息。** 适配器逐请求无状态且从不接触日志；依赖适配器状态的协议历史无法从 surface 折叠重建。被否决。

**像运行时上下文那样用 `user/message` 快照表达提示词。** 复用了现有事件类型，却发送了错误的角色，因此把系统消息视为权威的模型不会这样对待它。被否决。

## Consequences

- 单一表示：每个想知道「模型看到了什么」的读取方都折叠 surface；没有消费方需要把 header 与消息列表合并。`EpochHeader` 没有 `system` 字段，因此期望该字段的读取方在编译期失败。
- 提示词变更与工具或 config 变更在日志中可以区分：前者是对第 0 号节点的 `system/message` 替换加随后的 `series` header，后者是 reason 为 `change` 的 `request/header`。
- 压缩带有一条不变量：第 0 号节点永不被压缩。`dsh-session` 的 surface 管理器在替换操作本身中强制它，因此除 `compaction-basic` 以外的压缩提供方无法通过锚定在 `surfaceNodes[0]` 来遮蔽提示词。更后位置的系统节点按设计不受保护。
- `replaceGeneration` 在提示词替换时和压缩时一样推进；需要区分两者的读取方检查替换事件的类型。
- 历史中途的系统节点拥有 surface 表示，这正是[历史内替换决定](../feature/2026-09-02-in-history-system-prompt-replacement.zh.md)所依赖的基础。
- 初始空提示词占据受保护的头部，但不贡献协议消息；在替换模式下，后来的非空提示词替换它，并保持为开头的系统消息。
- 录制的快照 fixture 携带 `system/message` 事件而非 header 的 `system` 字段。快照归一化器把该事件的文本标记化为 `{{system}}`，提示词伴随文件从 `system/message` 序列采集（每个提示词版本一节，以 `header.promptChanges` 声明），`request/header` 的 pin 只比较 config 与 tools。

## Testing

- `packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts` 钉住提供方用量下调用后的表面增量为零，覆盖初始、增长、缩短与空提示词、同一步骤中的重试替换、请求中间件和全新回放。
- `packages/core/session/tests/surface.spec.ts`（`system/message surface node` 块）钉住开头 system 角色的投影、空内容的 `null` 投影、`assertSystemHeadRewrite` 的接受与拒绝路径、更后位置系统节点不受保护，以及对 seed 中非 system 角色或非插件 source 的 `system/message` 的拒绝。
- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` 钉住首次渲染时的追加（包括空提示词）、替换模式下后来非空提示词位于派生历史头部、提示词未变时的无操作、变更时对最新存活节点的替换、替换遮蔽了非头部系统节点之后的尾部追加，以及历史内追加与重新基线规则。
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts`（`a system-prompt change replaces surface node 0 and starts a new series under the same header`）钉住提示词替换之后跟随的 `series` header。
- `packages/core/agent-loop/tests/invariant.spec.ts` 钉住伴随组件对携带 `system` 字段的循环请求的拒绝，以及其 `messages` 与边界派生结果的相等性检查。
- `packages/llm/llm-deepseek/tests/serialize.spec.ts`（`serializes a leading system message byte-for-byte like the same prompt passed as options.system`）钉住协议一致性。 `packages/llm/llm-pi-ai/tests/context.spec.ts` 在文本与图片路径上比较两种系统提示词来源。`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 通过区域事务与默认摘要器钉住派生前缀、已路由工具、不携带单独 `system` 选项，以及非空或空头节点的保护。
- `snapshots/` 下的录制快照钉住每个随发 profile 的模型可见协议请求；渲染了提示词的录制会话在其 `session.jsonl` 中于 surface 第 0 号节点携带 `system/message` 事件，会话中途发生提示词变更的会话则携带对第 0 号节点的替换，或在历史内路由上携带追加的节点。
