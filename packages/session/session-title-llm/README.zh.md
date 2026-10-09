---
description: "面向会话标题提供方的共享模型执行策略：路由、上限、取消、请求记录与流式组装。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

[English](README.md) | 中文

## 概述

`dsh-session-title-llm` 在一致且固定的执行控制下执行一次准备好的辅助标题请求。每个提供方提供自己的系统指令、用户输入、源消息归因、推理选择与输出解释。本包负责解析路由、限制输入、输出与端到端时长，在整个流式处理期间保持调用方取消有效，记录模型可见的确切请求，并组装流。无效或迟到的操作结果在替换标题前被拒绝。

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

作为部署方，通过[首消息](../session-title-first-prompt-llm/README.zh.md)或[全消息](../../experimental/session-title-all-prompts-llm/README.zh.md)提供方插件配置此策略。作为提供方作者，构建自己的准备输入，并通过共享函数执行。

### 执行提供方请求

提供方插件直接注册到 `ctx.sessionTitle`，并在其 `generate(request)` 中把 `{ system, input, messageSeqs, selectReasoningEffort }` 传给 `executeSessionTitleLlm`。提供方负责系统指令、输入封装、自己的推理选择与输出解释；该函数负责路由准备、上限、取消、请求记录与流式组装。服务上的第二次注册会立即抛出。

每个请求都带有 `currentTitle`，即服务在调用时捕获的最新已接纳标题快照，包括已接纳的回退标题。提供方自行决定是否使用它：全消息提供方只锚定来源为提供方的标题（包括继承自不同提供方的标题），并把回退、用户与不存在的标题视为初始生成。首消息提供方忽略 `currentTitle`。

### 路由与失败约定

`provider` 与 `model` 覆盖项都是可选的，但必须同时作为非空字符串提供。如果没有这一对取值，函数使用当前会话已记录 `request/header` 中捕获的确切提供方／模型路由，因此在任何路由出现前显式刷新时必须提供覆盖项。函数在记录或分发前，依据 `maxInputBytes` 检查准备好的最终用户输入的大小，而不是将其截断，并在消费流期间与完成后重新检查超时与调用方取消，因此即使拦截器或适配器忽略 abort，也不能接受迟到的成功结果。函数把确切请求记录到 `session/title-llm-request`，并返回组装后的内容块、终止结束原因与所用模型身份。操作性错误、中止与不支持的结束原因都会拒绝；`stop`、`tool-calls` 与 `max-tokens` 会返回提供方，由其自行决定是否接受。标题请求独立使用 `maxOutputTokens`，不继承对话请求的上限。其路由必须注册适配器，以便在记录前完成请求准备。

### 配置

<a id="configuration"></a>

除成对的路由覆盖项外，每个执行字段都必填；库不提供默认值。每个提供方各自添加标题长度目标设置，并由该提供方的 README 记录。

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxInputBytes` | 必填 | 准备好的用户输入的 UTF-8 字节上限 |
| `maxOutputTokens` | 必填 | 标题输出 token 上限，独立于对话请求 |
| `timeoutMs` | 必填 | 运行时定时器限制内的端到端时限 |
| `provider`, `model` | 可选 | 显式路由；二者同时提供或同时省略 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释生成路径；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一份小型共享执行策略，使操作行为无法漂移：执行控制校验、路由解析、预算执行、取消、请求记录与流式组装都在这里。提示词措辞、标题长度目标、推理选择与输出解释仍归各提供方所有。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置 schema 与校验、路由解析、请求上限、分发、记录与流式组装 |

### 请求流程

调用方构建准备好的输入并进行封装；函数依据 `maxInputBytes` 检查完整输入。提供方的推理选择器在 `ctx.llm.prepareCall()` 期间最多选择一个强度。函数把确切输入、输出上限与解析后的强度记录到 `session/title-llm-request`，然后在共享截止时间内通过同一捕获的适配器代次分发。`purpose: 'session-title'` 仅提供归属标注。请求不带 agent loop 身份，也不进入对话历史。生成失败仍保留请求记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当生成策略不够用时阅读以下页面。它们从它所插入的服务逐步进入消费它的提供方插件。

- [会话标题服务](../session-title/README.zh.md)——标题服务、回退行为与提供方注册约定。
- [会话标题子系统](../../../docs/subsystems/session-title.zh.md)——持久标题状态与辅助请求记录。
- [首消息标题提供方](../session-title-first-prompt-llm/README.zh.md)——根据第一条符合条件的用户消息生成标题。
- [全消息标题提供方](../../experimental/session-title-all-prompts-llm/README.zh.md)——根据所有符合条件的用户消息生成标题。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助标题请求

#### 模型看到什么

标题模型会收到由提供方拥有的系统指令，以及一条包含提供方所拥有输入的用户消息。执行器记录并分发这些确切取值，不做重建；封装方式与输出指令都归提供方所有，并由[首消息](../session-title-first-prompt-llm/README.zh.md)与[全消息](../../experimental/session-title-all-prompts-llm/README.zh.md) README 记录。

#### Token 影响

辅助请求根据提供方准备好的输入大小与 `maxOutputTokens` 消耗 token。它与主 agent 请求相互独立，不会向 agent 历史增加标题文本或封装内容。执行器应用提供方选定的推理强度；选择器返回 `undefined` 时使用路由的正常默认值。仍在推理的模型会把部分 `maxOutputTokens` 用于推理。主对话保留自身配置的思考模式。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助缓存复用由提供方决定：此执行器分发提供方确切的系统提示词与输入，因此复用取决于各提供方对各次修订的封装方式。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义被接受的生成形态。它们是当前包约束。

- **输出由提供方解释**——执行器返回组装后的内容块与终止结束原因，不决定接受或拒绝；各随附提供方的 README 记录其接纳策略。
- **整体输入字节上限**——它对超过 `maxInputBytes` 的准备输入直接拒绝，而不是将其截断。
- **推理由提供方选择**——执行器只应用提供方返回的强度，绝不自行选择；选择器返回 `undefined` 时使用路由的正常默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
