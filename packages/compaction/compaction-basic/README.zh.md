---
description: "面向部署方的自动会话压缩：选择、调优或排查随 token 压力上升如何把较早历史摘要为总结。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-basic

[English](README.md) | 中文

## 概述

`dsh-compaction-basic` 让长时 agent 会话在接近模型上下文上限时仍能正常工作。token 压力上升时，它会自动把对话最旧的部分压缩为摘要，并保持近期部分完整；上下文溢出错误发生后，它会压缩并重试。你也可以通过 `dsh-command-compact` 的 `/compact` 按需压缩，并挂载 `dsh-compaction-tool-result-pruner` 先修剪超大工具输出。压缩的代价是一次额外的模型请求，它读取所选历史并写出摘要；只有摘要文本会被保留。它只压缩派生历史——无法缩减系统提示词、工具或会话前缀，也无法拆分单个不可分单元（例如一次超大工具调用）。

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

在已提供 LLM（大语言模型）、会话存储与 token 测量的组合中挂载本包，即可获得自动会话压缩。随附 `dsh` 基础配置默认启用它；需要控制压缩发生的时机时请显式挂载。

### 你会得到什么

默认设置下你会获得四种行为：会话向模型上下文上限增长时自动压缩；提供方确认上下文溢出错误后的恢复（先压缩再重试该请求）；通过 `/compact` 命令按需压缩；以及——挂载修剪器时——压缩前对超大工具输出的修剪。

### 最小可用组合

挂载会话存储、token 测量、可选修剪器、本后端，以及可选的按需命令：

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

你可以通过观察会话越过本来会溢出的位置继续工作、以及运行 `/compact` 立即压缩一次来确认成功。如果组合缺少 LLM、会话存储或 token 测量，插件会加载失败。同一个后端可以服务上下文大小不同的模型；用按模型覆盖为每条路由设置各自的阈值与保留：

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    modelPolicies:
      - provider: local
        model: small-context
        thresholdRatio: 0.7
        retainTokens: 2048
```

### 调整压缩开始的时机

所有设置都可选。默认在已路由模型上下文窗口的 80% 处开始压缩，并逐字保留最新的 16%；下表是完整的策略面，生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-basic)是穷尽式真源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 在 `floor(routedContextWindow × ratio)` 处开始压缩。 |
| `retainRatio` | `0.16` | 以已路由上下文窗口的一部分表示逐字保留的近期对话；与 `retainTokens` 互斥。 |
| `retainTokens` | — | 逐字保留的近期对话绝对预算；与 `retainRatio` 互斥，并且必须低于已解析阈值。 |
| `summarizationProvider` | `''` | 与 `summarizationModel` 一起设置；空对使用最新已路由请求目标，再回退到 `AgentOptions` 对。 |
| `summarizationModel` | `''` | 与 `summarizationProvider` 一起设置；空对使用最新已路由请求目标，再回退到 `AgentOptions` 对。 |
| `maxTokens` | `8192` | 摘要请求的输出上限；可包含推理 token。 |
| `compactionRetries` | `1` | 压力仍高于阈值时，在首次压缩后进行的额外尝试次数。 |
| `maxOverflowRetries` | `1` | 已确认上下文窗口溢出后的最大重试次数；`0` 只禁用恢复。 |
| `modelPolicies` | `[]` | 针对个别模型路由的精确 `{ provider, model, ...partialPolicy }` 覆盖。 |
| `auto` | `true` | 启用自动压缩与溢出恢复；设为 `false` 则仅手动执行。 |

配置错误会快速失败：未知设置、重复的按模型覆盖、两种保留形式同时出现，或比例保留量不低于阈值，都会在加载时拒绝插件。任何绝对 `retainTokens` 预算——顶层或按模型——不低于其阈值时，都会在该模型首次使用时失败，因为该比较需要模型的上下文大小。

### 压缩运行时会发生什么

最旧的平衡范围会被替换为一条摘要消息，近期尾部保持逐字不变；对话从摘要继续。操作会报告压缩了多少历史项以及估算释放的 token 数。如果没有任何内容可以安全压缩——例如整个对话就是一个不可分单元——则不会有任何改变，也不会向会话日志写入任何内容。如果没有模型可以撰写摘要（既未配置目标，也还没有已路由请求），压缩会失败并给出清晰错误，提示你配置摘要提供方与模型，或先路由一次请求。

### 通过 /compact 按需压缩

挂载 `dsh-command-compact` 后，在聊天 UI 中输入 `/compact` 即可立即压缩，即使未达到压力阈值。命令会报告压缩了多少历史项以及估算节省的 token 数。当 agent 正在轮次中或压缩已在运行时，`/compact` 会报告压缩暂不可用；运行期间你发送的提示词会被接受，并在压缩结束后才开始。

### 修剪超大工具输出

在本包之前挂载 `dsh-compaction-tool-result-pruner`，即可在压缩过程中修剪超大工具结果。修剪不发起模型调用，并可能完全省去摘要：当修剪后的对话在阈值之内时，压缩会跳过摘要。修剪只在压缩触发条件满足后运行——低于压力的对话绝不会被触碰。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该后端建立在四项承诺之上：

- **一个测量服务为每个决策定价。** 单例 `ctx.tokenMeter` 会在同一个已消费日志 revision 上测量最新规范已记录 envelope 与当前表层。路由适配器声明请求图片定价时，meter 会将其应用于图片历史。压力、近期尾部保留、范围选择与缩减验证使用同一套路由定价的节点数值；已记录的替换影子价仍使用与路由无关的启发式规则，使纯投影 fold 保持一致。
- **日志记录的标记对就是事务。** 所有入口点共享一个先记录标记的区域事务：验证范围与活动锁，同步追加 `compaction/start`，准备并等待摘要，重新验证，再追加 `compaction/summary` 与替换，最后恰好进行一次闭合尝试。自动调用与显式范围调用要求数字标识的开放轮次归属与整个表层稳定；`compactNow()` 会预留空闲接纳，使用 `turn: null`，允许所选 span 之外追加仅追加上下文，flush 每次已闭合尝试，并在 `finally` 中释放接纳预留。
- **摘要复用提供方的热前缀。** 逐字回放上次已路由请求的系统提示词、工具与已遮蔽区域消息，使辅助调用成为会话的真正前缀，因此只有尾随指令与摘要输出未缓存。
- **`summarize()` 是唯一的子类钩子。** 基于模板或远程摘要器的子类可以覆盖它，同时压力、保留、被引用的源事件、缩减验证与已遮蔽 token 计量仍由 token meter 负责。

### 自动触发与溢出恢复

当 `auto: true` 时，串行 `agent/pre-step` listener 会在请求派生前检查压力：它通过 `ctx.tokenMeter` 为最新持久路由请求 envelope 定价，当压力越过路由模型的阈值时，先剪枝，再在保留已定价近期尾部的同时摘要最旧的平衡范围。`agent/request-error` listener 响应提供方确认的 `CONTEXT_WINDOW_EXCEEDED`：它绕过常规阈值与保留策略，尝试一次最大平衡头部缩减，并且只在表层替换 generation 前进后才授权重试。取消全程保持最终决定权。

压力策略从拥有持久路由的适配器解析容量。适配器无法为有效动态路由返回容量时，手动压力路径会抛出目标特定配置错误；自动 listener 会对该精确目标警告一次，并携带完整历史继续。

### 摘要机制

直接 `ctx.llm.stream()` 调用使用已配置的提供方／模型对与上限，回退到最新已记录请求目标，然后再回退到 `AgentOptions` 对，而不运行仅用于 agent loop 的 `agent/request` 扩展点。该调用逐字回放会话自身的系统提示词、工具与已遮蔽区域消息——包括所选适配器必须解析或明确拒绝的图片引用——并将压缩指令作为最后一条 user 消息追加，从而复用提供方的热前缀 cache，而非使它失效。调用将 `GenerateOptions.purpose` 设为 `compaction`；只有返回文本进入检查点，推理与工具调用都会被排除。图片输出会以 `UNSUPPORTED_CONTENT` 失败，而不是消失。替换 user 消息用 `<compacted-summary>` 标签框定摘要；原始摘要保留在 `compaction/summary` 事件上。

### 区域事务

事务验证表层范围与持久锁，追加 `compaction/start`，通过钩子生成摘要，重新验证稳定性（自动调用要求整个表层、手动调用只要求所选范围），拒绝不缩小源内容的摘要，追加 `compaction/summary` 与替换 `user/message`，并恰好进行一次 `compaction/end` 尝试。活动的未匹配 start 是持久锁：位于较新 `session/end-seed` 之前的未匹配标记是先前生命周期留下的陈旧证据，不会阻塞；位于该边界之后的标记报告 `busy`。闭合失败会有意留下阻塞性的未匹配标记。完成清理与持久化后，取消仍具有最终决定权。

### 配置解析

`resolveConfig` 验证并分离默认值，`resolveTargetPolicy` 将精确的提供方／模型覆盖合并到默认值之上，`resolveCompactSpec` 使用适配器拥有的上下文容量将合并后的策略缩放为具体 token 预算。策略解析绝不咨询模型发现（`listModels()`）；只有持久路由的容量才重要。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`BasicCompactionEngine`、自动 listener、入口点分发 |
| [`src/region.ts`](src/region.ts) | 保留选择与共享的先记录标记压缩事务 |
| [`src/summarizer.ts`](src/summarizer.ts) | 默认 `ctx.llm.stream()` 摘要、检查点框定、安全摘要投影 |
| [`src/config.ts`](src/config.ts) | 加载时验证与路由模型策略解析 |
| [`src/types.ts`](src/types.ts) | `BasicCompactionConfig` 与已解析策略词汇 |
| — | 不发布运行时不变式伴生入口；持久标记对可在会话日志中观察。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从共享 seam 逐步进入可选配套工具与决策证据。

- [压缩 seam](../compaction/README.zh.md)——本后端实现的压缩约定。
- [压缩子系统参考](../../../docs/subsystems/compaction.zh.md)——压缩词汇、结果与服务行为。
- [工具结果修剪器](../compaction-tool-result-pruner/README.zh.md)——先修剪超大工具输出的可选配套工具。
- [人类 /compact 命令](../command-compact/README.zh.md)——无需等待压力的按需压缩。
- [Token meter](../../llm/token-meter/README.zh.md)——决定何时压缩的测量服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-basic)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 会话历史

#### 模型看到的内容

成功步骤越过阈值后，如果已加载可选修剪器，超大工具结果会先被改写。如果仍需摘要，下一个请求会收到下方检查点前导、一个空行、`<compacted-summary>`、根据数据生成的摘要以及 `</compacted-summary>`。溢出恢复会根据使表层前进的任何替换重建立即重试。检查点会替换已选较早范围，后面跟随已保留的近期单元。

##### 会话检查点前导

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token 影响

不依赖模型的剪枝可以完全避免辅助调用；否则它会在摘要替换较早范围之前缩减该调用的 transcript（文本记录）。替换会缩减未来输入历史，而非追加第二份副本。摘要会保留到后续压缩将其替换，但不可分的非工具单元仍可能超出预算。

#### KV Cache 影响

它是替换，而非仅追加。每个检查点都会使从第一个已替换历史 token 起的复用失效；该范围之前未更改的请求前缀仍可复用。

### 辅助摘要器请求

#### 模型看到的内容

摘要模型会接收逐字回放的会话：与上次已路由请求为已遮蔽区域发送的相同系统提示词、工具 schema 与消息，后面跟随一条最终 user 消息，即下方压缩指令。会话模型绝不会看到该私有请求或其推理；只有返回文本会被存储。

##### 压缩指令（最终 user 消息）

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

#### Token 影响

这是一次独立模型调用：输入是已回放会话前缀加固定指令，输出受 `maxTokens` 限制。收敛重试可能多次支付这项成本。

#### KV Cache 影响

已回放系统提示词、工具与已遮蔽区域消息与会话最后一个已路由请求逐字匹配，因此提供方的热前缀 cache 可复用至尾随指令之前；只有该指令与摘要输出未缓存。将摘要器路由到不同提供方／模型，或压缩非头部范围，都会放弃该复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明自动压缩何时不合适，或何时需要特别注意；它们是当前包约束。

- **计量准确度取决于固定启发式规则**——可复用提供方用量缺失时，会回退到字符数加结构开销，而非精确的 token 化；只有在适配器声明了请求图片定价的路由上，图片出现处才携带提供方精确的视觉 token。
- **溢出分类由适配器维护**——提供方措辞可能改变；两个 DeepSeek 适配器将可识别的上下文限制失败规范化为 `CONTEXT_WINDOW_EXCEEDED`。
- **部分不可分单元与仅 envelope 溢出仍不在表层压缩范围内**——恢复无法缩减系统／工具／前缀、拆分不可分的非工具节点，或修复不可剪枝剩余部分仍超出窗口的工具单元。可选 pruner 可以缩减原本不可分工具对内的文本型工具结果主体。
- **`compactRegion` 要求存在未结束的轮次**——在完全关闭的会话上手动调用会抛出异常（「no open turn」），而不是执行压缩。
- **摘要失败会保留最新持久表层**——任何替换前，自动路径会记录警告，并携带完整超预算历史继续。如果剪枝已落地，后续摘要失败会从该持久剪枝表层继续。因达到 `maxTokens` 而发生的摘要截断（隐藏推理 token 可能会耗尽该额度）遵循同一规则。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **默认比例，尚未决定**——`thresholdRatio: 0.8` 与 `retainRatio: 0.16` 是固定默认值；存在通过 `modelPolicies` 进行的按模型调优，但没有基于语料的理想值指引记录。
- **tokenizer 精确测量，暂缓**——token meter 每 token 四字符的启发式对 CJK 文本与 JSON schema 定价偏低；精确 token 化仍是测量服务的开放方向。
- **规范错误之外的溢出恢复，尚未决定**——恢复仅针对 `CONTEXT_WINDOW_EXCEEDED` 触发；其他提供方侧上下文失败不参与分类。

</details>
