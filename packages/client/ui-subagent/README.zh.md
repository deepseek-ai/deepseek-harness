---
description: "dsh Web 客户端的 subagent 对话目录、续接路由 UI 与 '@' 引用 source。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

## 概述

`dsh-client-ui-subagent` 是 Web 客户端的 subagent 对话功能：用户从父会话的页头浏览并打开 subagent 对话，通过按原因区分的只读编辑器状态续接对话，并用 `@` source 引用运行中的 child。用户从父会话的页头浏览完整的 subagent 来源后代谱系——每一行显示 mode、运行活动、token 用量与活跃轮次耗时——并能以子会话的确切地址打开任意深度。one-shot child 始终打开一个把 transcript 说明为已完成执行记录的只读编辑器；可继续 child 在运行期间把后续提示词经其 FIFO inbox 路由。普通侧边栏会省略带 subagent origin 的会话行，因此父级页头目录是它们的导航入口。

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

会话页头保留当前会话 title 作为谱系面包屑，并在会话存在 subagent 后代时，于页头操作行之前追加 `/` 数量触发器；触发器打开后代目录，统计仅含 subagent 的完整谱系、在普通 fork 处停止，并在任一计入统计的后代处于 `running` 时显示活动仍在进行。选择任意深度，即可用该子会话的确切 `{parentSessionId, childSessionId, mode}` 地址打开其对话。

### 浏览目录

行显示 mode、`running`/`inactive` 活动状态与由日志支撑的可选 title；尾随列在上行显示提供方的持久化 token 用量总计，在下行显示活跃轮次耗时。键盘导航：ArrowRight/ArrowLeft 展开和折叠分支；ArrowUp/ArrowDown、Home、End 与 Escape 用于导航或关闭树。没有 label 的 one-shot 行回退到其会话 id；损坏、不受支持或不可用的行仍保持可读但禁用。

### 续接对话

确切 parent 存活时，可继续 child 保留普通输入 chrome：child 运行期间输入和 Send 保持可用，因为每条后续消息都会进入 child 的 FIFO inbox，而独立的 Stop 经由 `subagents/interruptByParent` 路由。确切 parent 不可用且 child 未在运行的可继续 child 会选用说明恢复路径的只读编辑器；此类 child 仍在运行期间，selector 会让位给普通编辑器——输入区与 Send 被禁用，但独立的 Stop 保持可用。

### `@` 引用 source

`@` source 仍然刻意保持独立且惰性：候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

目录与编辑器行为由 [Web subagent 对话笔记](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.zh.md) 与[当前轮次中断笔记](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.zh.md) 规定。

### 目录派生

页头谱系 renderer 通过标准 `useSessions` 钩子读取 `subagentsByParent` 与会话摘要。紧凑树仍以直接目录为权威依据：每个健康行的 `hasChildren` 提示在交互前决定是否显示展开控件；每层目录仅在其中至少一个健康行是分支时才预留展开列；展开分支时会立即为每个已知直接后代预留一行禁用的加载行，随后再用该 child 的权威目录懒加载结果替换。每个可见分支都会上报给运行时，使成员帧只在树正被消费的位置触发去抖动刷新。

### 耗时与 token

token 用量总计为四个互不重叠的 `tokenUsage` 桶之和。耗时会累加已完成的 `subagentTiming` 轮次，仅在运行中 child 存在未结束轮次时每秒递增一次，并在 child 变为 inactive 后冻结；被中断的未结束轮次以其同一切面的 `active.through` 为上界，绝不使用更新的会话元数据。

### 编辑器选举

one-shot child 始终选用只读编辑器。可继续 child 仅在其确切 parent 不可用且 child 未在运行时选用只读编辑器；否则普通编辑器的会话会经 `subagents/prompt` 路由提示词。本包绝不接收宿主上下文，也不调用面向模型的工具。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话界面、宿主 seam 与设计笔记。

- [ui-conversation](../ui-conversation/README.zh.md)——承载页头操作与编辑器链的聊天界面。
- [ui-input-trigger](../ui-input-trigger/README.zh.md)——承载 `@` source 的建议机制。
- [subagent](../../subagent/subagent/README.zh.md)——可继续 child 背后的宿主能力 seam。
- [Web subagent 对话](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.zh.md)——目录与编辑器规范。
- [当前轮次中断](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.zh.md)——独立 Stop 的语义。

-----

<a id="model-experience"></a>
## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型看到的内容

只有 `@` 引用 source 会影响模型输入：pick 的候选以字面文本 `@label` 进入普通用户消息，没有专用内容块或宿主侧解析。浏览目录、导航 child 与查看持久化 transcript 都不会添加提示词 section；已接收的继续交互内容会经宿主 subagent 适配器成为普通 FIFO 用户消息。

#### Token 影响

有条件且仅追加：字面 `@label` 或用户后续消息只会向对应的新用户消息增加 token。目录与 transcript 操作增加零模型 token。

#### KV Cache 影响

仅追加。本包绝不改写更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义目录能显示什么、`@` 引用意味着什么；它们是当前包约束。

- **目录没有持久化结果**：活动状态与计时无法区分完成、失败或取消，且 UI 不公开 Activation 身份；停止能力仅限编辑器上针对运行中可继续 child 的当前轮次 Stop。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 slash source，HMR 测试覆盖释放；它不发出 Cordis 事件，也不持有跨插件可变状态。
