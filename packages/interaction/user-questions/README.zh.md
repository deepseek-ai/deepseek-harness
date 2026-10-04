---
description: "基于 waterfall 的问答服务，用于工具、权限插件、本地 answerer 与 Agent-scoped Web 交互。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

[English](README.md) | 中文

## 概述

当工具或权限流程需要用户提供结构化答案时，使用 `ctx.userQuestions`。`ask()` 会等待回答；`askTimed()` 可以放行 agent 继续独立工作，而问题仍留在会话中供用户回答。

## 目录

- [提出问题](#service-userquestionservice-ctx-key-userquestions)
- [职责](#role)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## 提出问题

当工作无法在没有答案的情况下继续时调用 `ask()`。当 agent 可以在一段前台等待后继续独立工作时调用 `askTimed()`。回答 UI 通过 `attachWait` 接手等待，取得 Host 计算的剩余时长，并用本地时钟倒计时。没有接手方时，包括最后一个 Client 断开之后，服务在原 deadline 放行模型。`userQuestions` projection 从工具调用、其结果和最终回复派生持久问题；Client 接手状态不落盘。

对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

问题可以携带呈现意图 `intent`，声明它就是某种已知决策，识别该标记的 UI 可以按该决策呈现；目前唯一的标记是 `plan-review`，其 `detail` 是待审阅的计划，`approve` 指明表示同意的选项。意图只改变呈现：遵循它的 UI 回答的选项标签与通用 UI 相同，不认识该标记的 UI 则渲染通用选项列表。`ask()` 会以 `BAD_INTENT` 拒绝两种类型无法表达的断言：`approve` 未命名该问题自己的任何选项，以及没有 `detail` 的问题声明了意图。`dsh-plan-mode` 在 `exit_plan_mode` 的审阅问题上设置它。

请求包含 agent 时，`ask()` 会通过当前 `AgentRegistry` 验证该 agent 与注册表中的存活实例是同一对象，并且只允许运行时根调用。存活子级不能发起人机交互。不含 agent 的程序化请求仍会交给本地未限定 scope 的 waterfall listener，若无人接受则以 `NO_PROVIDER` 失败。

工具调用开放期间，唯一的回答路径就是这条请求；重新连接的浏览器会再次收到它，仍可完成。调用返回 pending 之后，或拥有它的进程结束之后，问题进入 `continued`：`answer` Remote 方法把回复作为 `user-question-reply` 消息 steer 给 agent。没有任何 Remote 方法会放弃问题——Client 收起面板时不发送任何内容，因此该调用在收到回答前一直可回答。回答已关闭的会话时先恢复其根 agent。两条路径都不会为已结束的工具调用伪造结果。

<a id="role"></a>
## 职责

`UserQuestionService` 拥有每个 `TimedQuestionWait`、可取消的 Client 接手记录和无人接手计时器。有人接手时，倒计时与聚焦／编辑决策归 Client 所有。无人接手时超时只中止前台请求的 signal 并返回 pending，不中止 Turn。`userQuestions` projection 从现有 Session 事件记录开放、已继续和已结算的计时调用：原生调用按记录的工具 schema 识别，PTC 子调用在结果为 pending 时进入投影。`answer` RPC 验证每个问题恰有一条回答，且每个已继续的调用只接收一条排队中的回复；第二条回复以 `REPLY_QUEUED` 失败。回复被丢弃后，问题仍可回答。迟到批次保留在投影中，因为原工具结果包含的是超时而不是该回答。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: human interaction requires the exact live calling agent when an agent is supplied`、`Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`、`Error: no user-questions answerer accepted the request` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **带 Agent scope 的 Web 回答**：Remote Events 仅在请求带有存活 Agent scope 时路由随产品交付的 Web 回答者；agentless 调用方需要本地未限定 scope 的 waterfall listener。
- **词汇仅包含问题表单形态**：可供选择的选项加可选的自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。
- **草稿文本不属于 Host 问题持久化状态**：问题通过 projection 跨客户端重启保留；未完成的输入仍只保存在一个浏览器配置中。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** `userQuestions` projection 由已记录的工具调用、PTC 子调用和准入的用户消息推导，不存储单独的问题状态。已继续的问题可以创建新的用户轮次，但不能恢复已结束的工具调用。
