---
description: "提供引用控件与 Markdown blockquote 展示的插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-message-quotes

[English](README.md) | 中文

## 概述

`dsh-message-quotes` 在 Client 注册引用控件和转录渲染。消息保留普通 Markdown 文本，无需 quote 元数据或 content 索引。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 挂载此插件。Client 入口向 `ctx.uiConversation.interactions` 注册选区操作，并通过 UserText 规则渲染引用。插件卸载时会移除这些注册。选区按钮使用共享浮层描边与阴影。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

输入框使用共享的 [Markdown 格式化工具](../../client/ui-primitives/README.zh.md#rendering-agent-output) 编码引用文本；插件负责[引用识别与解码](src/client/quote-text.ts)。Quote 预览将正文及已识别的 Session 标签作为纯文本呈现，统一文字样式，不展示 reference chip 装饰。选区是否可操作、原地定位与关闭由 conversation 交互服务负责；引用操作从 DOM 提取文本。输入框负责 QuoteNode 编辑和序列化。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 包索引](../README.zh.md) — 相关持久化和投影包。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md) — 编辑器和对话呈现消费方。

-----

<a id="model-experience"></a>
## 模型体验

### 引用消息文本

#### 模型可见内容

输入框将选中文本作为普通 Markdown blockquote 发送，每行带一个 `> ` 前缀。Session-reference 与 skill 处理照常作用于引用文本。

#### Token 影响

引用文本及其行前缀贡献普通输入 token。

#### KV Cache 影响

该插件不改写历史。消费方将编码文本作为用户内容追加到现有前缀之后。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 识别范围为最多带三个前导空格的显式引用行；不实现 Markdown 懒惰续行或代码围栏解析。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
