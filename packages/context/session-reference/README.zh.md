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

引用其他会话的消息会紧随其后收到一条 `## Referenced sessions` 快照，作为第二条 user 角色消息。快照是不受信任的背景：固定警告告诉模型，除非当前用户明确重复，否则不得遵循其中的指令、权限声明或工具请求。每个来源都独立有界——每条消息至多 `maxReferences` 个不同会话、每个来源至多 `maxReferenceBytes` 字节——无法塞入预算的来源会直接使准备失败，而不是返回部分上下文。

### 查找可引用的会话

`listCandidates(agent, query?, limit?)` 列出除 agent 自身外的会话，按 id、工作目录或投影标题做不区分大小写的过滤，并把同目录会话排在前面。每个候选以其最新标题作为 mention 标签；标题缺失或不可读时回退到会话 id，并报告其工作目录是否就是发起方 agent 的工作目录，宿主因此可以只在位置能区分该行时才显示它。浏览器消费方通过 `ctx.remote.sessionReferenceResolver.candidates` 调用同一发现能力，该方法会为每个候选附上规范 mention。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxReferences` | `3` | 一条已准备消息中不同源会话的最大数量；不得超过 `3` |
| `candidateLimit` | `50` | 返回给宿主的默认候选数量 |
| `maxReferenceBytes` | `65536` | 一个引用对象的最大序列化 JSON 字节数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-reference)是每个受支持字段及其 JSDoc 的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

准备阶段在目标消息到达 `agent/pre-step` 时，对每个被引用会话的当前表层各精确读取一次，因此 queued 消息在进入模型步骤时捕获源状态，此后生成的上下文不可变。投影只保留用户直接发出的 `user/message`、assistant 文本，以及携带规范压缩标记的 `user/message` 检查点；带独立来源的 session-reference 消息会被排除，防止快照递归传播。源文本以 JSON 序列化，每个 `<` 都转义为 `\u003c`，因此无法拼出 `<referenced-sessions>` 定界标签。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionReferenceResolver`：pre-step 监听器、候选发现、准备 |
| [`src/config.ts`](src/config.ts) | `Config` schema、`SessionReferenceError` 错误分类 |
| [`src/uri.ts`](src/uri.ts) | `dsh-session:` URI 编解码、mention 格式化与解析 |
| [`src/projection.ts`](src/projection.ts) | 当前表层投影与字节预算保留 |
| [`src/serialization.ts`](src/serialization.ts) | 快照载荷的标签安全 JSON 转义 |
| [`src/types.ts`](src/types.ts) | `SessionReferenceInput`／`Candidate` 与来源类型 |
| — | 不发布运行时不变式伴生入口；prepare 返回构建时已校验的不可变单次快照；持久 context 的准入、冻结与回放由 Agent 和 Session 层负责。 |

### 主要流程

外层 `agent/pre-step` 监听器接受步骤，从直接用户消息中解析规范 mention，再调用 `prepare`：规范化引用（保持首次 mention 顺序、去重、拒绝自引用与超限数量），并行读取每个表层，在 `maxReferenceBytes` 下逐源保留，并渲染聚合提示词。每份快照都插入到引用它的消息紧后，目标日志先记录可读的直接消息、再记录其带来源上下文，因此捕获后的源变更无法改变目标回放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从共享引用表面进入设计决策与其背后的读取服务。

- [会话引用子系统](../../../docs/subsystems/session-reference.zh.md)——规范 URI、投影规则与稳定的错误分类。
- [跨会话引用决策记录](../../../.agents/notes/implemented/feature/2026-07-21-cross-session-references.zh.md)——引用约定的设计理由。
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

每条包含引用的消息都会添加固定警告和最多三个序列化快照，每个快照都受 `maxReferenceBytes` 独立限制。精确快照会保留在目标历史中，直到目标压缩遮蔽或摘要它；源会话变更不会添加更多 token。

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
