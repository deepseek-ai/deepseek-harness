---
description: "面向用户与维护者的重试执行器说明：在持久 agent（智能体）步骤边界上配置按提供方路由的模型请求恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-retry

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-retry`，可在持久 agent 步骤边界重试失败的模型请求。提供方的 `retryPolicy` 设置可选择有界的 normal mode 重试或无上限的 always mode 重试；计划的尝试会在退避前写入会话日志，取消后历史仍保持一致。重试会在同一个打开的轮次内重跑失败步骤，而直接 `ctx.llm.stream()` 调用仍只尝试一次。每次重试都会产生另一次提供方请求计费，always mode 会持续到成功、取消或释放。

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

当 agent 运行应从暂时性模型请求失败——速率限制、服务端错误、超时、传输错误——中恢复而不是结束轮次时，挂载本插件。它是执行器：重试策略本身位于各提供方适配器的配置上，本包没有任何自己的配置。

### 何时选择

当组合运行 agent loop（智能体循环）并需要持久请求恢复时选择它。本插件是无配置的函数插件；`dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 等提供方适配器拥有各自路由的 `retryPolicy`，多提供方适配器把它放进每个 provider profile。当调用不经 agent loop、直接走 `ctx.llm.stream()` 时跳过它：这些消费方仍是单次尝试，因为原始流无法持久地区分已发出的分片。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2

- name: '@deepseek-ai/dsh-llm-retry'
```

省略 `retryPolicy` 时使用 normal mode：对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT` 与 `TRANSPORT` 最多重试五次，退避从 500 毫秒到 10 秒、带 10% 抖动。normal mode 可以更改其有界预算、合格 code 与退避；always mode 先询问下游恢复，然后无尝试上限地重试每个模型请求失败，只在成功、取消或插件释放时停止。

### 你可以观察到什么

每次计划的重试在等待前就是持久的：插件会先追加携带重试 id、提供方、模式、策略键、失败与计划延迟的非表层 `llm/retry` 事件，然后在重试开始前立即追加 `llm/retry-started` 事件。提供方给出且符合策略边界的有效 `Retry-After` 会替换本地退避。等待完成后，loop 会在同一个打开的轮次内重跑失败步骤，仍基于同一份持久历史，因此重试请求与原始请求一样可以从会话日志重建。取消或插件释放会中止进行中的退避、等待活跃的委派恢复结算，并使释放前捕获的回调只能以失败结束。

### 失败与恢复

在任何最终适配器被选中之前发生的失败没有提供方策略，原样委派下游。normal mode 中，不在合格集合内的失败 code 或已耗尽的预算会委派；always mode 中，超上限的提供方延迟使用配置的本地退避，因此策略不会因该指令终止。这里没有任何模型可见内容：重试事件、延迟、提供方错误或失败的部分输出都不会到达模型或派生消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释执行器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

执行器建立在一条规定之上：**先持久、后等待，打开步骤边界。** 任何定时器启动之前，重试就已通过会话日志计划，因此崩溃或取消永远不会留下不可见的待处理重试。恢复运行在 agent loop 的 `agent/request-error` waterfall（瀑布式事件），即打开步骤扩展点上，而不是包装 `ctx.llm.stream()`——原始流无法持久地区分已发出的分片，而 loop 可以在同一个打开的轮次内重跑失败步骤。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：waterfall 监听器、策略查找、退避、持久事件追加 |
| [`src/history.ts`](src/history.ts) | 从会话日志查找持久重试历史 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 `llm/retry` 与 `llm/retry-started` 事件载荷类型 |
| [`src/brand.ts`](src/brand.ts) | 事件载荷共享的 `RetryId` 品牌 |

### 恢复流程

失败步骤连同其提供方与解析后的策略一起到达 waterfall。always mode 先结算下游恢复，并遵循下游的 `retry` 决定；normal mode 先检查失败 code 是否合格、预算是否未耗尽。插件计算延迟——有效且在边界内的提供方 `Retry-After`，否则带对称抖动的本地有界指数退避——追加 `llm/retry` 事件，在可取消定时器上等待，追加 `llm/retry-started`，然后返回 `{ kind: 'retry' }`。loop 随后在同一个打开的轮次内重跑失败步骤（仍基于同一份持久历史）。

### Waterfall 组合

本插件是 `agent/request-error` waterfall 中的一个监听器。always mode 的"下游优先"姿态意味着，之后忽略取消且永不结算的策略也会阻止回退、轮次完全停稳与插件释放完成；成功、取消或释放会在活动委派恢复达到完全停稳后停止 always mode。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入拥有重试策略的适配器。

- [dsh-llm 服务](../llm/README.zh.md)——其适配器拥有 `retryPolicy` 的提供方无关服务。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——带路由级 `retryPolicy` 的提供方适配器。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——带逐 profile `retryPolicy` 的多提供方适配器。
- [LLM 流终止失败](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.zh.md)——失败如何以终止分片到达服务边界。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定（adapter contract）。

-----

<a id="model-experience"></a>
## 模型体验

### 模型请求恢复

#### 模型看到什么

重试事件、延迟、提供方错误或失败的部分输出都不会对模型可见。除非下游恢复策略刻意改变该表层，重试步骤会从持久表层历史中重建相同的显式提供方／模型请求；失败分片绝不进入派生消息。

#### Token 影响

每次重试都是一次新的提供方请求，可能重复输入 token 计费。normal mode 有有界预算；always mode 在成功或取消前可能消耗无上限请求。`llm/retry` 本身不贡献任何 token。

#### KV Cache 影响

重建的请求保留此前前缀，有资格按该提供方规则复用提供方缓存。非表层重试事件不改变缓存标识。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明执行器在哪里停止、由未来工作接续。它们是当前包约束，不是通用重试对比或任务积压。

- **agent 轮次是唯一重试边界**——直接 `ctx.llm.stream()` 消费方仍是单次尝试，因为原始流无法持久地区分已发出的分片。
- **always mode 会重试永久性失败**——认证、配额、无效请求、协议与不可恢复的上下文错误会持续到成功、取消或释放；部署方负责提供方专属的成本与延迟控制。
- **有界插件预算相加**——normal mode 只统计其配置的 code 与精确提供方策略，而上下文溢出压缩（compaction）拥有独立预算。任何重叠策略都必须定义注册顺序行为。
- **恢复策略按 waterfall 顺序组合**——always mode 先接受下游重试，再应用其回退。之后忽略取消且永不结算的策略也会阻止回退、轮次完全停稳与插件释放完成。
- **`llm/retry` 记录调度，而非完成**——后续步骤与轮次事件才确立成功、耗尽或取消。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 重试编号只在同一提供方与完整策略键的事件间延续，因此限额、code 成员或退避不同的路由替换会开启自己的历史；该键包含每个影响行为的字段，并因资格判断使用集合成员而对 normal mode code 排序。
- 单独发布的 `./invariant` 伴生插件会对照会话日志校验每次计划的重试——点名当前打开轮次与最新闭合步骤、匹配失败请求的持久提供方，并要求每个 `llm/retry-started` 事件点名一次带相同重试 id、轮次、步骤与重试编号的先前计划尝试。

</details>
