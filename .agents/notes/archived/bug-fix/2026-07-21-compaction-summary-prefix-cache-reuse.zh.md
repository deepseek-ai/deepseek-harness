# Agent Note: 摘要调用回放对话前缀以复用 KV Cache

Status: implemented
Archived: 2026-09-04

[English](2026-07-21-compaction-summary-prefix-cache-reuse.md) | 中文

## 问题

自动压缩（compaction）在对话中途触发，恰好在循环用最后一个已路由请求（`system` + `tools` + 派生历史）预热了提供方的 KV Cache 之后。随后默认摘要器发出一个*独立的*辅助请求，其前缀与那个已预热请求没有任何共享部分：一个专门的摘要器 `system` 提示词，后接被拍平成单个渲染后 transcript（文本记录）字符串的较早历史。提供方基于请求起始的 token 序列做缓存，因此第一个 token 只要不同（即一个不同的系统提示词），整个已缓存前缀就会失效。于是每次压缩都要为整段回放的历史付出两次完整的提示词处理成本：一次用于触发压力的对话请求，另一次用于摘要调用，恰好在对话最大时让缓存失去作用。

## 决策

摘要指令从请求的**前端**（一个全新的 `system` 提示词）移到对话的**末尾**（最后一条 `user` 消息）。辅助调用现在逐字复现最后一个已路由请求的前缀，并追加一条尾部指令，因此它是已预热请求的真正前缀扩展，提供方会复用已缓存的 token。

### `SummarizationInput` 携带回放的前缀，而非渲染后的字符串

`summarize()`（以及内部的 `summarizeWithLlm`）接受一个 `SummarizationInput`（`{ system?, tools?, messages }`）而不是一个扁平的 transcript 字符串。`region.ts` 用 `session.requestHeader()`（持久的 `system` 和 `tools`）加上经 `session.deriveEventMessage` 映射的被遮蔽区域来构建它，后者产出与 `deriveMessages()` 折叠进已路由请求的内容字节级一致的 `Message` 对象。`summarizeWithLlm` 把 `system` 和 `tools` 转发到 `GenerateOptions`，并发送 `[...input.messages, { role: 'user', content: COMPACTION_INSTRUCTION }]`。`tools` 会一同带上，即便摘要器从不调用任何工具：丢弃它们会缩短 token 序列，破坏与已缓存请求的对齐。

### 指令是一条尾部 user 消息

`COMPACTION_INSTRUCTION` 以 "You are now acting as a compaction engine…" 开头，指示模型浓缩*上方的对话*。它保留先前检查点的结构化标题，并在其新位置上新增了两条前置系统提示词此前不需要的规则：不要提及摘要请求，以及只输出检查点文本而不调用任何工具。被遮蔽区域总是结束在工具配对平衡的边界上，因此在其后追加一条 `user` 消息，对 OpenAI 兼容适配器和 DeepSeek 适配器而言是合法的消息排序。

### 缓存复用是尽力而为，正确性则有保证

自动压缩总是锚定在表层头部，因此被遮蔽区域就是已路由请求的头部，回放的前缀与之完全匹配，这就是保证命中的情形。手动的中段 `compactRegion` 仍然回放真实的前缀并保持正确，但会放弃复用，因为它的被遮蔽区域不是请求头部。配置的 `summarizationProvider`/`summarizationModel` 若与对话的路由不同，也会放弃复用；这是部署方明确的权衡，而非缺陷。目标解析（配置的覆盖值 → 最新的已路由 header → agent（智能体）选项，否则抛出）保持不变。

## 考虑过的替代方案

- **保留摘要器系统提示词但复用其余部分**——否决：system 槽位正是提供方最先做缓存的 token 区域，因此一个不同的摘要器系统提示词无论后面跟着什么都会使整个前缀失效。只有把指令移离前端才能恢复缓存。
- **只发送被遮蔽区域而不带 `system`/`tools` 头部**——否决：头部不同的序列在第一个 token 处仍然与已缓存请求分叉，因此缓存效果并不更好，反而丢失了摘要所需的框架。
- **从摘要请求中省略 `tools`**（模型从不调用任何工具）——否决：工具 schema 是已缓存 token 序列的一部分；省略它们会让后续每个 token 失去对齐，破坏复用。
- **为 snapshot replay 专门建立 Agent-backed summarization sub-session**——否决：持久 `compaction/summary` event 会记录成功本地调用的位置与完整输出，显式 call marker 可防止 replay 把 template 或 remote output 当作本地 stream。仅为获得 Assistant settlement 而创建 sub-session 会增加无关 lifecycle。

## 后果

- **`dsh-compaction-basic`** 拥有 `SummarizationInput`；受保护的 `summarize(input, agent, signal?)` 钩子签名发生变化（发布前可接受），并且 `region.ts` 新增了 `buildSummarizationInput`，它在 header 前缀之后对被遮蔽的 seq 折叠 `deriveEventMessage`。
- **移除无用的渲染表面。** 旧的拍平路径（`renderTranscript` / `renderContentBlocks` 及其在 `dsh-compaction` 中的 spec）已无消费方，连同其导出一并删除。
- **README 的 Model Experience** 现在把 `dsh-compaction-basic` 的辅助请求记述为回放的前缀加上一条尾部压缩指令消息，并把其 KV Cache 效果记述为复用已预热的对话前缀。
- **带框架的检查点输出未改变**，因此落地的 `user/message` 和每个对话请求快照都不受影响；只有辅助请求的形状发生了变化。

## 测试

- **单元：** `compaction-basic.spec.ts` 断言辅助调用转发 `system`/`tools`/前导消息，并把压缩指令作为最后一条消息追加，且 `compactRegion` 回放最新的已路由 header 前缀。现有的内容断言通过回放的消息而非 transcript 字符串来读取摘要器输入。
- **循环：** `compact-loop-repro.spec.ts` 依据摘要请求尾部 user 消息中的压缩指令对其分类，溢出恢复测试则继续在真实循环中固定对话请求与摘要请求的数量。
- **快照：** 无密钥回放会从带标记的 `compaction/summary` 重建一条规范成功流；[compaction-seam Agent Note](../feature/2026-06-18-compaction-capability-seam.zh.md) 负责持久标记约定。
