---
description: "用一个实验性 Bundle 在回答下方启用个性化页面提议和内置插件推荐。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-personalized-recommendations

[English](README.md) | 中文

## 概述

针对两类需求在回答下方提供一张可选卡片：想要长期使用的页面或小工具，以及能提供你所问能力的内置插件。在卡片上点击创建或启用之前，不会生成或开启任何内容。在 Web 或 Desktop 的插件页面启用个性化推荐；发布的 profile 默认禁用它。它的页面列出两项功能及其卡片行，每行都有自己的开关。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开插件 → 更多 → 实验性插件，启用个性化推荐。启用后它固定显示在插件主列表；关闭后只回到二级页。Bundle 开启期间，它的页面按以下顺序列出六行，每行都有自己的开关：

| 行 | 包 | 提供 |
|---|---|---|
| 操作卡片 | [`action-cards`](../action-cards/README.zh.md) | 卡片工具、卡片状态、用户操作和状态通知 |
| 操作卡片显示 | [`client-ui-action-cards`](../client-ui-action-cards/README.zh.md) | 回答下方的卡片框架 |
| 个性化页面 | [`creation-recommendations`](../creation-recommendations/README.zh.md) | 页面提议及其后台创建 |
| 个性化页面卡片 | [`client-ui-creation-recommendations`](../client-ui-creation-recommendations/README.zh.md) | 页面卡片正文 |
| 插件推荐 | [`plugin-recommendations`](../plugin-recommendations/README.zh.md) | 内置插件推荐和启用 |
| 插件推荐卡片 | [`client-ui-plugin-recommendations`](../client-ui-plugin-recommendations/README.zh.md) | 插件卡片正文 |

关闭个性化页面或插件推荐即可只保留另一项功能：被关闭的功能撤下它的 Skill 和卡片种类，它之前的卡片只接受“暂不需要”。两项功能都需要操作卡片行；关闭它后两项功能都停止，直到重新开启。缺少卡片正文行时，卡片只显示提案标题、说明和“暂不需要”。操作卡片行的 `queuedMessageLimit` 字段规定排队等待下一轮的消息达到多少条时，卡片工具拒绝本轮的卡片。插件页面没有为该行提供设置页，请在 profile 的 `cordis.patch.yml` 中用 `id: action-cards` 覆盖项修改该字段。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

静态 `cordis.patch.yml` 以各包自有的 id 插入这六行，不带配置。只有本 Bundle 声明这些 id，因此插件管理器按 id 定位每一行，插件页面可以开关它。两个功能插件都注入 `actionCards` 并向它注册卡片种类；三个浏览器端行注册卡片框架和两种卡片正文。`src/index.ts` 不导出任何内容。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[操作卡片](../action-cards/README.zh.md) · [个性化页面](../creation-recommendations/README.zh.md) · [插件推荐](../plugin-recommendations/README.zh.md) · [插件管理页面](../../client/ui-plugin-manager/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自两项功能的 Skill、共享的 `propose_action` 工具和卡片状态通知，由各行所在的包说明。

#### KV Cache 效果

启用本 Bundle 会在请求中加入两个 Skill 的目录条目；卡片工具只在加载卡片 Skill 后才加入声明，见[操作卡片](../action-cards/README.zh.md#model-experience)页面。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Bundle 页面列出补丁插入的每一行，包括只为两项功能提供支持的四个卡片行；页面不能把某行标为辅助行，也不能隐藏它。
- 两项功能各自的限制见其页面：[个性化页面](../creation-recommendations/README.zh.md#known-limitations-and-deferred-work)和[插件推荐](../plugin-recommendations/README.zh.md#known-limitations-and-deferred-work)。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
