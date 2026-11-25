---
description: "无需密钥的模拟模型路由，用于在没有提供方密钥时也必须作答的演示与预览。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-mock

[English](README.md) | 中文

## 概述

`dsh-llm-mock` 通过 `ctx.llm` 注册 `mock` 提供方路由，该路由只有一个模型 `mock`。该路由上的每次调用都把配置的 `reply` 作为一个文本块流式返回，然后停止。它不发送网络请求，也不读取凭据，因此部署可以在用户添加提供方密钥之前启动会话。[浏览器 Preview](../webworker-packer/README.zh.md) 把它挂载为默认模型；其他提供方路由仍可在它旁边配置。

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

在 `ctx.llm` 旁挂载此插件，并选择提供方 `mock`、模型 `mock`：

```yaml
- id: llm-mock
  name: '@deepseek-ai/dsh-llm-mock'
  config:
    reply: This is a mock model reply.
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mock
    model: mock
```

`reply` 是唯一的设置项；默认值为 `This is a mock model reply.`，且不得为空。模型选择器把该路由列为 **Mock**，模型为 **Mock model**，接受文本输入。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-mock)列出了可接受的字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、适配器的模型列表与固定回复流，以及适配器注册 |

适配器忽略请求内容。它在产出输出前检查一次请求 signal，因此已中止的调用会失败且不产生输出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 服务](../../llm/llm/README.zh.md)——适配器注册与流式 chunk 约定。
- [Mock LLM 服务器](../../test-support/llm-mock-server/README.zh.md)——可编写脚本的 HTTP 端点，用于测试提供方适配器与失败恢复。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该路由上没有模型接收请求：适配器用配置的文本回答每次调用。

#### KV Cache 影响

无；该路由不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **回复是固定的**：它不依赖对话内容，从不调用工具，也不报告 token 用量。
- **辅助请求收到同样的回复**：在此路由上生成的 Session 标题会重复回复文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
