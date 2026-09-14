# Agent Note: 历史内系统提示词替换，实现缓存稳定的提示词变更

Status: implemented

[English](2026-09-02-in-history-system-prompt-replacement.md) | 中文

## Problem

每一次系统提示词变更都要付出整个提供方前缀缓存的代价。循环在每个步骤渲染提示词；一旦字节不同——plan 模式片段进入或退出、某个 skill 或工具指引片段完成注册、agent 作用域的 persona 遮蔽、`{{model}}` 变量改变——请求的消息 0 随之改变，DeepSeek 上下文缓存从第一个 token 起失效。长时间的 agent 会话反复为此付费，而[运行时上下文快照设计](../../archived/feature/2026-07-30-current-sandbox-policy-context.md)之所以存在，正是因为把会变化的事实移出提示词是保持前缀稳定的唯一办法。

一个 DeepSeek 模型——在此按为本项工作提供的模型事实记录——移除了这一限制：它接受对话任意位置的 `system` 消息，并把最新一条视为完整的有效系统提示词，替换最前面那条。工具 schema 仍属于被缓存的前缀，因此工具集变更仍会使缓存失效。有了这样的模型，harness 可以把新提示词追加到已缓存的历史之后而不是重写消息 0，前缀就能保持热态。

因为[系统提示词是 surface 第 0 号节点](../architecture/2026-09-02-system-prompt-as-surface-node.zh.md)，harness 拥有实现这一点的表示：提示词变更是对 `system/message` surface 节点的操作，而「替换最新的系统节点」与「追加新节点」之间的选择是逐路由的决定。

## Decision

对于声明了该能力的模型路由，当渲染后的提示词变化且前缀本可存活时，循环追加一个新的 `system/message` surface 节点而不是替换最新的系统节点。[surface 节点决策](../architecture/2026-09-02-system-prompt-as-surface-node.zh.md)中的其他一切不变：事件类型、投影的拥有者、序列化器，以及第 0 号节点的头部保护。

### 能力

`dsh-llm` 定义 `SystemPromptUpdate = 'in-history'`，并把它作为可选的并列字段 `systemPromptUpdate` 放在 `LlmResolvedModelInfo` 与 `PreparedLlmCall` 上；`normalizeModelInfo` 用代码为 `INVALID_MODEL_INFO` 的 `LlmError` 拒绝任何其他值。DeepSeek 适配器的目录模型（`DeepSeekCatalogModel.systemPromptUpdate`，加载时由 zod 校验）与回放提供者的 `ReplayModelConfig.systemPromptUpdate` 逐模型声明它；缺省表示该模型需要重写消息 0。`dsh-llm-deepseek` 仅内置 `deepseek-flash` 条目，在该条目上声明它，同时声明文本和图片输入。该精确目录条目记录模型能力；名称和协议类别不能推导其他模型是否支持。部署方可以通过 `cordis.yml` 的 `models` 列表替换目录，所有 `dsh-llm-pi-ai` 路由保持替换行为。

循环把该模式记录进会话：`RequestContext.systemPromptUpdate` 与 provider、model、容量并列成为 `request/context` 的字段，其中任一项与最新快照不同时就记录一次。准入读取 `agent/request` 之后实际准备调用的 `PreparedLlmCall.systemPromptUpdate`；先前快照不是准入输入。因此首次请求、恢复的会话、路由变更以及同一路由的能力变更，都使用将服务该调用的绑定适配器的能力。

### 决策规则

`packages/core/agent-loop/src/runtime-context.ts` 中的 `SystemPromptProjection.project(rendered, { inHistory, startsSeries })` 每次调用都扫描当前 surface 上存活的 `system/message` 节点。它返回有序的逐节点提交。没有存活的系统节点时，即使渲染文本为空也预留头节点。有效文本取自最新的非空系统节点，没有时回退到头节点；未生效的空尾节点既不提供有效文本，也无需再次以空内容替换。无论路由或序列状态如何，空渲染文本都会清除每个生效的系统节点。不具备能力的路由或新请求序列面对非空渲染文本时，即使有效文本未变也执行归并。除此之外，有效文本相同时不产生事件。具体操作如下：

| 路由能力 | 前缀状态 | 操作 |
|---|---|---|
| 无 | 非空渲染文本，任意前缀状态 | 为每个非空的后续系统节点记录空内容替换，随后按需用渲染文本重写首个系统节点 |
| `in-history` | 当前请求序列延续 | 在该步骤的 `user/message` 事件之前追加新的 `system/message`；仅追加本身不需要记录 `request/header` |
| `in-history` | 非空渲染文本，新序列开始 | 为非空的后续系统节点记录空内容替换，再按需重写首个系统节点，即使最新有效文本未变也执行 |
| 任意 | 渲染后的提示词为空 | 为非空的后续系统节点记录空内容替换，再按需清空头节点；派生消息中不保留任何提示词版本 |

`startsSeries` 在以下情况为真：`agent/pre-step` 决定声明了 `startsRequestSeries`、surface 的替换代数自上次请求以来发生了移动（压缩或任何其他替换）、可见工具 schema 集合发生了变化。仅 provider 或 model 切换对本规则不算序列开始：目标路由具备能力时，变更后的提示词被追加，这不花任何代价，因为路由变更本身已经使缓存未命中。序列开始已经付出了缓存代价，因此归并让模型历史只保留当前提示词。有日志记录的逐节点空内容替换会从派生消息中移除后续提示词，无需 surface 删除操作，也不替换其间的对话节点。这也使压缩恢复不会在失败尝试已接纳的用户消息之后追加系统更新。

首次尝试在组装、被接纳的 `agent/pre-step` 决策、`step/start`、`agent/request` waterfall 与 `prepareCall()` 之后才接纳提示词。被拒绝或为空的首次输入不打开步骤。两个异步请求阶段都不提交待处理的系统提示词与已接纳用户消息，在任一阶段取消都不会提交这两者。每次尝试都在各自的 `agent/request` 与 `prepareCall()` 之后同步协调同一份已渲染组装结果、仅在首次尝试追加已接纳用户批次、按需记录 header/context、派生并冻结请求，再通过同一个已准备调用发起流式请求。重试不重复组装、`agent/pre-step` 或用户消息准入。协调过程可见 pre-step 压缩（`auto: true` 的 `compaction-basic`）与恢复压缩，并在任一种压缩开启新序列时将非空提示词文本归并到头部。恢复属于序列延续——`resume` header 不是序列开始——因此跨重启发生变化的提示词被追加；提供方缓存在进程边界之后可能仍是热的。

空头节点且没有生效的后续系统节点表示没有提示词。未生效的空尾节点不提供有效文本，因此重复清除与恢复会话都不会使旧提示词重新生效。重新提供非空文本使用同一准入规则：延续中的具备能力路由可以追加它；不具备能力的路由或新序列则重新填充头节点。清除使用普通的逐节点替换，而非 surface 删除或初次创建空头节点。

### 呈现与记账

Web 在追加的历史内节点自己的位置呈现它。`SystemPromptNode` 携带 `{ seq, time, turn, step, text, update }`，其中 `update` 对已加载窗口内跟在更早系统节点之后的追加 `system/message` 为真。Chat 把非空的更新渲染为一张折叠的 `system-prompt` 卡片，标题取自 locale 键 `message.systemPromptUpdate`，同一 turn 与 step 内的 `request/header` 不会重复提示词卡片；`inspectRequestPrompt` 对跟在更新之后的 header 不报告系统变更。Trajectory 把跟在已加载请求 header 之后的更新折叠为一条合成的请求 header 事实，`promptChange.kind = 'system'`，因此之后的请求无需真实的 header 变更就能显示有效提示词。已加载窗口缺少更早的系统节点时，更新按初始提示词呈现。转录投影像对待所有 `system/message` 一样跳过它。

`dsh-token-meter` 把 surface 顺序中最后一个非空且存活的系统节点计入 `contextBreakdown.systemTokens`；其余可见节点（包括被取代的提示词）计入 `messageTokens`。休眠空节点被忽略。每次替换后，两者之和都等于固定启发式 surface 总量，无论是否存在影子价 claim。紧凑的保留条目复用测量服务的 surface 规划器：状态和转换成本为 O(当前保留 surface)，不是 O(1) 或 O(完整历史日志)。被替换条目和消息正文被丢弃，状态版本 4 拒绝标量检查点。后续 assistant 用量中的 `cacheReadTokens` 仍是可观察的提供方缓存效果。

Trajectory 选择前一条真实 header 与前一条合成系统 header 中较新的一个作为比较状态。真实 header 拥有配置与工具；追加的提示词可以在没有另一条真实 header 时推进该状态。只比较真实 header 会在 A → B → C 序列中把 A 而不是 B 报告为先前提示词。

Chat 与 Trajectory 通过纯操作 `uiConversation.inspectSystemPrompt` 解释有效提示词。每个 target 为系统事件与位置替换保留不可变的前缀状态，其中只包含存活系统节点，以及将存活替换序号映射到继承 surface 位置的映射表。每次替换复制该表并删除被遮蔽的条目；历史前缀映射表保持不可变。普通追加与流式更新无需折叠提示词。节点是否存活由 surface 顺序决定，而不是事件顺序或来源引用：压缩可以在没有另一个系统事件的情况下恢复更早的提示词，头部重写的序号也可能大于更后位置的有效提示词。空节点仍可被定位，但不会覆盖非空提示词。早于最早已加载相关事件的端点，其顺序未知，除非已有替换位置索引。遇到这样的端点后，解释器会暂停公开之后的所有提示词文本，直到向前补页回放解析缺失的前缀；事件序号顺序不能确定 surface 顺序。历史卡片保留自己的前缀状态，而不是读取最终 surface。

### 压缩

`compaction-basic` 不变。`selectCompactableRange` 仍锚定在第一个非系统节点，因此第 0 号节点永不被遮蔽，更后的历史内节点则可能被遮蔽；`buildSummarizationInput` 将派生的头节点前置到 `messages`，再按 surface 顺序加入每个被遮蔽节点的派生消息，因此区域中途的系统节点在原位被回放，摘要调用仍是对话的真实前缀。

## Alternatives considered

**只发送变化的片段作为增量。** 模型把最新的系统消息当作完整提示词，因此增量会静默丢掉每个未变化的片段。基于模型约定被否决。

**用插件配置而不是模型能力启用历史内模式。** 部署标志可能把不具备能力的模型与追加的系统消息配对，这样的模型最多把它们当作普通历史。该能力属于兑现它的路由；适配器目录已经承载逐模型的容量信息。被否决。

**永远追加，从不重新基线化。** 规则单一，但第 0 号节点会在会话整个生命周期内保持过时，压缩之后的每个请求都要携带过时的头部加替换消息。在序列开始处重新基线化不花额外代价，因为缓存在那里已经丢失。被否决。

**每次恢复都重新基线化。** 为更简单的恢复路径接受每次进程重启一次缓存未命中。缓存跨重启持续数小时到数天，而日志已经承载恢复所需的一切。被否决。

**把系统消息放在该步骤的用户消息之后。** 两个位置都在已缓存前缀之后，但模型会在读到必须应用指令的输入之后才读到指令；system 在 user 之前与最前位置的顺序一致。被否决。

**在 `agent/pre-step` waterfall 之前投影提示词。** 投影将看不到在该 waterfall 内执行的压缩，刚追加的节点可能在同一步骤内被遮蔽，请求就会把第 0 号节点的过时提示词作为唯一的系统消息携带。在 waterfall 之后投影让规则保持为构建请求所用 surface 的纯函数。被否决。

**用先前的请求上下文决定准入。** 它描述上一次调用，而非请求中间件之后绑定的适配器。在首次调用、恢复之后、路由或能力变更之后，它可能选错提示词表示。在提交提示词与用户消息之前解析，还能防止取消时接纳未发送的内容。被否决。

**把 provider 或 model 切换视为序列开始。** 它会在每次路由变更时把提示词折回第 0 号节点，与 tools 的情形一致。header 已经记录了该变更，缓存无论如何都会未命中，因此这条额外规则除了在循环中多一个特例之外没有任何收益。被否决。

**仅清除最新系统节点。** 空节点不投影为消息，因此更早的提示词会重新生效。清除所有生效版本才能保留空渲染文本的含义，同时不删除对话历史。被否决。

**只保留标量总量或提示词祖先链。** 标量影子价无法判断最新提示词从哪个分类消失，也无法恢复其前一个版本。仅有提示词条目无法定位任意非提示词替换端点；`sourceEventSeqs` 还可能引用存活提示词，改写后的事件序号顺序也不同于 surface 顺序。保留紧凑的当前 surface 条目可以复用现有规划器，无需完整日志访问、第二套验证器或消费方专用持久事件。把所有存活提示词之和归入系统数字会改变有效提示词的含义，而不是修复分类。

## Consequences

- 具备能力的路由上的提示词变更保住提供方前缀缓存；追加的节点在该序列的每个请求上付出自身的 token 开销，直到压缩遮蔽它。提示词在多数步骤都变化的部署，更适合把那个事实移入运行时上下文。
- 请求头部不是系统提示词唯一可能的位置：「模型看到了什么」的读者折叠 surface 并取最新的系统节点，明细的系统数字遵循同一规则。
- `request/context` 快照记录已准备的路由与声明模式；它描述准入结果，而不决定准入。不具备能力的路由逐系统节点记录归并，保留其间的用户、assistant 与工具历史。
- 模型约定按所提供的内容记录。若发布的模型收窄了约定——例如只在有界窗口内兑现最新的系统消息——规则需要序列开始之外的重新基线化触发条件。
- 重写或重排系统消息的代理会静默破坏替换语义；真实 API e2e 的缓存命中断言是探测器。

## Testing

生命周期验证要求：提示词未变更时不产生事件，具备能力的路由在恢复后追加变更后的提示词。TypeScript 与 Python SDK 的期望输出都必须包含带类型的追加 `system/message` 事件，遵循 [SDK 快照策略](../../../../docs/testing.zh.md)。[TypeScript SDK 通知](../../../../snapshots/sdk/system-prompt-in-history/notifications.expected.jsonl)与 [Python SDK 提示词历史](../../../../scripts/snapshots/python-sdk-single-exe/minimal-in-history/prompt-history.json)记录了追加的提示词事件与保留的提示词版本。

- `packages/core/agent-loop/tests/system-prompt-admission.spec.ts` 覆盖文本变化或未变时从具备能力切换到不具备能力的路由、反向路由切换、恢复时的路由准入、请求中间件或准备阶段取消，以及已准备路由保持绑定时并发选择发生变化。重试压缩用例覆盖遮蔽最新提示词后有或没有更早更新存活的情况，并验证复用已接纳的组装结果、用户消息仅接纳一次，以及未变的后续重试不会多记序列 header。具备和不具备能力路由的清除用例会移除三个生效提示词版本，验证重复请求与带 seed 的恢复保持为空且不多记提示词事件，并仅恢复新文本；日志重建与 pi 转换器都不保留旧指令。`src/agent.ts` 与 `src/runtime-context.ts` 的聚焦覆盖率在语句、分支、函数和行四项均达到 100%。
- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` 钉住序列延续时的追加、序列开始时无论是否存在后续存活节点、有效文本是否变化都执行的重新基线化、空提示词对所有生效版本的清除，以及不具备能力时只做替换的行为。
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` 钉住继承 header 下追加的节点及携带 `systemPromptUpdate` 的 `request/context`、序列开始时折回第 0 号节点、由压缩驱动的重新基线化，以及在开启序列的 `change` header 下由工具 schema 变更驱动的重新基线化。
- `packages/llm/llm/tests/service.spec.ts`、`packages/llm/llm-deepseek/tests/adapter.spec.ts` 与 `packages/test-support/llm-replay/tests/llm-replay.spec.ts` 钉住已解析模型信息上声明的模式，以及加载时对任何其他值的拒绝。
- `packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` 钉住最新与中间提示词移除、精确启发式总量、头部改写后的 surface 顺序、额外来源引用、休眠空节点与回退清空、不可变转换、紧凑保留检查点、延迟注册、重放和版本失效。
- `packages/client/ui-conversation`、`ui-chat` 与 `ui-trajectory` 的客户端测试钉住更新卡片、同一步骤 header 的去重、更新之后不存在系统变更，以及合成的轨迹 header。
- 无密钥的手写快照 `snapshots/session/system-prompt-in-history/` 在回放路由上声明该能力，通过 fixture 片段在第一次工具调用之后改变提示词，钉住追加的 `system/message`、未被触及的第 0 号节点、唯一一条 `request/header` 以及 `request/context` 中的模式。
- `packages/llm/llm-deepseek/tests/adapter.e2e.ts` 针对 `DEEPSEEK_IN_HISTORY_MODEL` 指定的模型运行两个步骤并夹带一次提示词变更，断言回复遵循追加的提示词，并断言追加后的请求比同一对话在重写最前提示词时读取更多的缓存 token；该变量未设置时跳过。
