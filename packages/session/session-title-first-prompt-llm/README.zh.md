---
description: "面向用户与维护者的首消息 LLM 会话标题提供方说明，用于选择标题策略或排查自动标题生成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-first-prompt-llm

[English](README.md) | 中文

## 概述

`dsh-session-title-first-prompt-llm` 作为可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结第一条符合条件的用户消息。它注册 `first-prompt` 节奏，只在全新非 fork 会话首次创建回退时自动运行，并把结果归因于该消息的确切 seq。自动失败会保留回退，之后只能通过 `ctx.sessionTitle.refresh()` 重试。它使用 `dsh-session-title-llm` 的完整必填共享 LLM 配置，因此路由、提示词、预算与取消行为不会漂移。自动行为与配置在前；实现是对共享策略的薄注册。

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

当会话应从第一条符合条件用户消息生成标题时，在标题服务旁挂载此插件。它要求完整的[共享 LLM 配置](../session-title-llm/README.zh.md#configuration)，且无默认值。

### 标题生成时机

自动生成只对无父会话、也无先前标题的全新会话运行：在其第一条符合条件用户消息之后，创建回退并发出一次辅助请求来总结该消息。后续提示词、显式用户重命名与继承的 fork 历史都不会触发再次自动调用。自动失败会保留回退；`ctx.sessionTitle.refresh()` 是显式重试。fork 会保留继承的标题，绝不会自动运行此提供方，即使其预置的首消息来自父会话。

### 配置

插件接受完整必填的[共享 LLM 配置](../session-title-llm/README.zh.md#configuration)：`targetWords`、`targetCjkCharacters`、`maxInputBytes`、`maxOutputTokens`、`timeoutMs`，以及可选成对的 `provider`/`model` 路由。同时省略二者，会继承当前已记录主请求的确切路由；同时设置二者，则让标题生成使用独立路由。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-title-first-prompt-llm)是每个受支持字段的穷尽式真源。

### 失败与恢复

失败的生成——主请求之前缺少路由、输入超过 `maxInputBytes`、超时、取消或无效模型输出——会发出警告并保留当前标题；只有显式 `refresh()` 会重试。自动工作不会为主 agent 请求增加 token 或延迟。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件形态；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个薄提供方插件：它注册 `first-prompt` 节奏，用选择器取第一条符合条件消息，其余全部委托给[共享 LLM 策略](../session-title-llm/README.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：共享配置 schema、以首消息选择器注册提供方 |

### 调度

标题服务负责调度自动工作：对 `first-prompt` 节奏，只有当会话无父会话、恰好拥有一条符合条件消息且尚无标题时才启动修订；提供方调用在确切主请求路由被记录后才开始，较新的修订会取代旧工作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方约定不够用时阅读以下页面。它们从共享策略逐步进入替代节奏与它所插入的服务。

- [共享 LLM 标题策略](../session-title-llm/README.zh.md)——此提供方使用的生成辅助模块。
- [全消息标题提供方](../session-title-all-prompts-llm/README.zh.md)——在每条新提示词后重新生成标题的节奏。
- [会话标题服务](../session-title/README.zh.md)——回退行为、重命名、刷新与提供方注册。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 首消息标题请求

#### 模型看到什么

标题模型会收到共享标题指令，以及一个只包含第一条符合条件用户消息的 JSON 数组。后续提示词与继承的 fork 历史不会触发再次自动调用。

#### Token 影响

全新会话最多自动发出一次辅助请求，并受 `maxInputBytes` 与 `maxOutputTokens` 约束；显式刷新可能发出额外调用。主 agent 请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助请求使用已配置或已记录路由，其缓存行为由提供方决定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此提供方何时不再代表会话。它们是当前包约束。

- **首消息可能过时**——对于长期会话，第一条消息可能不再具有代表性；如果后续提示词应触发重新生成标题，请使用全消息提供方。
- **fork 绝不自动重新生成标题**——fork 会保留继承的标题，绝不会自动运行此提供方，即使其预置的首消息来自父会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个薄 provider 把 request/result 校验委托给共享 title service 与 LLM helper，不保留独立可变状态。
