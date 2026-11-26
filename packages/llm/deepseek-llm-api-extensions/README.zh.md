---
description: "面向提供方插件的官方 DeepSeek 请求扩展注册表，用于贡献具有生命周期归属的顶层 API 字段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-llm-api-extensions

[English](README.md) | 中文

## 概述

用于向 DeepSeek 官方 LLM（大语言模型）API 请求添加顶层字段与 `x-deepseek-harness-` 请求标头的提供方特定注册表。`DeepSeekLlmApiExtensionRegistry` 注册 `ctx.deepseekLlmApiExtensions`；贡献插件分别认领一个经声明合并的字段或标头，`dsh-llm-deepseek` 则在序列化基础请求后准备当前贡献。当插件必须添加经过验证的提供方特定字段或标头且不能修改基础适配器时，请使用它。

## 目录

- [服务](#service)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

- `register(field, provider)` 为调用 fiber 保留一个字段。重复或格式错误的名称会同步失败；dispose（资源释放）该注册后，后续提供方可以再次认领。
- `prepare(request)` 对已注册提供方取快照，并发准备贡献，克隆并冻结返回的 JSON 值，然后返回 `{ fields, accept }`。某个提供方准备时抛错，注册表会省略其字段，其余字段照常返回，且只记录该字段的首次失败；请求取消会使 `prepare` 拒绝，即使某个提供方忽略信号，注册表也会停止等待。
- `accept()` 对每个捕获的 2xx 后回调只运行一次。并发调用会等待同一次结算，所有回调都在报告失败前完成，多个失败会合并为一个 `AggregateError`。
- `registerHeader(name, provider)` 为调用 fiber 保留一个经声明合并的请求标头。名称以 `x-deepseek-harness-` 开头，后接以连字符分隔的小写 ASCII 字母与数字。格式错误、重复或与适配器内置标头重名时，注册会同步失败。dispose 该注册后，其他插件可以认领该名。
- `headers(request)` 同步调用每个已注册的标头提供方，并返回冻结的非 `undefined` 值。提供方抛错，或返回的值不是两端无空白的非空可打印 ASCII 时，本次请求省略该标头，且只记录其首次省略。

每个字段提供方都会看到确切的已序列化 Messages 请求体、请求 `AbortSignal`，以及可选的 `sessionId` 与辅助调用 `purpose`。提供方必须在取消后迅速停止自身工作；字段不适用于当前请求时返回 `undefined`。即使 HMR（热模块替换）在 HTTP 接受前移除了注册，已准备的操作仍会保留其捕获的提供方。标头提供方只看到 `sessionId` 与 `purpose`。

请求的 `purpose` 是适配器转发的生产方自定义字符串，普通对话请求则省略它。注册器转发不熟悉的用途，不替各个字段决定策略。

注册表拥有字段与标头的添加和生命周期，不拥有其语义。`@deepseek-ai/dsh-session-log-deepseek` 拥有 `dsh_session_log` 以及 `x-deepseek-harness-session-type` 和 `x-deepseek-harness-subagent-parent-session-id` 标头；`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 拥有 `dsh_plugin_packages`。[DeepSeek 协议参考](../../../docs/deepseek-llm-api-wire-extensions.zh.md)定义它们的取值。提供方无关的 LLM seam 与 `llm-pi-ai` 都不消费该注册表。

<a id="model-experience"></a>
## 模型体验

通过 `@deepseek-ai/dsh-llm-deepseek` 间接生效；该包在模型的 `messages`、系统提示词与工具 schema 之外发送已注册字段与标头。

#### KV Cache 影响

无；注册表字段与标头是模型不可见的提供方元数据，不改变已序列化的模型输入前缀。

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
