---
description: "面向用户与维护者的具备回放感知的 token 与上下文压力计量说明：评估提示词规模或构建压缩与占用显示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-meter

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-token-meter` 是具备回放感知的 token 计量服务：`ctx.tokenMeter` 从持久事件日志为每个会话推进一个隔离 fold，因此压缩（compaction）与其他压力敏感插件可以共享同一份计量，无需依赖压缩引擎。借助它，你可以测量当前请求与上下文压力、为单条消息计价，并在挂载会话投影 seam 时读取 `tokenUsage`、`contextPressure` 与 `contextBreakdown` 投影。文本和未声明图片定价的路由使用固定启发式规则，存在时应用适配器声明的视觉 token 定价，文件则按请求组装实际发送的 handle 文本计价；只有请求 envelope 完全匹配时才复用提供方报告的用量。它不添加任何自己的提示词、消息、schema 或工具，也绝不为 loop 做决定。

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

当消费方需要为压缩决策、占用显示或遥测获取 token 或上下文压力时挂载本插件。估算器没有任何配置，也不添加模型可见表面；模型容量属于拥有精确提供方／模型路由的适配器，可通过 `ctx.llm.resolveModelInfo().context` 获取。

### 何时选择

当多个插件应该就同一种基于回放的测量达成一致时选择它——压缩规划、占用 UI 与压力检查都读取同一个 fold。测量回放持久会话日志，因此确定、无需模型调用，并精确反映已记录内容。文本和未声明图片定价的路由使用固定启发式规则；当部署需要精确到计费级别的计数时，使用提供方分词器。

### 测量压力

`ctx.tokenMeter` 暴露两个操作。`measure(session, requestHeader?)` 在同一个已消费日志 revision 上返回独立、深度不可变的快照：`totalTokens` 是请求与响应压力，`surfaceTokens` 是仅表面的路由定价总量，等于 `nodes[].tokens` 之和。可选 `requestHeader` 覆盖会选择计价路由与压力字段；节点集合仍描述当前会话。`estimateMessage(message)` 用固定启发式规则为一条消息计价。每次调用都会克隆带位置的表面节点，因此测量是 O(surface)。

```text
const { totalTokens, surfaceTokens, nodes } = ctx.tokenMeter.measure(session)
const price = ctx.tokenMeter.estimateMessage(message)
```

每次测量都会通过可选的 `llm` 服务解析生效 envelope 的提供方／模型。适配器声明图片定价时，图片出现处使用路由请求的视觉 token 价格加模型可见文本；其他路由保持固定启发式规则。文件出现处使用同一个 `llm` 服务为适配器分发解析的确切、与路由无关的 handle 文本，其中包含当前执行世界路径或明确的无路径说明。每个节点还携带与路由无关的 `heuristicTokens`，供替换影子价使用。只有当最新成功调用的规范请求 envelope 与已测量 envelope 匹配、且其总量不低于该调用完整路由定价锚点时，才复用提供方用量；否则会对完整当前 envelope 与表面做估算。表面变更保持相对于按同一路由重新定价的匹配锚点的带符号值，包括缩减替换后的负 delta。

### 会话投影

当组合提供 `ctx.sessionProjections` 时，token-meter 注册三个投影单元。`tokenUsage` 携带完整持久日志中的 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens` 与 `cacheWriteTokens`。最终 assistant 消息样本会替换同一次尝试的流式用量；`llm/retry-started` 会结束该替换范围，因此同一步骤中的重试会贡献另一次计费用量。`contextPressure` 携带可选 `pressureTokens`（提供方报告的最新提示词规模）、可选 `projectedTokens`（下一个请求的提示词将花费多少）与来自最新一条 `request/context` 记录的可选 `contextWindow`。`contextBreakdown` 携带启发式 `systemTokens`、`toolsTokens` 与 `messageTokens`——上下文的构成，而非提供方计费规模。卸载插件会移除全部三个键。

`contextBreakdown` 携带启发式的 `systemTokens`、`toolsTokens` 与 `messageTokens`，描述上下文的组成而非提供方计费规模。envelope 数字在每条 `request/header` 上按后者胜重新计价；消息数字重放与 `contextPressure` 相同的 O(1) 影子价折叠，因此在完整计量的日志上，它在每个事件边界都等于 `measure().nodes[].heuristicTokens` 之和，压缩会按记录的影子价缩小该值。请求定价的 `measure().surfaceTokens` 在路由模型重新为图片计价或请求组装把文件投影成 handle 文本时会与该值不同。若替换前没有紧邻的影子价声明，这个有界投影会保持不变，因为它无法重建被替换区间。三个数字都使用测量服务的固定启发式规则，属于估算值。它们加起来不等于 `projectedTokens`，后者的提供方锚点包含组成数据仍有的误差，其中按「4 字符约等于 1 token」计价会严重低估 CJK 文本与 JSON schema。请把它们当作近似的**组成**呈现，不要当作总量。

`deriveTurnTokenUsage(events)` 为浏览器消费方把一个完整 Turn 折叠为精确的逐次尝试与整轮用量。生命周期证据缺失、计数不安全或精确总量矛盾时不返回结果；只有每次参与的尝试都报告可选缓存、推理或路由值时，相应汇总才会出现。

### 组合

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

两个插件都有可用默认值。meter 只消费可选的 `llm` 服务，且仅用于解析路由声明的请求图片定价；压缩保持可选。部署会在 LLM（大语言模型）适配器上配置容量与图片定价，并在 `dsh-compaction-basic` 上配置压缩策略。

### 解读数字

占用是参考数字，不是计费记录：harness 中没有任何机制依据它做决定，压缩读取的是 `measure()`。UI 用测量压力除以所选模型独立解析的容量来计算占用。`contextBreakdown` 数字是估算值，不会与 `projectedTokens` 相加，后者的提供方锚点恰好携带启发式误差——CJK 文本与 JSON schema 在每 token 四字符下严重低估。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

服务建立在一个 fold 与一个锚点之上。每个会话都有隔离的回放状态——已消费事件游标、规范请求标头、已计价表面、步骤边界与测量锚点——通过折叠持久日志推进。只有当提供方用量的规范 envelope 匹配、且其总量不低于同一次调用的完整路由定价时，才用它锚定测量；否则会估算完整 envelope 与表面。与路由无关的 `heuristicTokens` 字段使替换影子价投影保持确定性。fold 是整体且分配全新的：格式错误事件会在任何变更前抛出，因此同一份日志每次重试都以相同方式失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `TokenMeter` 服务：回放状态、fold、`measure()` 与 `estimateMessage()` |
| [`src/estimate.ts`](src/estimate.ts) | 固定启发式规则：每 token 四字符加块与角色开销 |
| [`src/surface-fold.ts`](src/surface-fold.ts) | 与 `measure()` 共享的位置表面 fold |
| [`src/surface-projection.ts`](src/surface-projection.ts) | O(1) 投影单元的影价协议 |
| [`src/usage-projection.ts`](src/usage-projection.ts) | `tokenUsage` 与 `contextPressure` 投影定义 |
| [`src/breakdown-projection.ts`](src/breakdown-projection.ts) | `contextBreakdown` 投影定义 |
| [`src/client.ts`](src/client.ts) | 投影消费方的浏览器安全客户端表面 |
| [`src/turn-usage.ts`](src/turn-usage.ts) | 精确逐次尝试与逐 Turn 用量的纯 fold |

### Fold 流程

每次 `measure()` 调用都把 fold 同步到当前持久尾部，然后读取一份连贯快照。fold 跟踪完整请求标头快照、步骤边界、表面追加与替换、成功 assistant 消息、提供方用量，以及每条 assistant 消息引用的分片 seq。用量锚点的提供方输出从精确引用的分片 seq 重新组装；显式空列表表示已知空提供方流，而缺失的遗留列表保守地把持久 assistant 输出视为提供方输出。

### 投影语义

投影单元不共享完整表面 fold，因为其持久状态必须保持 O(1)。`surface-projection.ts` 为追加计价，并消费紧邻替换之前记录的影价；它只保留一个运行总量与至多一个待处理 claim，不保留逐节点价格。因此完全计量的日志在每个事件边界都与 `measure()` 的 plan/commit fold 一致。没有相邻匹配 claim 的替换保持有界投影不变，因为投影无法重建被替换范围。单一最后用量样本槽依赖一条会话日志顺序性质：一旦更晚的步骤报告用量，合法日志绝不会再为更早步骤报告用量。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从计量服务逐步进入压缩消费方与共享类型。

- [Token 计量子系统](../../../docs/subsystems/token-meter.zh.md)——`ctx.tokenMeter` 背后的测量语义。
- [dsh-llm 服务](../llm/README.zh.md)——其容量元数据由 `resolveModelInfo()` 提供的模型调用服务。
- [压缩能力](../../../docs/subsystems/compaction.zh.md)——读取 `measure()` 的压力敏感消费方。
- [投影 token 用量](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)——`projectedTokens` 背后的设计与被否决的原子配对比较。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——本服务计价的消息与块类型。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-compaction-basic` 等消费方；服务本身不添加任何提示词、消息、schema、工具或模型调用。

#### KV Cache 影响

不直接失效；任何请求前缀变更都由点名的消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明计量在哪里停止、由未来工作接续。它们是当前包约束，不是通用 token 计量对比或任务积压。

- **固定启发式规则是近似值**——没有可复用提供方用量的文本按字符数加结构开销计价，而非精确提供方分词器或请求序列化器；只有声明了定价的路由上的图片出现处携带提供方精确的视觉 token。
- **每次测量都克隆当前表面**——连贯不可变快照让读取为 O(surface)，包括低于阈值的压力检查。
- **提供方用量只在规范 envelope 完全相同时可复用**——提示词、前缀、工具、提供方、模型或调用配置变化会刻意回退到完整启发式估算。
- **缺失遗留源 seq 时保守处理**——没有 `sourceEventSeqs` 的 assistant 消息无法区分提供方输出与监听器改写，因此 fold 不会声称已知空或精确分片流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 固定每 token 四字符启发式规则会低估 CJK 文本与 JSON schema；复用用量时提供方锚点恰好携带该误差，请把构成行呈现为近似构成，绝不呈现为总量。
- 按提供方的精确分词器尚未决定；保持单一确定性启发式规则，正是让每个消费方的测量一致且回放稳定的原因。

</details>

**运行时不变式：** 不发布伴生入口。token estimate 是按调用输出，私有 Session cache 在事件变更处失效；其 projection 与计价均来自同一 schema 和 heuristic，没有可独立交叉核对的运行时关系。
