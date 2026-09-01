---
description: "面向用户与维护者的语义会话持久性检查点说明，用于部署不会在崩溃时丢失模型请求或工具副作用的持久化 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-checkpoint-policy

[English](README.md) | 中文

## 概述

`dsh-session-checkpoint-policy` 是一个零配置插件，让持久化会话在关键时刻变得持久：模型请求到达适配器之前、顶层工具正文可能产生外部副作用之前，以及每个步骤边界——使前一响应与工具结果在下一个请求前已存储。把它与一个持久化后端一起加载后，任何检查点之后的崩溃都能恢复已记录的工作——请求、工具调用或已完成步骤——而不会丢失。该策略不添加提示词、工具 schema 或配置；检查点失败按失败即阻止原则处理，因此在无法确认持久写入时，适配器与顶层工具正文都不会运行。流式 `assistant/chunk` 事件没有逐分片检查点，而没有结果的持久调用会记录为未知结果，而不是自动重试。

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

在持久化会话、且必须在崩溃时不重做或丢失工作的任何组合中挂载本插件。持久化与检查点调度是独立插件：后端存储事件日志，本策略决定何时必须刷新存储。

### 何时选择

为每个可能被中断的持久化 agent（智能体）选择它——已记录工具调用与其结果之间、或模型请求与其响应之间的崩溃，正是本策略遏制的那类故障。不带它加载后端是有效的但更弱：仍位于后端批处理窗口内或尚未完成的写入可能丢失。当没有持久化会话、或专用部署刻意替换检查点调度时，跳过本策略。

### 最小配置

不存在配置字段；插件只需与一个持久化后端一起加载：

```yaml
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

### 什么会变得持久

三个屏障会被检查点化。模型请求在适配器流构造前被刷新，因此响应前的崩溃不会重放未持久化的请求。顶层工具调用在工具正文运行前被刷新，因此已记录调用在任何外部副作用前已持久；嵌套工具分派复用外层调用的检查点。在每个 `agent/pre-step` 边界，前一步骤提交的一切——其响应与有序工具结果——在派生下一个请求前被刷新。

### 可观察行为与失败

检查点之后，被检查点化的工作即已持久：恢复像任何持久化会话一样从存储还原它。如果取消在工具检查点 flush 等待期间到达，包装层会返回规范的 `ABORTED_BEFORE_DISPATCH` 结果，绝不进入工具正文。检查点拒绝在两个边界都按失败即阻止处理——适配器或顶层工具正文不运行——步骤边界的拒绝会在另一个请求开始前使轮次失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明该策略如何接入 loop 与持久化 seam；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

该插件只是对三个 seam 的纯监听组合，自身没有状态：它包装 `llm/stream`，使下游流只在活动会话中缓冲的请求事件已持久后构造；在预执行策略与防护之后包装 `tools/execute`，使顶层工具正文只在已记录调用已持久后运行；并监听 `agent/pre-step`，在派生请求前持久化前一响应/结果批次。会话存储的 flush 是共享持久性屏障；并发工具检查点经它串行化，不会产生重复序列号。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`apply` 安装三个检查点监听器 |
| — | 不发布运行时不变式伴生入口；顺序由被拦截的 seam 强制。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从持久性模型逐步进入它所加入的 seam 与随产品交付的后端。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——每个后端共享的 flush 检查点、批处理窗口与崩溃恢复。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。
- [会话持久化 seam](../session-persistence/README.zh.md)——本策略经由其刷新的 `ctx.sessionPersistence` 服务。
- [JSONL 持久化后端](../session-persistence-jsonl/README.zh.md)——本策略通常与之一起加载的随产品交付后端。

-----

<a id="model-experience"></a>
## 模型体验

### 中断调用

#### 模型看到什么

插件不添加提示词或工具 schema。工具检查点后、结果前的硬崩溃会留下持久的未匹配调用；会话恢复提供由 `dsh-session` 负责的模型可见 `TOOL_OUTCOME_UNKNOWN` 结果。该消息允许重试只读或幂等工作，并要求对可能有副作用的调用验证状态或请求用户确认。

#### Token 影响

成功检查点不添加 token，也不改变请求。恢复会添加一条短工具结果消息，以平衡中断的 transcript（文本记录）。

#### KV Cache 影响

修复结果追加在可重用前缀之后，因此不会使较早的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本策略持久性保证的终点。它们是当前包约束，不是任务积压。

- **持久记录执行意图，而非恰好一次副作用**——策略记录的是调用已分派，而非其外部副作用已完成。当提供方支持时，有副作用的工具应将 `exec.callId` 作为幂等键转发。
- **流式内容没有逐分片检查点**——`assistant/chunk` 事件依赖有界后台批次；硬崩溃可能丢失当前内存批次或尚未完成的写入。
- **记录未知结果，而非自动重试**——没有结果的持久调用无法证明其外部副作用是否完成，因此恢复记录未知结果，而不是自动重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
