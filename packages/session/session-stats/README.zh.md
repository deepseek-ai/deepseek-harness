---
description: "面向客户端与维护者的全日志会话计数与墙钟时间说明，用于选择、组合或排查 sessionStats 投影单元。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-stats

[English](README.md) | 中文

## 概述

本包通过公开的 `sessionStats` 值，为客户端提供全会话轮次与步骤计数，以及 LLM、工具、首 token 和解码墙钟时间。这些数字来自完整的持久日志，因此分页与压缩不会改变它们。当客户端必须在重新加载或缩减历史记录后显示一致的会话统计时，请使用本包。全会话统计不可用时，客户端可改用窗口口径计数。

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

当客户端需要显示不受分页与压缩影响的全会话数字时，在会话存储与投影注册表旁挂载此插件。只有存在注册表时单元才会注册。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-stats'
```

### 各字段含义

| 字段 | 含义 |
|---|---|
| `turns` | 含至少一个已关闭步的不同轮次；被拒绝或空轮不计 |
| `steps` | 已关闭的步——完成、失败、取消与 max-tokens 的步全部计入 |
| `llmMs` | 组装出消息的步的模型墙钟时间之和 |
| `toolMs` | 匹配的 `tool/call` → `tool/result` 墙钟时间之和 |
| `ttftMs` / `ttftSteps` | 首 token 延迟之和及其承载步数 |
| `decodeMs` / `decodeTokens` | 上报用量的步的解码墙钟时间与提供方输出 token 之和 |

每个字段在首个贡献事件之前均为 0；已装配的注册表恒提供该键，因此客户端读取值本身，而非键的存在性。客户端通过投影 seam 的快照与变更流渲染全日志数字；参考消费者是 Web 聊天统计条，其窗口折叠以相同字段名充当无单元时的回退。

### 失败与恢复

没有投影注册表时单元是惰性的：`inject` 使 fiber 保持挂起，不注册任何内容，因此其他装配缺少 `sessionStats` 键。卸载插件会移除该键，因为注册是挂载 fiber 上的 effect。被崩溃打断的步在会话重新加载后计入，届时崩溃恢复补写合成的 `step/end`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释数字背后的折叠；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该单元是对已提交会话事件的纯折叠：`step/end` 是被计数的步事件，因为 agent loop 对每个进入的步在 `finally` 中恰好追加一条，因此完成、失败、取消与 max-tokens 的步都会落地一条。若改按已组装的 assistant 消息计数，则会多算 max-tokens 的 usage 宿主消息（空内容、被排除在 surface 之外），并少算被取消的步（在消息组装前已中止）。墙钟折叠逐字段对齐客户端窗口折叠。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`inject`、在挂载 fiber 上注册单元 |
| [`src/projection.ts`](src/projection.ts) | 折叠：状态形状、逐事件转换、wire 视图 |
| [`src/types.ts`](src/types.ts) | `sessionStats` 投影键声明与字段类型的唯一归属 |

### 数据模型

折叠状态保存八个总计外加进行中的边界：`lastTurn`（最近一次被计数 `step/end` 的轮次）、`openStep`（打开步的边界事实，由其 `assistant/message` 关闭）与 `pendingCalls`（按 callId 记录的工具分发时间）。wire 视图是严格子集——八个总计——因此持久缓存的状态 schema 以边界字段扩展视图 schema。

### 折叠规则

- 不相关事件返回同一状态引用；注册表的 `Object.is` 门禁保持变更流安静。
- 首 token 延迟记录首个非空 delta chunk，并在步内 `llm/retry` 后保留。
- 解码时间与 token 只在同时携带首 token 与有效提供方用量报告的步上累加；与窗口折叠守卫节点用量一样忽略畸形用量。
- 工具时间按 callId 配对 `tool/call` → `tool/result`；未解决的调用在 `turn/end` 时丢弃，因为结果总在其轮内落地，而撞上 `Object` 原型名的 callId 读作未匹配。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当单元约定不够用时阅读以下页面。它们从驱动单元的注册表逐步进入相邻的会话包。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——驱动单元并提供快照与变更流值的注册表。
- [会话投影注册表包](../session-projection/README.zh.md)——单元注册所依据的注册表约定。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 sessionStats 单元把已写入日志的步边界折叠成面向客户端的读模型，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明数字描述什么、单元何时缺失。它们是当前包约束。

- **步数统计的是已发生的工作，而非可见输出**——在产生任何可见内容前就失败的步仍以 `step/end` 关闭并计入；被崩溃打断的步在会话重新加载后计入，届时崩溃恢复补写合成的 `step/end`。
- **被取消的步计数但不计时**——没有组装出 assistant 消息，其部分流式时间不进入任何墙钟数字；反之 max-tokens 的 usage 宿主消息贡献 surface 上看不到的模型时间。
- **计数是日志口径，不是 surface 口径**——消息后来被压缩掉的步仍然计入；数字描述整个会话，而非当前模型可见 surface。
- **仅在组合了投影注册表时挂载**——其他装配不提供 `sessionStats` 键，其消费者回退到窗口口径计数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只拥有一个纯投影折叠区，其 wire payload 在每次快照和变更流发射时都由投影注册表进行 schema 校验。该折叠区依赖的事件关系（每个已进入步骤恰有一个 `step/end`、宿主分配的轮次编号单调递增，以及分片和工具事件携带各自的步骤坐标与调用 id）由 dsh-agent-loop 与 Session surface 拥有并在运行时检查，而不由本包拥有。
