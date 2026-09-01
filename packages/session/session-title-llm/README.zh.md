---
description: "面向用户与维护者的共享模型标题生成策略说明，用于配置标题提供方或排查辅助 LLM 请求。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

[English](README.md) | 中文

## 概述

`dsh-session-title-llm` 让模型支持的标题生成都经过同一份共享策略：它解析辅助路由，把精确选中的用户消息封装为 JSON，强制执行输入与输出预算，组合超时与调用方取消，并在标题被接受前校验模型输出。它是普通库而非 Cordis 插件——随附提供方插件以各自的节奏与消息选择器调用 `registerSessionTitleLlmProvider()`，该辅助函数验证共享配置并把每次修订委托给同一条生成路径，因此注册、路由、提示词、取消与校验行为不会在它们之间漂移。部署方通过要求所有上限的提供方插件来配置它。路由、失败与配置约定在前；请求内部细节放在下方可折叠的开发者章节中。

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

作为部署方，通过[首消息](../session-title-first-prompt-llm/README.zh.md)或[全消息](../session-title-all-prompts-llm/README.zh.md)提供方插件配置此策略。作为提供方作者，通过共享辅助函数注册，而不是手写生成逻辑。

### 注册提供方

提供方插件调用 `registerSessionTitleLlmProvider(ctx, config, id, automatic, selectMessages)`；辅助函数验证共享配置、在 `ctx.sessionTitle` 上注册提供方，并让每次生成都经过共享策略。两个随附插件以各自的 `first-prompt` 与 `all-prompts` 节奏和消息选择器注册；服务上的第二次注册会立即抛出。

### 路由与失败约定

`provider` 与 `model` 覆盖项都是可选的，但必须同时作为非空字符串提供。如果没有这一对取值，辅助函数使用当前会话已记录 `request/header` 中捕获的确切提供方／模型路由，因此在任何路由出现前显式刷新时必须提供覆盖项。辅助函数在记录或分发前，依据 `maxInputBytes` 检查最终 JSON 封装用户提示词的大小，而不是将其截断，并在消费流期间与完成后重新检查超时与调用方取消，因此即使拦截器或适配器忽略 abort，也不能接受迟到的成功结果。格式错误或空输出、工具调用与非 stop 结束原因都会拒绝；会话标题服务决定该拒绝属于自动警告还是显式调用方失败。

### 配置

<a id="configuration"></a>

除成对的路由覆盖项外，每个字段都必填；库不提供默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `targetWords` | 必填 | 非 CJK 标题的目标词数 |
| `targetCjkCharacters` | 必填 | 中文、日文或韩文标题的目标字符数 |
| `maxInputBytes` | 必填 | 最终 JSON 封装用户提示词的 UTF-8 字节上限 |
| `maxOutputTokens` | 必填 | 辅助生成的 token 上限 |
| `timeoutMs` | 必填 | 运行时定时器限制内的端到端时限 |
| `provider`, `model` | 可选 | 显式路由；二者同时提供或同时省略 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释生成路径；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一份共享策略让提供方插件无法漂移：配置校验、路由解析、提示词封装、预算执行、取消与输出校验都在这里，只以提供方的节奏与消息选择器为参数。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置 schema 与校验、提供方注册辅助、请求封装、分发与输出校验 |

### 请求流程

生成在注册时校验一次配置；每次修订把选中的消息封装为 JSON，依据 `maxInputBytes` 检查封装提示词的 UTF-8 字节数，解析路由（显式对或已记录 `request/header`），追加一条携带确切可分发请求的仅日志 `session/title-llm-request` 事件，然后在组合的超时与取消截止时间内通过 `ctx.llm` 流式生成。分发的封套携带 `purpose: 'session-title'`，且有意不包含 agent loop 的进程本地请求身份；DeepSeek 适配器根据该用途禁用思考，使少量输出预算全部用于可见标题文本，其他适配器负责自身用途专用行为。输出只组装为文本块；工具调用、格式错误或空输出与非 stop 结束原因都会拒绝，后续模型失败会保留请求记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当生成策略不够用时阅读以下页面。它们从它所插入的服务逐步进入消费它的提供方插件。

- [会话标题服务](../session-title/README.zh.md)——标题服务、回退行为与提供方注册约定。
- [会话标题子系统](../../../docs/subsystems/session-title.zh.md)——持久标题状态与辅助请求记录。
- [首消息标题提供方](../session-title-first-prompt-llm/README.zh.md)——根据第一条符合条件的用户消息生成标题。
- [全消息标题提供方](../session-title-all-prompts-llm/README.zh.md)——根据所有符合条件的用户消息生成标题。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助标题请求

#### 模型看到什么

标题模型会收到固定系统指令，要求以输入语言返回一个简洁且无装饰的标题；该指令包含所配置的词数与 CJK 字符数目标。它唯一的用户消息包含一个 JSON 数组，其中是精确选中的用户消息及其 seq。

#### Token 影响

辅助请求根据所选输入大小与 `maxOutputTokens` 消耗 token。它与主 agent 请求相互独立，不会向 agent 历史增加标题文本或封装内容。DeepSeek 标题调用会关闭思考；主对话保留自身配置的思考模式。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助缓存复用由提供方决定；固定指令可复用，而 JSON 消息数组会随每次修订变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义被接受的生成形态。它们是当前包约束。

- **仅文本输出**——辅助函数只接受文本输出并拒绝工具调用；不公开结构化输出适配器或提供方专用提示词变体。
- **整体提示词字节上限**——它对整个封装用户提示词强制执行字节上限，而不是剪裁单条消息或应用保留策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个无状态 helper 会在 dispatch 前校验并冻结每个辅助请求；deadline、stream、message seq、provider 与 model 由同步检查和测试覆盖。
