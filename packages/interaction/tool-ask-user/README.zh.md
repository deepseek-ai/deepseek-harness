---
description: "基于用户交互 seam 的模型侧 ask_user_question 工具；供组合或排查交互式 agent 表面的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ask-user

[English](README.md) | 中文

## 概述

`dsh-tool-ask-user` 为模型提供一个工具——`ask_user_question`——用于在需要确认、选择结果或缺失的信息才能继续时，向用户提出简明问题。工具会暂停，直到首个作用域 answerer 接受请求，然后把回答作为普通工具结果送回 agent loop（智能体循环），因此循环机制没有任何变化。工具返回规范的 `{ answers: [...] }` 结构，并以紧凑的 JSON 文本形式呈现。它自身不渲染 UI，也不了解输入的收集方式；Web Client 通过 Remote Events 提供 answerer。运行时中归属于其他 agent 的子级不能向用户提问；它必须在最终结果中包含尚未解决的问题。

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

凡模型应当能够暂停等待人类决定的场景，都可组合此插件：它提供 `ask_user_question` 工具，并且需要带有接受作用域请求的 answerer 的 `ctx.userQuestions` seam。没有 answerer 接受时，工具调用会以错误失败，而不是降级。

### 何时调用该工具

当模型需要确认、选择结果或缺失的信息才能继续时，调用 `ask_user_question`。发送一个或多个问题，每个问题携带稳定的 `id`（回答中会原样包含）；推荐选项放在首位，并在标签末尾追加 `(Recommended)`。

```json
{
  "questions": [
    {
      "id": "cleanup",
      "question": "Proceed with the destructive cleanup?",
      "header": "Confirm",
      "options": [
        { "label": "Yes, delete them (Recommended)", "description": "Removes the three stale files." },
        { "label": "No, keep them", "description": "Aborts the cleanup." }
      ]
    }
  ]
}
```

### 模型得到什么

工具为每个问题返回一个回答对象：`selected` 保存选中的选项标签，`custom` 携带自由填写的回答——对多选题补充 `selected`，对单选题覆盖它。Native 渲染器保留紧凑的 JSON 文本形式。

```json
{ "answers": [{ "id": "cleanup", "selected": ["Yes, delete them (Recommended)"] }] }
```

### 调用何时失败

工具调用会阻塞到用户作答，并且只能通过当前轮次的信号取消。没有 answerer 接受、调用被中止、或调用方不是确切的存活运行时根，都会以模型在工具结果中看到的错误结算——最值得注意的是，归属于另一个 agent 的存活子级会被拒绝（`DELEGATED_CALLER`），必须在最终结果中包含尚未解决的问题或决定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释工具定义及其与 seam 的关系。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册：`ask_user_question` schema、执行路径、结果渲染 |
| — | 不发布运行时不变式伴生入口；执行关系由 seam 拥有。 |

### Consumer 角色

该插件以 `['tools', 'userQuestions']` 注入，在 `ctx.tools` 上注册一个 `defineTool` 条目。`execute` 把模型参数映射为 `AskUserQuestionRequest`，转发确切的调用 agent 与当前轮次的信号，并把接受的回答映射回规范的 `answers` 数组。身份检查、意图校验、waterfall 分派与错误分类由 seam 拥有；本包只做转换。

### 结果渲染

`render` 输出把结构化值经 `JSON.stringify` 投影为单个文本块，因此模型侧结果是紧凑 JSON，而非更丰富的内容块词汇。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具表面逐步进入 seam 约定及其 answerer waterfall。

- [用户交互子系统参考](../../../docs/subsystems/user-questions.zh.md)——此工具背后的服务约定、问题词汇与 answerer waterfall。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)——生成的 `ask_user_question` schema。
- [user-questions 包](../user-questions/README.zh.md)——本工具消费的 seam。
- [交互组映射](../README.zh.md)——相邻的审批与命令表面。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`ask_user_question` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)，其中包含问题 id、提示语、标题、选项与多选标志。

#### Token 影响

工具可见时，每个请求都会产生固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性保持不变，前缀即可稳定复用。插件生命周期变化或作用域限制可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

模型提出的完整问题保留在 assistant 工具调用参数中。用户回答后，下一步会看到精确采用 `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}` 形式的紧凑 JSON；不使用 `custom` 时会省略该字段，`selected` 可以包含零个、一个或多个标签。调用等待期间的 UI 交互不属于模型上下文。

#### Token 影响

参数和回答 JSON 是依数据而定的保留 token；等待用户时不会产生 token 开销。

#### KV Cache 影响

仅追加；新出现的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该工具何时不合适。它们是当前包约束，不是 UI 积压事项。

- **待处理问题会阻塞工具调用，直至用户作答**：该工具未声明 `timeout-policy` 预算；取消仅沿用当前轮次的 `exec.signal`。
- **运行时中归属于其他 agent 的 subagent 不能向用户提问**：`ask_user_question` 会以 `DELEGATED_CALLER` 拒绝归属于另一个 agent 的存活子级；该子级必须在最终结果中包含尚未解决的问题或决定。持久谱系不能决定这一边界，因此带有谱系的会话恢复为运行时根后可以正常提问。
- **Native 回答渲染为 JSON 文本**：规范值仍为结构化数据，但模型侧结果使用紧凑 JSON，而非更丰富的内容块词汇。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
