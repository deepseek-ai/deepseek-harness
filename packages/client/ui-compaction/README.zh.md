---
description: "右侧 Sidebar 的压缩 checkpoint 预览：在内容 tab 中以 Markdown 显示 compact 后模型读到的替换消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

[English](README.md) | 中文

## 概述

在共享侧栏内容预览中打开 checkpoint 替换消息。点击聊天压缩行时，Chat 调用 `ctx.compactionPreviews.open(address, seq, signal)` 读取指定 checkpoint，插件再把 Markdown 直接交给 `ctx.contentPreviews.open`。

## 目录

- [注册了什么](#what-it-registers)
- [读取 checkpoint](#reading-a-checkpoint)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

插件注入 `locale`、`remote` 和 `remote.session`，注册自身词典，并在可选 `contentPreviews` 服务可用期间提供 `compactionPreviews`。卸载会移除服务和词典，不贡献标签类型或资源协议。

<a id="reading-a-checkpoint"></a>
## 读取 checkpoint

调用方传入完整的普通或子代理 `SessionAddress` 及替换消息序号。一次 `remote.session.events` 请求使用 `throughSeq: seq` 和 `maxMessages: 1`，按精确序号查找 checkpoint `user/message`。消息不存在或读取失败会返回本地化错误行。发起操作的聊天行负责取消，取消或插件卸载后不会打开预览。

文本块直接拼接，保持与模型适配器一致；非文本块转换为本地化标签。共享内容预览接收 Markdown、本地化标题和包含会话标识的 checkpoint key。重复打开会复用预览，刷新浏览器后临时输入过期。

<a id="model-experience"></a>
## 模型体验

无，因为本包只显示模型已经读到的 checkpoint，不注册工具、提示词段或会话事件。

#### KV Cache 影响

无直接影响；读取 checkpoint 不组装也不修改模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>
- **非文本 block 只显示标签。** 替换消息中的图片、文件等非文本 block 显示为本地化的占位文字，不显示其内容。
- **后端的外层文字原样显示。** 每个压缩后端用各自固定的说明文字和标签包裹摘要；预览按原文显示，因此不同后端在摘要周围的文字不同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
