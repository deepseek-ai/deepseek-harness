---
description: "在完整回答之后显示官方插件推荐卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-recommendations

[English](README.md) | 中文

## 概述

用户在完整回答下方看到一张插件推荐卡片，显示插件当前的界面语言标题和描述。标题和描述是同一个点击区域，悬停时整体高亮；点击可打开插件页中的对应详情，不会启用插件或改变当前 Session。启用和暂不需要仍是独立操作。重新连接后仍能看到之前的选择并打开详情。

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

启用[个性化推荐 Bundle](../personalized-recommendations/README.zh.md)。这个浏览器端贡献没有配置项；它为 `enable_official_plugin` 卡片填充共享的[操作卡片框架](../client-ui-action-cards/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

插件先挂载读取目录文本的 Remote，再向共享的卡片框架注册正文；框架把卡片放在所在回合之后，并提供卡片、已记录的决定和绑定到卡片的操作。正文向 Host 读取插件当前的目录文本和启用状态，渲染带「官方」标记的标题栏、详情点击区域、状态，以及通过框架操作发出的启用和暂不需要。详情点击区域的无障碍名称是「查看详情」加插件标题，目录描述仍作为它的无障碍描述。查询被拒绝时显示原因，回复丢失时说明无法读取插件信息；两种情况都提供「暂不需要」和重新查询的「重试」，不提供启用。已记录的结果保持不变，插件之后离开目录也一样。操作进行中只有被点击的按钮显示「正在处理…」，两个按钮都禁用。插件在自身生命周期内按插件名记住读到的目录文本，再次进入会话时卡片立即显示，同时卡片自己的查询会刷新启用状态。某个插件的第一次查询返回前，卡片显示提议的标题、一行描述占位和禁用的按钮，布局不跳动。Remote、正文注册和词典共用同一个插件生命周期。

卡片沿用应用字体，通过标题、正文和独立操作区区分信息层级。构建入口将生成的 Remote 描述传给可直接从源码测试的挂载流程。

- [Source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读
- [推荐服务](../plugin-recommendations/README.zh.md) — 推荐范围、启用和决定。
- [操作卡片显示](../client-ui-action-cards/README.zh.md) — 框架、种类正文和过程行。

<a id="model-experience"></a>
## 模型体验

间接影响来自卡片操作：共享的 Host 卡片服务在下一次模型请求中追加一条已记录的状态通知。本界面不增加模型工具或提示词。

#### KV Cache effect

卡片不增加模型上下文。启用操作可能通过 Host 改变之后的工具声明。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每个回合只显示第一条推荐。
- 插件第一次查询返回前，卡片只预留一行描述；更长的描述返回后卡片仍会变高。
- 历史选择不会跟踪之后在插件页面进行的修改。
- 查询被拒绝或回复丢失后，要等「重试」读到插件的目录文本，才会重新提供启用。
- 插件离开目录后，卡片显示提议时的标题，而不是目录文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
