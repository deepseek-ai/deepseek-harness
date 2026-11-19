---
description: "在右侧栏预览会话日志中的压缩摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

[English](README.md) | 中文

## 概述

Chat 通过 `ctx.compactionPreviews.open(address, summarySeq, signal)` 打开已记录的摘要。刷新浏览器后，从压缩行重新打开摘要。

## 目录

- [注册了什么](#what-it-registers)
- [读取摘要](#reading-a-summary)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

文档预览可用时，插件向 Chat 提供压缩摘要预览服务。

<a id="reading-a-summary"></a>
## 读取摘要

服务使用会话地址、`throughSeq` 和 `maxMessages: 1` 读取指定的 `compaction/summary` 事件。摘要缺失、为空或读取失败时，发起请求的压缩行显示错误。取消请求会停止导航。

服务将按顺序拼接的 Markdown 文本传给 `sidebarRight.openContent`。重复打开同一事件会复用标签。

<a id="model-experience"></a>
## 模型体验

无，本包只显示会话日志中的摘要，不注册工具、提示词段或会话事件。

#### KV Cache 影响

对模型请求和缓存无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>
- **部分历史。** 关联的摘要事件尚未加载时，预览按钮禁用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
