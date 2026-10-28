# Agent Note: 渲染未变的新序列保留存活的系统节点

Status: implemented

[English](2026-10-22-series-start-unchanged-prompt-prefix.md) | 中文

## Problem

在 in-history 路由上，提示词变化会追加为后续的 `system/message`，因此 node 0 保持陈旧，由最新存活节点承载渲染文本。surface 替换（压缩、工具结果剪枝、图片省略）会开启新的请求序列。在渲染文本已经与该最新节点一致时重写 node 0，会清空该节点并把完全相同的文本写进 node 0。于是 wire 请求的第一条消息发生变化，提供方前缀缓存从第一个 token 起未命中，尽管提示词文本没有任何变化。

真实会话 `session-da55bbc9-…` 第 710 轮第 2 步：`compaction/prune` 替换了一条工具结果（seq 34669、34670）；下一次请求写入的 7,618 个字符与它清空的节点完全相同（seq 34672、34673），`request/header` 记录 reason `series`（seq 34674），该步计费 722,332 个未命中输入 token、1,152 个缓存读取 token（命中率 0.16%），而相邻步骤约为 99.9%。第 707 轮的构建更新追加了提示词节点；第 710 轮没有任何东西改变渲染文本。

## Decision

`SystemPromptProjection.project` 只在有效文本必须移动时重写 node 0：不具备能力的路由、空渲染文本，或最新存活非空节点文本与渲染文本不同的新序列开始。当路由为 in-history、渲染文本非空、且最新存活节点已经持有它时，投影不产生任何更新，节点保持在已缓存历史携带它的位置。loop 仍通过 `request/header` 记录请求序列（`series`，或带 `startsSeries: true` 的 `change`），并照旧重建声明；当「渲染未变则跳过」与工具 schema 起因的新序列重合时，header 记录声明变化但不带 `startsSeries`。

重试恢复保持原有保证：重试压缩遮蔽最新节点后，有效文本回退到更旧的节点，与渲染文本不同，于是头节点在用户消息再次被接纳之前重写。投影从不会在已接纳的用户消息之后追加更新。

## Verification

- [`system-prompt-projection.spec.ts`](../../../../packages/core/agent-loop/tests/system-prompt-projection.spec.ts) 固定「能力路由的新序列开始时存活节点文本已一致则不产生操作」的决策。
- [`system-prompt-admission.spec.ts`](../../../../packages/core/agent-loop/tests/system-prompt-admission.spec.ts) 固定 wire 请求：渲染文本未变的压缩替换保留两条系统消息，上一次请求的消息仍构成前缀，相邻步骤重新获得提供方前缀。
- [`in-history-series-start`](../../../../snapshots/session/in-history-series-start/) 录制会话通过 shipped headless profile 回放「提示词变化 + 后续 surface 替换」，固定渲染未变的新序列保留两份提示词版本且不写 `system/message` 事件。

## Alternatives considered

**永远保留追加节点、从不重写。** 更简单，但无法追加提示词的路由、或必须清空的提示词仍需要单一当前头节点；新序列开始时若渲染文本确实变化，也不能在失败尝试已接纳的用户消息之后追加。拒绝。

**只要 head 不同就跳过归并。** 在目标路由变为不具备能力时，陈旧 head 会重新成为权威，因为该路由忽略后续系统节点；决定后续节点是否生效的是路由能力，而不是 head 文本。拒绝。

**让局部 surface 替换不再算新序列。** 剪枝只改一条工具结果的文本，缓存损失是局部的，但图片省略与压缩决定仍合理地开启新序列；投影不应依赖是哪种替换制造了边界。拒绝：提示词决策属于投影。

**比较重建后的请求而不是 surface 文本。** loop 从 surface 事件派生请求，比较历史 wire 消息会重复请求重建，而且仍然需要同样的有效文本比较。拒绝。

## Consequences

- 具备能力的路由在新序列开始后可能在模型历史中保留更早的提示词版本；在被后续归并或压缩遮蔽之前，它们会计入输入 token。
- 不支持工具更新的路由上，工具 schema 变化开启的新序列不再写出 `system/message` 事件，因此其 header 记录声明变化但不带 `startsSeries`。请求仍通过不支持更新的路由投影（`projectToolUpdates`）携带完整的生效声明集合，而 `Session.toolHistory()` 保留其增量基线、不再重置。
- 渲染文本确实不同时归并仍然生效：路由切换、与压缩同时发生的提示词更新，以及遮蔽最新节点的重试。
