---
description: "Web 端已发送用户文本中可识别凭据的显示遮挡，交互消息中每个值带显示控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-secret-mask

[English](README.md) | 中文

## 概述

当 Web 用户把 API 密钥、令牌或密码粘贴进消息，而消息可能在共享屏幕或截图中被他人看到时，使用 `dsh-client-ui-secret-mask`。已发送的用户文本会遮挡每个可识别的凭据：密钥或令牌保留前八个字符，其余每个字符显示为 `*`。遮挡只改变显示内容；消息原文、复制操作和模型输入都保留原始字符。

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

把本包与 `dsh-client-ui-conversation` 一起挂载。Web 应用 bundle 默认挂载本包；移除该行后凭据按原样显示。[UserText Factory](../ui-conversation/README.zh.md#sent-user-text) 的每个调用方都会遮挡：消息气泡、插话消息、发送中回显、排队消息以及 `/goal` 输入气泡。

每个被遮挡的值以等宽字体显示，因此展开时不会挪动周围文字。交互文本（即已发送消息或已接纳的插话消息）会在每段末尾加一个眼睛控件。该控件显示或隐藏这一个值，每次挂载都从遮挡状态开始。其他调用方只显示遮挡后的值，不带控件。

<a id="what-is-masked"></a>
### 遮挡范围

| 值 | 示例 | 显示 |
| --- | --- | --- |
| 模型服务与 Google API 密钥 | 至少含一个数字的 `sk-…`、`AIza…` | 保留前八个字符 |
| 代码托管与包仓库令牌 | `ghp_…`、`github_pat_…`、`glpat-…`、`npm_…`、`hf_…` | 保留前八个字符 |
| 云访问密钥 ID | `AKIA…`、`ASIA…`、`LTAI…`、`AKID…` | 保留前八个字符 |
| 协作与支付令牌 | `xoxb-…`、`sk_live_…`、`rk_test_…`、`whsec_…` | 保留前八个字符 |
| JSON Web Token | `eyJ….eyJ….…` | 保留前八个字符 |
| 私钥块 | 从 `-----BEGIN … PRIVATE KEY-----` 到对应 `END` 行 | 保留 `BEGIN`、`END` 两行及换行 |
| 地址中的密码 | `postgres://user:password@host/db` | 密码全部遮挡，用作密码的令牌也一样 |

`password=…`、`API_KEY=…` 这类带名字的赋值、写在句子里的密码、验证码以及个人信息都没有公开格式，保持原样。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件注册一个 UserText 匹配器 `secret` 及其 keyed `conversation.user.text.node` renderer；`/client` 导出只有插件主体（`apply`/`inject`）。匹配器不读取 Facts，因此 Facts 更新不会再次查询它。每次查询返回请求偏移处或之后最近的凭据，返回节点之前不分配内存。一个只含字面量的交替正则找到格式可能开始的位置；字面量的后缀可能是另一个字面量的开头时，扫描从该后缀处继续。格式检查是有界的字符比较和粘性 `[字符类]*` 模式，这类模式在第一个不属于该类的字符处停止，没有可回溯的部分。`apply` 创建的匹配器实例按文本跨查询记忆字符段结尾、下一个数字和下一行私钥 `END`，因此一段文本的全部查询合计线性；实例保留最近一次查询的文本，直到查询另一段文本。同一起点上，私钥、地址密码和前缀格式依次优先；所有重叠的候选都并入最早的候选，并使用其遮挡方式。地址的 `://` 在请求偏移之前时，只有偏移后紧跟 `:`、密码和 `@` 才回看用户名，因此从地址内任何位置查询都得到同一个密码。[user-text benchmark](../../../benchmarks/user-text/user-text.bench.client.ts) 约束无凭据与含凭据文本的求值耗时、线性增长和匹配器的内存分配（[理由](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.zh.md)）。

节点 payload 只携带遮挡后的显示文本。renderer 把每段 `*` 绘制为垂直居中的标记，同时保留字符本身供复制与辅助技术读取，因为字体自带的星号靠近大写字母顶部。renderer 在该文本与节点原文之间切换，并记住已显示的原文值而不是一个开关，因此同一位置换成另一个凭据时会从遮挡状态开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-conversation 已发送用户文本](../ui-conversation/README.zh.md#sent-user-text)——匹配器注册表、调度器与节点 renderer Slot。
- [用户文本候选调度](../../../.agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.zh.md)——本匹配器遵循的向前查询与缓存规则。
- [凭据识别的性能](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.zh.md)——线性匹配器各部分的复杂度与取舍，以及耗时与内存分配门禁。

-----

<a id="model-experience"></a>
## 模型体验

无。遮挡只改变浏览器的显示内容；消息原文与模型输入都保留原始字符。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明凭据何时按原样显示；它们是本包当前的约束。

- **识别依赖公开格式**——不具备[可识别格式](#what-is-masked)的凭据按原样显示。带名字的赋值保持原样，因为同样的名字也用于 token 用量等普通值。
- **只有 UserText 调用方会遮挡**——会话标题、轮次预览、搜索摘要、目标栏、工具卡片、助手回复以及未发送的输入框都按原样显示凭据。
- **更早开始的引用显示自身文本**——位于更早开始的引用之内的凭据，例如文件提及 `@config/<key>.txt`，由该引用显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
