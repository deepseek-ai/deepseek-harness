---
description: "跨会话快照引用与持久的不受信任模型上下文，供启用或排查 ctx.sessionReferenceResolver 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-reference

[English](README.md) | 中文

## 概述

`dsh-session-reference` 让一次对话可以引用其他会话：宿主把 `@label` mention 转换为规范 URI，服务则为模型准备每个被引用会话的有界、只读快照，作为持久、不受信任的背景上下文。候选发现按工作目录亲和度对其他会话排序，并用其最新标题作标签。快照在捕获后不可变，并带有固定警告，禁止遵循其中的指令、权限声明或工具请求。它是面向支持跨会话 mention 的宿主的可选服务；它消费 `ctx.sessionQuery`，不需要 SQLite FTS。

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

当宿主应允许用户提及另一个会话并把其上下文交给模型时，启用此服务。由于它消费后端无关的 compact 检查点标记，任何 session-query 后端都可配合使用。

### mention 语法

规范 mention 是 Markdown 形式的 `@[label](dsh-session:<base64url 编码的 id>)`，或裸 `dsh-session:` URI；每个 JavaScript 字符串会话 id 都能精确往返。服务会把 mention 改写为消息中可读的 `@label` 文本，并返回结构化引用。显式 Markdown mention 会拒绝格式错误的 URI；空或只含标点符号的 scheme mention 仍是普通讨论文本。

### 模型能得到什么

引用其他会话的消息后会紧接一条 `## Referenced sessions` 快照，作为第二条 user 角色消息。快照是不受信任的背景：固定警告告诉模型，除非当前用户明确重复，否则不得遵循其中的指令、权限声明或工具请求。每个来源预览都独立有界——每条消息至多 `maxReferences` 个不同会话，每个来源的序列化 JSON 采用配置值或模型相对字节预算。保留策略先丢弃较早的非检查点消息，再缩短保留的文本；只有保留处理后引用仍无法满足预算时，准备才会失败。

引用被截断时，可选的 spill 后端会在目标会话下保存完整的已捕获文本投影。有界预览 JSON 之外的独立省略通知给出精确的 `omittedMessages` 与 `omittedBytes`，以及保存后的定位信息和 `retrievalHint`，或区分未配置存储与保存失败的不可用结果。该通知属于同一条持久上下文消息。完整转录携带相同的不受信任背景警告与捕获元数据，包括 `capturedFormatVersion`。每条消息使用每行至多 64 个 Unicode 码点的 JSON 字符串片段；解码并拼接其片段即可恢复精确文本，包括原始换行。这种固定存储格式使很长的单行文本也可通过分页文件读取来检查。

### 查找可引用的会话

`listCandidates(agent, query?, limit?)` 列出除 agent 自身外的会话，按 id、工作目录或投影标题做不区分大小写的过滤，并把同目录会话排在前面。每个候选以其最新标题作为 mention 标签；标题缺失或不可读时回退到会话 id，并报告其工作目录是否就是发起方 agent 的工作目录，宿主因此可以只在位置能区分该行时才显示它。浏览器消费方通过 `ctx.remote.sessionReferenceResolver.candidates` 调用同一发现能力，该方法会为每个候选附上规范 mention。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxReferences` | `3` | 一条已准备消息中不同源会话的最大数量；不得超过 `3` |
| `candidateLimit` | `50` | 返回给宿主的默认候选数量 |
| `maxReferenceBytes` | 自动 | 每个来源的最大序列化 JSON 字节数；显式设置时精确覆盖自动预算 |
| `referenceContextFraction` | `0.2` | 每个来源的上下文窗口比例，范围为 `0` 到 `1` |

自动预算为每个来源 `max(65536, floor(contextWindow × 4 × referenceContextFraction))` 字节。模型上下文容量以 token 计量；每个 token 四字节是容量估算，不是精确的 token 换算。缺少路由、LLM 服务、适配器或容量时使用 64 KiB；其他模型元数据查询错误与取消会使准备失败。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-reference)是每个受支持字段及其 JSDoc 的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

准备阶段在目标消息到达 `agent/pre-step` 时，对每个被引用会话的当前表层各精确读取一次。预览与 spill 使用同一份已捕获投影：用户直接发送的文本、assistant 文本，以及携带规范压缩标记的 user 检查点；工具、推理与其他注入上下文均被排除。这既防止引用递归传播，也防止源会话后续变更影响已保存转录。预览 JSON 将每个 `<` 转义为 `\u003c`，因此源文本无法拼出 `<referenced-sessions>` 定界标签。

解析器通过 `ctx.get("spillStore")` 获取可选存储，只保存被截断的引用。存储归目标会话所有；来源信息标识被引用的源会话与标签，不伪造工具调用。异步保存后会检查取消，即使产物已写入，也会阻止发布。产物过期仍遵循后端既有策略。

预算使用目标 agent 的 `system-prompt/assemble` 完成后捕获的 provider 与 model。首次组装前直接调用 `prepare` 时使用 agent options；会话头不决定预算模型。不带 agent 的诊断组装不会影响已捕获路由。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionReferenceResolver`：pre-step 监听器、候选发现、准备 |
| [`src/config.ts`](src/config.ts) | `Config` schema、`SessionReferenceError` 错误分类 |
| [`src/uri.ts`](src/uri.ts) | `dsh-session:` URI 编解码、mention 格式化与解析 |
| [`src/projection.ts`](src/projection.ts) | 当前表层投影与字节预算保留 |
| [`src/serialization.ts`](src/serialization.ts) | 快照载荷的标签安全 JSON 转义 |
| [`src/spill.ts`](src/spill.ts) | 完整转录序列化与模型可见省略通知 |
| [`src/types.ts`](src/types.ts) | `SessionReferenceInput`／`Candidate` 与来源类型 |
| — | 不发布运行时不变式伴生入口；prepare 返回构建时已校验的不可变单次快照；持久 context 的准入、冻结与回放由 Agent 和 Session 层负责。 |

### 主要流程

外层 `agent/pre-step` 监听器接受步骤，从直接用户消息中解析规范 mention，再调用 `prepare`：规范化引用（保持首次 mention 顺序、去重、拒绝自引用与超限数量），并行读取每个表层，在解析出的字节预算下逐源保留，并渲染聚合提示词。每条持久来源记录保留冻结的 `capturedThroughSeq` 并记录非零 `capturedFormatVersion`；字段缺失表示格式 v0。每份快照都插入到引用它的消息紧后，目标日志先记录可读的直接消息、再记录其带来源上下文，因此捕获后的源变更无法改变目标回放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从共享引用表面进入设计决策与其背后的读取服务。

- [会话引用子系统](../../../docs/subsystems/session-reference.zh.md)——规范 URI、投影规则与稳定的错误分类。
- [会话引用 spill 复用](../../../.agents/notes/implemented/bug-fix/2026-09-05-session-reference-spill-reuse.zh.md)——快照身份、省略通知、存储归属与替代方案。
- [会话查询子系统](../../../docs/subsystems/session-query.zh.md)——提供会话表层的读取服务。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-reference)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 引用会话背景

#### 模型看到的内容

模型会看到两条连续的 user 角色消息：先是带可读 `@label` 的当前消息，再是 `## Referenced sessions` 不受信任快照。警告禁止遵循快照中的指令、权限声明或工具请求，除非当前用户明确重复这些内容。标签、cwd 值、id 与会话文本会作为 JSON 在 `<referenced-sessions>` 标签中序列化；数据中的每个 `<` 都会以无损 JSON 转义 `\u003c` 的形式发出，因此源文本无法拼出定界标签。

#### Token 影响

每条包含引用的消息都会添加固定警告和最多三个序列化预览，每个预览都受配置值或模型相对字节预算独立限制。被截断的引用会在该预算之外添加独立省略通知；已保存的完整转录只有在被取回时才增加 token。精确上下文会保留在目标历史中，直到目标压缩遮蔽或摘要它；源会话变更不会添加更多 token。

#### KV Cache 影响

请求与快照是两条连续、仅追加的目标消息，并保留较早的可缓存历史。不同引用或源捕获内容只改变新后缀；后续目标压缩可能使从替换边界起的复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明跨会话引用何时不合适。它们是当前包约束。

- **不支持消息正文检索**：候选查询会检查标题，但不搜索消息主体。
- **标签只来自投影**：已挂载的会话由实时投影切面标注，冷会话由持久化 checkpoint 标注，两者都答不上来的会话用 id 作标签且无法按标题搜到。发现路径绝不读日志：折叠一个标题的代价是整份日志，而这段代码位于补全的每一次击键之下。早于投影缓存组合存在的会话，只要被打开一次（销毁时即写 checkpoint）就会恢复标题。
- **受信任调用方边界**：该服务假设宿主有权读取 `ctx.sessionQuery` 公开的每个会话；它不是面向模型的搜索工具。
- **只投影文本**：不会在会话间传播非文本 user 与 assistant 块。
- **没有实时链接**：引用是快照，不是 fork、恢复、订阅或源会话变更。
- **转录搜索按行进行**：字面短语可能跨越 JSON 片段行或包含转义字符；精确文本匹配需先解码并拼接消息片段。已保存产物可能按后端策略过期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
