---
description: "面向 agent 开发者与维护者的工作区授权模型会话历史工具，用于选择、配置或排查既往会话搜索、追踪与事件读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-query

[English](README.md) | 中文

## 概述

`dsh-tool-session-query` 给模型提供五个会话历史只读工具：`session_search`、`session_event_search`、`session_trace`、`session_event_trace` 与 `session_event_read`。工具经工作区授权——模型只能访问 `cwd` 与其自身调用方会话完全相同的会话——结果是无游标的纯文本，因此模型可以搜索既往工作，并顺着有用命中进入其血缘或精确事件数据。本包是 opt-in，已发布宿主组合默认不挂载：挂载后每次请求都会增加一个精简指引章节与五个 schema。配置与用法在前；实现内部细节放在下方可折叠的开发者章节中。

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

当 agent 应该能搜索自己的既往会话并检查其关系与事件时挂载本包。常用路径是显式的：在 `ctx.sessionQuery`（由 `dsh-session-query-sqlite` 支撑）之上挂载插件，然后让模型调用这些工具。

### 何时选择

当部署需要模型驱动的既往工作检索时选择它——例如编程 agent 在开始任务前搜索更早会话中做过的事。只需要程序化检索时避免使用：`ctx.sessionQuery` 本身服务代码调用方，无需面向模型的 schema、提示词与授权层。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSearchResults` | `100` | 一次搜索调用返回的最大已授权命中数 |
| `searchTimeoutMs` | `30000` | 附加到两个全文搜索工具的协作式截止时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-session-query)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 模型可以做什么

| 工具 | 模型得到什么 |
|---|---|
| `session_search` | 匹配字面查询的会话，经排序，带标题与最佳匹配摘录；始终省略调用方会话 |
| `session_event_search` | 一个已授权会话内匹配字面查询的事件；针对当前会话时，在调用它的步骤之前停止 |
| `session_trace` | 一个会话的已授权祖先链与后代树；未授权边界以不含隐藏 id 的标记出现 |
| `session_event_trace` | 一个事件的位置替换与被引用源事件关系 |
| `session_event_read` | 一个完整未删节事件（JSON），加可选的事件邻接摘要 |

工作区授权是保守的：跨会话访问要求目标与调用方会话的 `cwd` 严格相等，没有 `cwd` 的调用方只能检查自己。请求的父 id 会在搜索前去重并按权限检查；缺失与跨工作区猜测行为完全相同。搜索结果无游标：结果达到上限时请模型缩小查询，绝不暴露提供方游标、偏移、分页大小或模型可控上限。工具边界的时间戳是带时区限定的 ISO 8601，并转换为包含端点的 epoch 毫秒过滤器。

### 失败与恢复

每个可信查询服务调用都经过一个错误净化器：调用方取消被精确保留，语料库与提供方诊断进入内部日志，不安全或不可打印的失败回退到固定 `SESSION_QUERY_TOOL_FAILED` 代码与消息。本地参数校验与授权错误保留精确的工具自有消息（目标在调用方工作区之外时为 `SESSION_QUERY_TOOL_UNAUTHORIZED`）。本包不执行字节或字符截断，也不导入 spill 后端；需要限制内联输出的部署应挂载 `@deepseek-ai/dsh-spill-policy`，它可以在保留完整结果的同时替换过大的已渲染文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本消费方建立在一个分离与三项承诺之上：

- **窄而只读的工具。** 五个带扁平 snake-case schema 的工具，每个都引导一个后续步骤；游标、偏移、分页大小或模型可控上限永远不会到达模型。
- **授权来自调用方，绝不由模型提供。** 调用方身份来自 `ToolExecution.exec.agent`；工作区是字符串精确 `cwd` 相等，并对照每次结果观察到的 header 重新校验。
- **一个模型边界净化器。** 每个可信 `ctx.sessionQuery` 调用都经过服务边界，它保留取消并包含诊断与分类失败。
- **不引入第二种截断格式。** 结果保持完整；通用 spill 策略负责有界内联输出。

设计历史记录在[面向模型的会话查询工具笔记](../../../.agents/notes/archived/feature/2026-07-24-model-facing-session-query-tools.md)与 [session-search-not-shipped-default 笔记](../../../.agents/notes/archived/feature/2026-08-02-session-search-not-shipped-default.md)中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、提示词章节、五个工具注册 |
| [`src/input.ts`](src/input.ts) | 模型 schema、参数规范化、过滤器构造 |
| [`src/workspace-access.ts`](src/workspace-access.ts) | 调用方身份、工作区授权、标题访问、血缘投影 |
| [`src/service-boundary.ts`](src/service-boundary.ts) | 可信调用与模型安全错误转换 |
| [`src/operations.ts`](src/operations.ts) | 五个操作工作流 |
| [`src/presentation.ts`](src/presentation.ts) | 文本结果渲染与工具调用卡片 |

### 操作流程

每个执行器先派生调用方，把模型的参数规范化为服务过滤器，对照调用方工作区授权目标（或请求的父 id），然后通过服务边界收集结果。两个搜索工具在观察世代仍有效时内部翻页消费提供方游标，停在 `maxSearchResults`；由于一次搜索会消费与世代绑定的提供方游标，两个搜索工具与同级工具调用排他执行，而三个精确追踪/读取工具选择并行执行。血缘输出用不含隐藏会话 id 的标记替换未授权祖先与后代边界。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具表面逐步进入底层服务、schema 目录与设计证据。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-query)——模型看到的五个工具 schema。
- [dsh-session-query](../session-query/README.zh.md)——这些工具调用的服务。
- [dsh-session-query-sqlite](../session-query-sqlite/README.zh.md)——两个搜索工具背后的全文后端。
- [会话查询子系统参考](../../../docs/subsystems/session-query.zh.md)——工具之下的类型级约定。
- [面向模型的会话查询工具](../../../.agents/notes/archived/feature/2026-07-24-model-facing-session-query-tools.md)——工作区授权、无游标结果与 spill 决策。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

模型会收到一个固定的既往历史指引章节。

##### 既往历史指引

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.
```

#### Token 影响

插件挂载期间，每次请求都存在一个固定精简章节。

#### KV Cache 影响

插件与指引文本不变时，前缀稳定。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`session_search`、`session_event_search`、`session_trace`、`session_event_trace` 与 `session_event_read` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-query)。搜索过滤器会增加固定 schema token，而游标、工作区路径、输出分页与模型可控结果上限仍不存在。

#### Token 影响

可见期间，每次请求都会发送五个固定只读 schema。

#### KV Cache 影响

工具可见性与定义不变时，前缀稳定。

### 工具结果

#### 模型看到什么

每次成功调用都会发出一个纯文本块。搜索结果包含标题与最佳匹配摘录；追踪包含全部已授权关系；事件读取包含未经删节的目标 JSON。通用 spill 策略可以用其预览、不透明定位信息与取回指引替换过大的内联文本。

#### Token 影响

结果取决于数据，并保留在已记录工具历史中直到压缩（compaction）；`maxSearchResults` 限制搜索命中数。

#### KV Cache 影响

仅追加的结果文本位于可重用请求前缀之后，不会使较早的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **搜索有上限且无延续**——搜索最多返回部署上限，匹配更多时会请模型缩小查询；不提供延续 token。
- **保守的工作区身份**——工作区身份是字符串精确 `cwd` 相等，因此符号链接等价的路径不共享权限。
- **无 spill 策略时内联载荷**——未挂载通用 spill 策略的自定义组合会以内联方式接收完整追踪与事件载荷。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：更宽泛的工作区语义

字符串精确 `cwd` 相等是刻意保守的选择；符号链接感知或规范路径的工作区身份会改变哪些会话共享权限，尚未决定。

</details>

**运行时不变式：** 不发布伴生入口。这个只读模型 adapter 不持有其所属 registry 之外的事件或可变数据关系。
