---
description: "面向提供方插件的官方 DeepSeek 请求扩展注册表，用于贡献具有生命周期归属的顶层 API 字段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-llm-api-extensions

[English](README.md) | 中文

## 概述

用于向 DeepSeek 官方 LLM API 请求添加顶层字段的提供方特定注册表。`DeepSeekLlmApiExtensionRegistry` 注册 `ctx.deepseekLlmApiExtensions`；贡献插件分别认领一个经声明合并的字段，`dsh-llm-deepseek` 则在序列化基础请求后准备当前贡献。当插件必须添加经过验证的提供方特定字段且不能修改基础 adapter 时，请使用它。

## 目录

- [服务](#service)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

- `register(field, provider)` 为调用 fiber 保留一个字段。重复或格式错误的名称会同步失败；dispose（资源释放）该注册后，后续提供方可以再次认领。
- `prepare(request)` 对已注册提供方取快照，并发准备贡献，克隆并冻结返回的 JSON 值，然后返回 `{ fields, accept }`。准备失败会在 HTTP 分发前拒绝请求；请求取消后，即使某个提供方忽略信号，注册表也会停止等待。
- `accept()` 对每个捕获的 2xx 后回调只运行一次。并发调用会等待同一次结算，所有回调都在报告失败前完成，多个失败会合并为一个 `AggregateError`。

每个提供方都会看到确切的已序列化基础正文、请求 `AbortSignal`，以及可选的 `sessionId` 与辅助调用 `purpose`。提供方必须在取消后迅速停止自身工作；字段不适用于当前请求时返回 `undefined`。即使 HMR（热模块替换）在 HTTP 接受前移除了注册，已准备的操作仍会保留其捕获的提供方。

注册表拥有字段添加与生命周期，不拥有字段语义。`@deepseek-ai/dsh-session-log-deepseek` 拥有 `dsh_session_log`；`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 拥有 `dsh_plugin_packages`。提供方无关的 LLM seam 与 `llm-pi-ai` 都不消费该注册表。

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-llm-deepseek` 间接生效；该包在模型的 `messages`、系统提示词与工具 schema 之外发送已注册字段。

#### KV Cache 影响

无；注册表字段是模型不可见的提供方元数据，不改变已序列化的模型输入前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **仅限 DeepSeek 官方请求**——该注册表刻意不提供提供方无关的路由，也不集成 pi-ai 适配器。
- **不约定字段顺序**——JSON 对象成员顺序取决于注册准备顺序，但接收方按名称寻址字段。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。重复所有权、detached output 与单次 acceptance settlement 都在拥有该决策的 registry 操作中强制。
