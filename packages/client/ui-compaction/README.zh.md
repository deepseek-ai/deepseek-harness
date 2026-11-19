---
description: "在右侧栏预览会话日志中的压缩摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

[English](README.md) | 中文

## 概述

Chat 通过 `ctx.compactionPreviews.open(address, summarySeq, signal)` 打开已记录的压缩摘要。侧栏保存 `dsh-resource://compaction/` 地址，恢复标签时从会话历史重新读取 Markdown。

## 目录

- [注册了什么](#what-it-registers)
- [读取摘要](#reading-a-summary)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

插件注册 `compaction` 资源提供方。当文档预览服务可用时，插件注册摘要标签、标题、正文及会话导航服务。

<a id="reading-a-summary"></a>
## 读取摘要

地址标识会话及摘要序号。子代理地址包含父会话、子会话和模式。标签使用 `throughSeq` 和 `maxMessages: 1` 读取对应的 `compaction/summary` 事件。摘要缺失、为空或读取失败时，标签显示错误。已取消的打开请求跳过导航，关闭标签时释放资源订阅。

摘要文本块按顺序拼接，由共享 Markdown 文档渲染器显示。重复打开同一地址会复用标签。

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
