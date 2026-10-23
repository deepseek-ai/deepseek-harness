---
description: "可选操作卡片的浏览器端：已完成回答下方的卡片框架、供各实验包填入的正文注册表，以及 propose_action 调用的单行过程行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-action-cards

[English](README.md) | 中文

## 概述

用户在已完成的回答下方看到一张可选操作卡片：标题、过长时会折叠的说明，以及提议该卡片的实验所提供的控件。在过程区中，提议显示为一行，带卡片标题和调用是否被接受；被拒绝的调用可以展开查看原因。如果实验在当前浏览器中没有提供控件，卡片只提供“暂不需要”。展示、展开和折叠卡片都不会发起模型请求。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启用[个性化推荐](../personalized-recommendations/README.zh.md) Bundle，它会在本包旁插入对应的 [Host 服务](../action-cards/README.zh.md)。本浏览器组件没有配置字段。

### 注册卡片正文

种类的浏览器插件注入 `actionCards`，并在自己的 `ctx.effect` 中注册正文：`ctx.actionCards.register({ action, locale, Body })` 返回注销函数。框架为该动作的卡片渲染 `Body`，并传入：卡片、已记录或推导出的决定、会话 id、框架渲染的标题与折叠说明 `summary`、框架的折叠组件 `Folded`、绑定到该卡片的 `act(verb, payload?)`，以及正文自己语言命名空间的翻译函数 `t`。正文把 `summary` 放进自己的布局，并负责自己的标题栏、控件、状态和底部操作。为同一动作注册第二个正文属于注册错误。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节——点击展开</summary>

一个 `conversation.chat.turnTail` 条目读取 `actionCards` 会话投影，在某一轮以最终回答结束后展示该轮接受的卡片；没有回答文本就结束的轮次不显示卡片，若同一轮有多张卡片，显示调用 id 最小的一张。框架把 `data-action-card` 设为调用 id，并以卡片标题命名所在区域。折叠时，宽字素（如汉字）按两个拉丁字母宽度计算，约 260 个单位后折叠；折叠不测量布局，也不改动完整文本。

一个以 `propose_action` 为键的 `tool.call.toolview` 条目，根据记录的调用参数和结果渲染过程行。插件在顶层提供正文注册表，然后挂载生成的 `actionCards` Remote，并在同一生命周期内注册词典和插槽条目。

| 源码 | 内容 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 注册表、Remote、词典与插槽条目 |
| [`src/client/Card.tsx`](src/client/Card.tsx) | 轮次尾部、框架、折叠与兜底正文 |
| [`src/client/ProposeRow.tsx`](src/client/ProposeRow.tsx) | 过程行 |
| [`src/client/registry.ts`](src/client/registry.ts) | 正文注册表与正文属性 |
| [`tests/`](tests/) | 位置、框架、兜底、过程行与注册测试 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [操作卡片](../action-cards/README.zh.md) — 框架背后的工具、卡片状态与用户操作。
- [个性化页面卡片](../client-ui-creation-recommendations/README.zh.md)和[推荐卡片](../client-ui-plugin-recommendations/README.zh.md) — 随产品提供的卡片正文。
- [插槽](../../client/ui-slots/README.zh.md) — 轮次尾部与工具行的注册。

<a id="model-experience"></a>
## 模型体验

间接影响来自 Host 卡片服务：卡片操作以 Remote 调用到达该服务，由它负责记录在日志中的工具、决定和状态通知。

#### KV Cache 影响

渲染卡片和过程行不会改变任何模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 动作没有注册正文的卡片只提供“暂不需要”，该实验的其他操作需要它的浏览器插件。即使该实验的 Host 插件已关闭，“暂不需要”仍然可用。
- 轮次尾部每轮只显示一张卡片，与 Host 每轮一张卡片的规则一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
