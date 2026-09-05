---
description: "渲染 Session 对话节点、详情、历史图片、操作、本地化和滚动状态的浏览器 Chat target。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

[English](README.md) | 中文

## 概述

Conversation 组装的浏览器 Chat target。本包注册 Chat event definition 与 snapshot 构造、提供 `useChat`、渲染 transcript node 和详情，并拥有 Chat 专属 store、action、本地化与滚动位置恢复；历史图片 URL 通过 Conversation 持有的按会话缓存（`ctx.uiConversation.imageUrl`）解析。其中 Assistant 与 Turn Tail definition 会直接 fold packed Assistant 历史 run，不展开其成员。steering 分类通过持久 splice state 只保留 next-step Inbox ID；next-turn splice 不创建 Chat Context。本地提交回显（`SessionSnapshot.pendingSubmissions`）保留提交开始时选定的区域：transcript 回显位于消息流末尾，steering 回显带 pending-steering 标记，queued 回显不进入 Chat。一旦 user/steering 节点或 queue occurrence 携带回显的 prompt `rpcId`，该回显即在同一渲染中隐藏，因此交接是原子的。

## 目录

- [系统提示词行](#system-prompt-row)
- [轮次 token 用量](#turn-token-usage)
- [轮次过程折叠](#turn-process-folding)
- [滚动归属](#scroll-ownership)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="system-prompt-row"></a>
## 系统提示词行

Chat 会为非空的初始请求、显式消息序列起点、真实 system 字段变化，或前序 header 尚未进入已加载历史窗口的非初始请求显示一行默认折叠的`系统提示词`。前序 header 到达后，内容未变的 resume 不会重复该行；同一序列内仅配置或仅工具变化、工具步骤与重试也不会重复。该行位于请求的用户消息之前，与提供方 envelope 顺序一致；展开后显示保留原始换行的精确模型可见文本。没有系统提示词的 header 不创建该行。

-----

<a id="turn-token-usage"></a>
## 轮次 token 用量

只有当已加载窗口包含 `turn/start`，且每次已启动的模型尝试都报告安全、精确的用量时，已完成 Turn 才显示可展开的用量行。该行会省略不可用的可选用量桶。记账不完整或相互矛盾时，整个详情都不显示，避免把部分总量冒充完整结果。

-----

<a id="turn-process-folding"></a>
## 轮次过程折叠

「设置 → 通用设置」提供持久化到 `ui-chat` 命名空间的 `Normal` / `Compact` 对话显示偏好，默认使用 `Compact`。Normal 保持所有过程行可见且不渲染轮次过程控件。Compact 模式下，系统提示词在整个轮次中始终独立显示于开场 User 上方。轮次打开期间，上下文注入、推理、Assistant 内容、工具行与重试行始终展开。到 `turn/end` 时，最后一个步骤只有在包含非空文本、图片或未知可见块且不含工具调用块时才成为最终正文边界；边界之前的上下文注入、推理、较早 Assistant 内容、工具行与重试行随后默认收起。控件展示覆盖整个轮次的非 subagent 工具调用数、最终正文之前带回复内容的 Assistant 消息数和 subagent 委派数；值为 0 的分段省略，工具调用与 subagent 两项互斥，系统提示词与上下文注入都不增加计数。三项全为 0 时过程仍会收起，控件标题显示「已思考」（英文为 `Thought for a while`）。摘要下方的通栏分隔线将其与正文或展开后的过程行隔开。用户与 steering 消息、系统提示词、错误、最大 token 与 turn-tail 行留在过程组外；关闭时没有最终正文的轮次保留全部过程证据。新的过程控件插入时不会改变既有行的相对顺序：开场人工输入从首次投影起便位于控件和过程行之前，系统提示词则始终位于该输入上方。只要仍可通过「加载更早」获取历史，过程控件就不出现，也不会隐藏任何成员；历史加载完整后，每个合格的已关闭轮次立即使用默认收起状态。稳定 Chat Node Seat 会让每个 renderer 保持挂载，隐藏成员不产生消息流间距；只有中间没有独立输入时，收起控件才与正文相隔 8px。完成后的收起不依赖是否跟随尾部，因此正在上方阅读的用户可能看到 transcript 高度变化。若自动收起会隐藏当前键盘焦点，则过程组保持展开且焦点留在原处；手动收起会先把焦点移到过程控件，再隐藏成员。会话作用域 store 只记录用户手动展开的「轮次 + 正文步骤」generation；不同正文 generation 默认收起（[折叠决策](../../../.agents/notes/implemented/feature/2026-08-14-web-turn-process-folding.zh.md)，[排序决策](../../../.agents/notes/implemented/bug-fix/2026-08-26-stable-turn-process-order.zh.md)）。

-----

<a id="scroll-ownership"></a>
## 滚动归属

Chat 会在历史前插与 renderer 重新挂载时恢复语义锚点。读者跟随底部时，`ResizeObserver` 追随新的底部，并且无需读取行几何就选中最后一个已加载 Turn；读者离开底部后，高度变化会保持顶部位置，再由阅读线几何选择活跃 Turn。轮次导航预览位于 Markdown 代码块粘性头栏上方，而导航外框始终处于 composer 上方的 transcript 区域内（[已加载 Turn 导航](../../../.agents/notes/implemented/feature/2026-08-25-loaded-turn-chat-navigation.zh.md)）。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器中渲染已记录的对话状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Chat 呈现不会组装或修改提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **transcript 只反映已加载的 Session 窗口**——只有 Session Controller 加载前一页 event 后，更早的 transcript node 才会出现。轮次导航比窗口更宽：轨道把已加载的 Turn 与宿主 `turnOutline` 投影合并，每个已开始的 Turn 都有固定间距刻度（相隔 10px；阶梯高于外框时在框内滚动并以渐变淡出标示可滚方向），激活未加载刻度会先把历史分页拉到该 Turn 的 `turn/start` seq 再落到它的行上。没有该投影时（未挂载 `dsh-session-turn-outline` 的装配），轨道回退到仅显示已加载 Turn。
- **导航预览按卡片尺寸截断**——提示词一行（50 字符）、回复至多三行（120 字符），已加载与未加载 Turn 一致；未加载 Turn 的回复要等该轮落定后才随大纲到达，进行中的轮次在此之前只预览提示词（或仅轮次号）。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Conversation 与 Slot 注册已经强制 Chat target 一致。
