---
description: "实验性会话视图：按轮次与步骤展示上下文大小、首 token 延迟、模型与工具耗时、缓存命中率和输出速度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-stats

[English](README.md) | 中文

## 概述

在「对话」和「轨迹」旁边加一个「统计」页签。每轮一行，展开后列出各步的上下文与输出词数、缓存命中率、首 token 延迟、模型与工具用时、输出速度和总用时条；滚到顶部通过共用 Session 分页加载更早轮次。「触发」列说明这一轮由什么触发，团队消息会写明发送方；带图提问显示张数标签，悬停预览、点击在共用看图器中打开。页签只读会话事件和提问里的持久图片，不注册工具、提示词段落或服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂到已经提供 `slots`、`uiConversation`、`locale` 的客户端组合里。它向 `conversation.view` 槽贡献一个条目，没有配置字段。

### 何时选择它

需要按提示词长度、缓存复用情况和总时间去向比较轮次或步骤时选它。需要完整事件清单、请求头和工具正文时选 `@deepseek-ai/dsh-client-ui-trajectory`；两个页签读同一份会话，可以同时启用。

### 最小配置

```yaml
- id: ui-stats
  name: '@deepseek-ai/dsh-experimental-client-ui-stats'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

六个 Conversation Definition 把事件窗口折叠成名为 `stats` 的视图目标节点。`stats-step` 每个 `step/start` 一个上下文；`stats-prompt` 每条唤醒该轮的用户消息（人写提示或自动触发）一个上下文；`stats-turn-end` 记录轮次边界，让被中断的尾部也能收尾；`stats-code-mode` 每个 Code-Mode 根调用一个上下文，收纳它实际派发的内层调用；`stats-compaction` 每个压缩事务一个上下文；`stats-event` 负责请求、提示词、重试、审批和裁剪等非步骤事件行。轮次与步骤身份取自引擎给出的 match Location，而不是模块级状态，因此历史分页和多个 Session 都不会串归属。

| 文件 | 职责 |
| --- | --- |
| `src/client/stats-definition.ts` | 六个 Definition：匹配规则、发布节奏与节点信封 |
| `src/client/stats-fold.ts` | 事件折叠、工具配对、Code-Mode 内层调用归属、单步指标 |
| `src/client/stats-aggregate.ts` | 轮次汇总与排序，含被中断尾部的收尾 |
| `src/client/stats-compaction.ts` | 压缩事务状态与合成摘要行 |
| `src/client/stats-event.ts` | 非步骤事件行的归一化 |
| `src/client/stats-format.ts` | 时间、耗时、token、百分比的显示格式化 |
| `src/client/stats-usage.ts` | 步骤、压缩与合计共用的 token 用量推导 |
| `src/client/stats-totals.ts` | 从宿主 stats 与 tokenUsage projection 生成全量合计 |
| `src/client/stats-snapshot-builder.ts` | `stats` 视图目标的增量 builder |
| `src/client/StatsView.tsx` | 表格、合计/事件行、时间条、步骤/工具/回答详情、复制按钮，以及提问图片标签、预览与看图器 |
| `src/client/locales.ts` | 全部可见文案，覆盖 8 种 shipped 语言 |

页脚的开关控制合计行、事件行与上下文口径，滚表格时页脚钉在输入框上方。「显示上下文增量」默认关闭；打开后每轮/每步显示相对同范围内上一个已测值的提示词大小变化，负增量（例如压缩后）用错误色显示。展开的步骤行在「触发」列显示该步开始时间戳（`MM-DD HH:MM:SS.mmm`，tooltip 为完整的 `YYYY-MM-DD HH:MM:SS.mmm`），以及距上一步至少一秒的空闲；亚秒级调度噪声不显示。带模型回答的步骤也可以展开：点击该行会打开详情行，通过共享的 Chat Markdown 原语渲染回答，最多保留 16,000 字符并提示截断。

「上下文口径」只改变轮次行对其各步的聚合方式：「最新」显示该轮最后一步的提示词大小，「累计」显示该轮各步提示词大小之和。合计行不受这个开关影响。宿主提供 `sessionStats` 与 `tokenUsage` projection 时，合计行覆盖整段会话：轮次、步数、累计上下文与输出、token 加权缓存、首 token/模型/工具用时和输出速度；总用时为模型用时 + 工具用时（暂无整段墙钟 projection）。projection 不可用时回退到已加载窗口，并标为「本窗口合计」。token 超过一千万时从 K 切换为 M。

非步骤行默认隐藏，由页脚的「显示事件行（含压缩）」开关打开。压缩是 log-only 事务，不是 step。表格会在压缩发生的相邻步骤之间插入一条合成的「压缩」行，显示摘要调用的上下文、输出与缓存命中、被压缩的 token 数、摘要大小和墙钟时间。同一个开关还会显示请求头、路由能力、系统提示词、工具集变更、模型重试、模型尝试、上下文刷新、审批和纯裁剪行：请求头显示 reason、provider/model、是否新序列和工具数；路由能力显示 provider/model 和提示词更新模式；系统提示词显示追加/替换/清空和字符数；工具集行列出新增与移除；重试行显示第几次、等待时间和失败信息；尝试行标记未提交消息的模型尝试；上下文刷新行显示运行时/时间上下文的刷新大小；审批行显示工具和等待/允许/拒绝状态；裁剪行显示被裁剪的 token 数。这些行不计入轮次与合计的步骤求和，步骤列仍只表示步骤。

轮次的缓存命中率按报了 usage 的各步做 token 加权（缓存读之和 ÷ 提示词 token 之和），不会因为相邻步命中高就把某一次冷启动盖掉；tooltip 展示汇总后的读/输入/写明细。步骤行仍显示该步自己的实测比例。

会话窗口是有界的：某一步的 `step/start` 不在已加载窗口里时，与起点有关的列显示 `—` 并标「起止未知」，不估算数值。滚到顶部会向 Session 请求更早的一页；视图按新增内容的高度补偿滚动位置，正在读的行不会跳走。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-client-ui-trajectory`](../../client/ui-trajectory/README.zh.md) —— 本页签的表格约定参考它。
- [`@deepseek-ai/dsh-session-stats`](../../session/session-stats/README.zh.md) —— 列名口径与会话统计一致。
- [`docs/subsystems/conversation.md`](../../../docs/subsystems/conversation.zh.md) —— 视图目标与 Definition 的装配方式。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为页签只读会话事件并在浏览器里渲染，不注册工具、提示词段落或模型输入。

#### KV Cache 影响

没有影响。本包不构造模型请求，也不修改提示词。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **默认产品不挂载。** Web 包按规则拒绝引用 experimental 包；可选的「开发者工具」组合包（`@deepseek-ai/dsh-experimental-inspector-profile`）会挂载本视图，也可以由 profile 显式添加。
- **窗口被截断时没有起始时刻。** 已加载窗口从半步中间开始时，首 token、模型用时和总用时都推导不出来；行上标「起止未知」，不估算。
- **Code-Mode 内层调用按根调用上下文并回步骤。** 内层调用不带 turn/step，因此每个根调用各自开一个以 root call id 为键的上下文，由 builder 把它的派发并回持有 runner 的那一步。窗口里丢了派发起点时仍会合并调用，但无法给出它们各自的实测耗时。
- **更早历史的加载结果显式区分重试。** 页面请求只返回 `grew`、`exhausted` 或 `retry`；如果 Chat 或轨迹视图正在加载同一个 Session 的页，统计视图会保留加载按钮，而不是误报历史已耗尽或抛出错误。
- **已知限制：没有整段墙钟 projection。** 合计行的总用时用模型用时 + 工具用时替代，因为宿主 projection 没有整段墙钟；工具段是逐调用求和，并行调用会让这段显得比非重叠墙钟更长。这里作为已知限制记录，插件不为此改动宿主逻辑。
- **本实验 PR 的 recorded-session 覆盖已获豁免。** 包测试覆盖折叠、聚合、格式化、分页与 jsdom 表格；`apps/web/tests/client-ui-stats-panel.e2e.ts` 通过仅测试用的 overlay 挂载 shipped Web 表面并比较已提交的 ARIA golden。经 owner 决定，本实验 PR 不新增 keyless recorded-session 场景；后续 profile 或 bundle 转正时必须补充。
- **迟到重投不是轮次。** 压缩可能把被裁剪的工具结果按原来的轮次/步骤在之后重新投递；窗口里既没有加载到的起点、也没有问题或结束标记的轮次会被丢弃，不再显示成空的幽灵行。
- **计时是推导值。** 总用时取最后一步结束减第一步开始；排队和调度等待落在「其余」段里。总用时条把工具调用画成配对区间之并，并行调用只算一次；工具列仍显示逐次求和。轮次时间条以当前屏幕内可见的轮次为刻度，滚出屏幕的超大轮次不会把本屏的行压扁。
- **提问图片走共用图片缓存。** 标签与预览用 `uiConversation.imageUrl` 解析持久附件，浏览器 URL 由缓存按 Session binding 持有并释放，视图不自己创建 URL。读取失败时显示本地化失败状态并可重试。触屏不打开悬停预览，点击标签会直接加载第一张图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本页签从一份独立的客户端插件移植而来。列名口径参照 `@deepseek-ai/dsh-session-stats`（模型用时、工具用时、首 token、输出速度），版式参照轨迹表格，让两个页签读起来一致。

</details>

**运行时不变式：** 不发布伴生入口。全部状态都从会话事件窗口推导，独立观察只会重复注册与折叠逻辑，而不会断言另一种关系。
