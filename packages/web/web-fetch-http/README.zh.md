---
description: "ctx.web 的匿名公共 HTTP(S) 抓取后端：部署方如何挂载有界、安全的 URL 抓取，含同源重定向与仅文本解码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-http

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-http`，harness 可以通过 web 服务（`ctx.web`）抓取公共 HTTP(S) 页面，并在不发送凭据的情况下获得状态码与有界、解码后的内容。当组合需要 URL 校验、公开地址解析、连接固定、仅同源重定向、字节和字符上限及显式产品 `User-Agent` 时选择它。它把非 2xx 响应作为结果而非错误返回，并拒绝非公开目标、二进制数据与不受支持的内容类型。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`，由它渲染本提供方的正文。

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

在已加载 web 服务的组合中挂载本提供方；它以 `http` 抓取提供方身份注册，因此当它是唯一可用的抓取后端时，`ctx.web.fetch()` 会自动解析到它——也可以用 `fetchProvider: http` 固定。

### 何时选择

当部署必须以有界输出和安全传输抓取公共页面时选择此后端：不发送凭据，每个已解析地址必须是公共地址，每次连接都固定到已校验的地址集合，重定向无法逃出源站，每个响应都有上限。

### 最小配置

加载 web 服务与本提供方；可配置上限都有安全默认值，并在插件构造时验证，因此无效值会响亮地失败，而不是构造出上限荒谬的提供方。URL 安全上限固定为 2,048 个字符。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxResponseBytes` | `5,000,000` | 响应主体最大字节数 |
| `maxBodyChars` | `100,000` | 解码主体最大字符数 |
| `timeoutMs` | `30,000` | 抓取超时——资源兜底，不是面向模型的工具预算 |
| `maxRedirects` | `5` | 同源重定向最大跳数（`0` 表示不跟随） |
| `userAgent` | `deepseek-harness/…` | 每次请求发送的 `User-Agent` 标头 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-http)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 抓取返回什么

成功调用产生 `WebFetchResult`：允许的重定向之后的最终 URL、HTTP 状态码、分类为 `html` 或 `text` 的解码正文，以及 `truncated` 标志。非 2xx 响应是结果而非错误——状态码是被抓取资源状态的一部分；`WebError` 只用于无法安全获取或表示资源的失败。

```text
const page = await ctx.web.fetch({ url: 'https://example.com' })
// page.body.kind === 'html' | 'text'; page.statusCode === 200 | 404 | ...
```

### 传输行为

提供方保持请求匿名且有界：只接受不含内嵌凭据且不超过 2,048 个字符的 `http:` 与 `https:` URL。它只解析一次主机名；只要结果中有任何 IPv4 或 IPv6 地址不是公共单播地址，就拒绝整个结果，并把连接固定到已校验的地址集合。IPv6 检查会发现活动 DNS64 前缀，并拒绝指向非公开 IPv4 的转换地址。每次同源重定向都会重复解析与固定；跨源重定向会失败并要求重新调用。提供方还强制执行字节、字符、跳数和时间上限，拒绝不支持的内容类型，并发送显式产品 `User-Agent`。

### 失败与恢复

失败抛出携带可按机器路由 code 的 `WebError`：`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_REDIRECT_BLOCKED`、`WEB_UNSUPPORTED_CONTENT_TYPE`、`WEB_ABORTED` 或 `WEB_PROVIDER_ERROR`。直接调用方可以按 code 路由；面向模型的 `web_fetch` 工具会在自己的错误包装层内把失败文本呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个分离与一个分层超时之上：

- **安全获取与呈现分离。** 本提供方拥有 URL 校验、公开地址强制规则、连接固定、HTTP 传输、重定向策略、上限、charset 解码与二进制拒绝；`dsh-tool-web` 拥有 HTML→markdown 与截断格式化。非 2xx 响应是数据，不是失败。
- **两层超时。** 提供方的 `timeoutMs` 是直接 `ctx.web.fetch()` 调用方的资源兜底；面向模型的工具调用预算属于 `dsh-tool-call-timeout-policy`，由它触发 `exec.signal`。外层截止期限先到时，提供方报告 `WEB_ABORTED`，策略再以 `TOOL_TIMEOUT` 替换；因此 `WEB_FETCH_TIMEOUT` 标识的是提供方预算耗尽的直接服务调用方。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、上限验证、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `HttpFetchProvider`：固定连接、重定向跟随、有界读取、charset 解码 |
| [`src/network.ts`](src/network.ts) | 公开地址解析、DNS64 发现与连接固定 |
| [`src/policy.ts`](src/policy.ts) | URL 校验、同源检查、内容类型分类、charset 解析 |
| — | 不发布运行时不变式伴生入口；上限在提供方处强制执行。 |

### 读取路径

抓取先校验 URL，只解析一次主机名，结果中只要有非公开地址就拒绝，并把连接固定到已接受地址。每次同源重定向都重复该检查；跨源重定向或非公开目标在接收响应字节前失败。最终响应按 `Content-Type` 分类、依声明的 charset 解码，并在字节上限内读取；解码后的文本再截断到字符上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的抓取请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方正文的面向模型 `web_fetch` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-http)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxBodyChars` 限制的解码文本或由 HTML 转换得到的 markdown 置于抓取结果包装层内，而重定向、标头与传输上限保持隐藏。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方何时不安全或不合适。它们是当前包约束。

- **只解码文本内容**——包括 html/xhtml 与 `text/*` 加 JSON/XML 家族；缺少 `Content-Type` 或任何二进制类型都会抛出 `WEB_UNSUPPORTED_CONTENT_TYPE`，可提取文本的 PDF 解码属于明确的延期工作。
- **charset 只来自 `Content-Type` 标头**（默认 UTF-8）——HTML `<meta charset>` 声明会被忽略；声明但无法识别的 charset 标签会抛出异常，而非回退。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
