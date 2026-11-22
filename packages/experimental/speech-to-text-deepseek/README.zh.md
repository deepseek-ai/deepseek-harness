---
description: "使用 DeepSeek 语音识别接口识别完整录音，以 DeepSeek 账号或 API Key 鉴权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-deepseek

[English](README.md) | 中文

## 概述

此 Provider 向 `speech-to-text` 注册 `deepseek-asr`，把每段完整录音发送到 DeepSeek 语音识别接口 `/v1/tools/asr`。[`ctx.deepseekAuth`](../../account/deepseek-auth/README.zh.md) 为每次请求提供鉴权：优先使用 DeepSeek 账号登录，没有登录时使用 DeepSeek API Key，因此只要配置了其中一种就接受录音。启用时不访问任何服务。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[语音输入 Bundle](../voice-input-bundle/README.zh.md) 启用这一行，不需要配置：endpoint 与凭据都来自 `ctx.deepseekAuth`，所有挂载了 DeepSeek 模型路由的组合都会挂载它。`timeoutMs`（30,000 毫秒）限制包括响应正文在内的整次请求；`maxRequestBytes`（8 MiB）、`maxDurationSeconds`（120）和 `maxResponseBytes`（65,536）限制单次请求。

Provider 先向 `ctx.deepseekAuth` 请求账号登录凭据，再请求 API Key，两者都绑定到该凭据所属部署 origin 下的 `/v1/tools/asr`：账号路由的 base URL 及账号服务为它发放的 token，或 API Key 路由的 base URL 与 key；没有 API Key 路由时为发往 `https://api.deepseek.com` 的 `DEEPSEEK_API_KEY`。配置了任一种凭据时处于就绪状态，两者都没有时处于带 `sign-in-required` 的 `unavailable`。部署的 base URL 指向没有 `/v1/tools/asr` 的服务时，每次录音都以 `service-unavailable` 失败。这一计费顺序与 Search、Fetch 接口不同，后两者在对话之外先用 API Key。

云端识别按音频时长向完成鉴权的凭据计费；Bundle 详情按界面语言链接 DeepSeek 的语音识别指南。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

凭据记录或引用变化、账号服务挂载或移除、调用 `prepare()` 时都会重新检查就绪状态；以最新一次检查为准，卸载后不再发布。某种凭据的路由配置无法解析时发布 `failed`，录音也在此停止并报告 `service-error`，与 `authorize()` 一致。没有需要下载或取消的资源。

录音先按规范 WAV 校验，确认时长不超过 `maxDurationSeconds`、大小不超过 `maxRequestBytes`，再原样作为唯一的 multipart 字段 `file` 发送。请求体按字节编码而不使用 `FormData`，因为上传被提前取消时，undici 的 `FormData` 写入流程会产生未处理的 rejection。服务自动判断语言，所以 Provider 只声明 `auto`。请求拒绝重定向。

服务没有幂等键且按时长计费，所以任何请求都不重试。HTTP 401 只按状态码分类，不依赖读取响应正文：账号登录凭据通过授权的 `reject()` 作废，失败为 `sign-in-required`；API Key 失败为 `api-key-invalid`，配置的 key 无法使用时同样如此。400 与 413 映射为 `invalid-audio`，402 为 `quota-exceeded`，404 及没有收到响应的请求为 `service-unavailable`，408 与 504 为 `timeout`，429 与 503 为 `rate-limited`，其他状态码或格式错误的正文为 `service-error`。请求期间账号退出登录时，请求以 `sign-in-required` 结束。失败时抛出 `SpeechTranscriptionError`，并以 `[speech-to-text-deepseek]` 前缀记录 endpoint 路径、状态码和服务返回的消息，从不记录音频或凭据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为录音与转写不进入模型请求；之后的文字由普通用户提交拥有。

#### KV 缓存影响

没有直接影响；普通提交拥有消息内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只支持对完整录音做一次性识别，不支持流式识别，也不能指定语言。录音不能超过 120 秒或 8 MiB。服务拒绝账号登录凭据时，会在读完整段录音之前断开连接，因此这次拒绝表现为 `service-unavailable`，登录凭据要等模型请求或较短的请求收到 HTTP 401 后才会作废。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

测试都使用本机回环服务替身：Provider 测试用 `tests/service-double.ts` 配合真实的 `DeepSeekAuth`，`apps/web/tests/voice-input-cloud.e2e.ts` 在发布的组合中验证浏览器登录与听写。没有测试访问生产接口，因为其账号令牌只能通过交互式浏览器登录获得。

</details>
