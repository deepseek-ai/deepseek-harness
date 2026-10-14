---
description: "面向用户与维护者的全消息 LLM（大语言模型）会话标题提供方说明，用于选择标题策略或排查自动标题生成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-all-prompts-llm

[English](README.md) | 中文

## 概述

`dsh-session-title-all-prompts-llm` 作为可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结所有符合条件的用户消息。它注册 `all-prompts` 节奏，并在每条新用户提示词后启动新修订，使用预置历史与子会话提示词。较新的修订会中止并取代旧工作，即使提供方忽略取消，也无法提交陈旧输出。它同时拥有初始生成提示词与修订提示词，只与首消息提供方共享 `dsh-session-title-llm` 的[执行模块](../../session/session-title-llm/README.zh.md)。本文优先介绍自动行为与配置；实现是建立在该执行器之上的小型提供方策略。

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

当会话应随其增长而重新生成标题、使标题持续代表整个对话时，在标题服务旁挂载此插件。它要求自己的 `targetWords` 与 `targetCjkCharacters`，外加共享的[执行控制](../../session/session-title-llm/README.zh.md#configuration)，且全部无默认值。

### 标题生成时机

每条新的符合条件用户提示词之后都会启动新修订，包括子会话中的提示词；生成会折叠截至当前修订的所有符合条件消息，预置历史也包含在内。较新的修订会中止并取代旧工作，因此陈旧的完成结果永远无法提交。自动失败——包括输入超过 `maxInputBytes`（此时请求失败而非截断历史）——会发出警告并保留先前标题；`ctx.sessionTitle.refresh()` 是显式重试。

已有提供方生成的标题后，每次请求都会包含该标题，并要求模型在它仍能描述主要主题或任务时逐字保留。同主题追问、补充细节、致谢（如“谢谢”）和继续请求本身都不构成改写理由。指令要求模型仅在主要主题或任务发生实质变化或扩展、使旧标题不再准确时更新。回退标题仍会正常触发首次生成；每条符合条件的提示词仍会安排一次修订。

### 配置

插件要求 `targetWords` 与 `targetCjkCharacters`，外加共享的[执行控制](../../session/session-title-llm/README.zh.md#configuration)：`maxInputBytes`、`maxOutputTokens`、`timeoutMs`，以及可选成对的 `provider`/`model` 路由。同时省略二者，会继承每个当前已记录主请求的确切路由；同时设置二者，则让标题生成使用独立路由。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-title-all-prompts-llm)是每个受支持字段的穷尽式真源。

### 失败与恢复

如果最终封装的聚合提示词超过 `maxInputBytes`，请求会失败而不是截断历史；自动使用时会发出警告并保留先前标题，只有显式 `refresh()` 会重试。自动工作不会为主 agent 请求增加 token 或延迟。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件形态；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个小型提供方策略：它同时拥有初始生成提示词与锚定 `currentTitle` 的修订提示词，把组装后的响应解析为标题，只把路由、上限、取消、记录与组装委托给[共享执行模块](../../session/session-title-llm/README.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、初始与修订提示词、输出解析与直接提供方注册 |

### 调度

标题服务负责调度自动工作：对 `all-prompts` 节奏，每条新的符合条件用户消息都会启动一个修订，较新的修订会取代旧工作；提供方调用在确切主请求路由被记录后才开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方约定不够用时阅读以下页面。它们从共享执行模块逐步进入替代节奏与它所插入的服务。

- [共享 LLM 执行模块](../../session/session-title-llm/README.zh.md)——此提供方使用的执行模块。
- [首消息标题提供方](../../session/session-title-first-prompt-llm/README.zh.md)——只根据首条提示词为会话生成一次标题的节奏。
- [会话标题服务](../../session/session-title/README.zh.md)——回退行为、重命名、刷新与提供方注册。
- [会话包映射](../../session/README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 全消息标题请求

#### 模型看到什么

标题模型会收到截至当前修订的所有符合条件用户消息，按日志顺序排列并带有确切 seq，包括预置历史。已有已接纳的提供方生成标题时，此提供方会将其作为 `currentTitle` 传入，并添加自己的保留标题指令；回退、用户与不存在的标题走其初始生成路径。消息与当前标题均计入 `maxInputBytes`。

#### Token 影响

每条符合条件的新提示词之后都可能发出一次辅助请求，每次请求受 `maxInputBytes` 与 `maxOutputTokens` 约束；显式刷新可能增加调用。它选择路由支持的最低推理强度；路由没有可选强度时不指定。主 agent（智能体）请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。每条提示词后，辅助输入都会增长或变化，因此提供方专用缓存复用会在第一个变化的 JSON token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方如何对待长会话与异构会话。它们是当前包约束。

- **没有基于摘要继续生成摘要的机制**——输入溢出时保留先前标题；对于很长的会话，此提供方没有基于摘要继续生成摘要的机制或保留策略。
- **消息被平等对待**——它包含每条符合条件的用户消息，不提供可配置的权重或过滤。
- **稳定性依赖模型**——保留标题依靠模型指令，没有确定性的语义校验；模型仍可能改动合适的标题。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
