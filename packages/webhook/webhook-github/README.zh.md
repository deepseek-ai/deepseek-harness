---
description: "面向把已认证 JSON 事件路由到 webhook 运行时的部署，说明带签名的 GitHub webhook 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-github

[English](README.md) | 中文

## 概述

`dsh-webhook-github` 会在注入的 `ctx.webServer` 上注册一条精确 HTTP 路由。它限制并验证 GitHub 原始 JSON body，投影提供方无关的交付，调用 `ctx.webhookRuntime.dispatch()`，并在不等待规则或 Session 的情况下返回 `202`。部署需要为通用 webhook runtime 提供经过身份验证的 GitHub 入口时，请使用它。

## 目录

- [配置](#configuration)
- [HTTP 约定](#http-contract)
- [专用监听器组合](#dedicated-listener-composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| Key | 含义 |
|---|---|
| `source` | 携带给规则的非空适配器实例，例如 `primary-github`。 |
| `path` | 不带尾随斜杠、查询或片段的精确非根路径。 |
| `secretEnv` | 包含 GitHub webhook 密钥的凭据引用。 |
| `maxBodyBytes` | 未改动请求 body 的正安全整数上限。 |

所有字段均为必填。每次请求都会重新解析密钥引用，因此轮换会在下一次交付生效，而无需重新加载插件。

<a id="http-contract"></a>
## HTTP 约定

只接受 `POST application/json`。适配器读取有界 UTF-8 body，要求 `X-Hub-Signature-256`、`X-GitHub-Delivery` 与 `X-GitHub-Event`，解析密钥，在 JSON 解析前验证 HMAC，并要求顶层是无损 JSON 对象。它绝不记录密钥、签名或 payload。

| 状态 | 含义 |
|---|---|
| `202` | 已验证 JSON 已在内存中分发。 |
| `400` | 必需 header、UTF-8、JSON 或顶层对象无效。 |
| `401` | 签名无效。 |
| `405` | 方法不是 `POST`。 |
| `413` | 声明或流式 body 超过 `maxBodyBytes`。 |
| `415` | media type 不是 `application/json`。 |
| `503` | 凭据或 webhook runtime 不可用。 |

`202` 不表示任何规则已经匹配，也不表示已创建 Session。GitHub 事件特定字段的验证属于各规则；适配器只保证通过身份验证的通用 JSON。

<a id="dedicated-listener-composition"></a>
## 专用监听器组合

普通 Web profile 已经拥有 `ctx.webServer`。把另一个 `dsh-host-webserver` 和此适配器挂载到仅隔离 `webServer` 的 group 内；适配器仍会继承凭据与 `webhookRuntime`。[GitHub 评审指南](../../../docs/user/guide/github-review.zh.md)在 TLS 反向代理后使用 `127.0.0.1:3081/github`，而 UI 继续位于端口 3080。

<a id="model-experience"></a>
## Model Experience

通过 `dsh-webhook` 间接产生影响：此适配器不贡献提示词或工具 schema；匹配规则拥有 Session 请求与模型可见文本。

#### KV Cache effect

相互独立。身份验证与 HTTP 分发不触碰模型请求；任何新 Session 前缀都属于消费它的规则与 runtime。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **无 TLS** — 注入的开发 WebServer 通常只监听 loopback，并位于 TLS 反向代理或 tunnel 后。
- **仅通用 payload 验证** — 规则负责验证自己消费的 GitHub 事件字段。
- **不向提供方确认下游工作** — `202` 先于任意规则调用与 Session 创建。
- **不支持表单编码** — GitHub 必须发送 `application/json`；`application/x-www-form-urlencoded` 会被拒绝。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。authentication 与 input validation 在对应 HTTP 操作中完成；route/disposer 对称性由 `dsh-host-webserver` 负责。
