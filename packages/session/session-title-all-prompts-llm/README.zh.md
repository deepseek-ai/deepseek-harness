---
description: "面向用户与维护者的全消息 LLM 会话标题提供方说明，用于选择标题策略或排查自动标题生成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-all-prompts-llm

[English](README.md) | 中文

## 概述

`dsh-session-title-all-prompts-llm` 作为可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结所有符合条件的用户消息。它注册 `all-prompts` 节奏，并在每条新用户提示词后启动新修订，使用预置历史与子会话提示词。较新的修订会中止并取代旧工作，即使提供方忽略取消，也无法提交陈旧输出。它使用 `dsh-session-title-llm` 的完整必填共享 LLM 配置，因此路由、提示词、预算与取消行为不会漂移。自动行为与配置在前；实现是对共享策略的薄注册。

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

当会话应随其增长而重新生成标题、使标题持续代表整个对话时，在标题服务旁挂载此插件。它要求完整的[共享 LLM 配置](../session-title-llm/README.zh.md#configuration)，且无默认值。

### 标题生成时机

每条新的符合条件用户提示词之后都会启动新修订，包括子会话中的提示词；生成会折叠截至当前修订的所有符合条件消息，预置历史也包含在内。较新的修订会中止并取代旧工作，因此陈旧的完成结果永远无法提交。自动失败——包括输入超过 `maxInputBytes`（此时请求失败而非截断历史）——会发出警告并保留先前标题；`ctx.sessionTitle.refresh()` 是显式重试。

### 配置

插件接受完整必填的[共享 LLM 配置](../session-title-llm/README.zh.md#configuration)：`targetWords`、`targetCjkCharacters`、`maxInputBytes`、`maxOutputTokens`、`timeoutMs`，以及可选成对的 `provider`/`model` 路由。同时省略二者，会继承每个当前已记录主请求的确切路由；同时设置二者，则让标题生成使用独立路由。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-title-all-prompts-llm)是每个受支持字段的穷尽式真源。

### 失败与恢复

如果最终封装的聚合提示词超过 `maxInputBytes`，请求会失败而不是截断历史；自动使用时会发出警告并保留先前标题，只有显式 `refresh()` 会重试。自动工作不会为主 agent 请求增加 token 或延迟。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件形态；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个薄提供方插件：它注册 `all-prompts` 节奏，用恒等选择器选取所有符合条件消息，其余全部委托给[共享 LLM 策略](../session-title-llm/README.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：共享配置 schema、以全消息选择器注册提供方 |

### 调度

标题服务负责调度自动工作：对 `all-prompts` 节奏，每条新的符合条件用户消息都会启动一个修订，较新的修订会取代旧工作；提供方调用在确切主请求路由被记录后才开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方约定不够用时阅读以下页面。它们从共享策略逐步进入替代节奏与它所插入的服务。

- [共享 LLM 标题策略](../session-title-llm/README.zh.md)——此提供方使用的生成辅助模块。
- [首消息标题提供方](../session-title-first-prompt-llm/README.zh.md)——只根据首条提示词为会话生成一次标题的节奏。
- [会话标题服务](../session-title/README.zh.md)——回退行为、重命名、刷新与提供方注册。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 全消息标题请求

#### 模型看到什么

标题模型会收到共享标题指令，以及一个 JSON 数组，其中按日志顺序包含截至当前修订的所有符合条件用户消息和确切 seq。预置历史也包含在内。

#### Token 影响

每条符合条件的新提示词之后都可能发出一次辅助请求，每次请求受 `maxInputBytes` 与 `maxOutputTokens` 约束；显式刷新可能增加调用。主 agent 请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。每条提示词后，辅助输入都会增长或变化，因此提供方专用缓存复用会在第一个变化的 JSON token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方如何对待长会话与异构会话。它们是当前包约束。

- **没有基于摘要继续生成摘要的机制**——输入溢出时保留先前标题；对于很长的会话，此提供方没有基于摘要继续生成摘要的机制或保留策略。
- **消息被平等对待**——它平等对待所有符合条件的用户消息，不提供权重、过滤或手动标题优先级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个薄 provider 把 request/result 校验委托给共享 title service 与 LLM helper，不保留独立可变状态。
