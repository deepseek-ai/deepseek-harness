---
description: "使用 DeepSeek 语音合成接口合成语音，以 DeepSeek 账号或 API Key 鉴权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-text-to-speech-deepseek

[English](README.md) | 中文

## 概述

此 Provider 向 `text-to-speech` 注册 `deepseek-tts`，把每段文本发送到 DeepSeek 语音合成接口 `POST /v1/tools/tts`，接口流式返回 24 kHz、16 位单声道 PCM。[`ctx.deepseekAuth`](../../account/deepseek-auth/README.zh.md) 为每次请求提供鉴权：优先使用 DeepSeek 账号登录，没有登录时使用 DeepSeek API Key。启用时不发送文本，也不访问任何服务。

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

[朗读 Bundle](../read-aloud-bundle/README.zh.md) 启用这一行。Provider 提供 `stella`（默认，女声）和 `tide`（男声）两个音色；每次请求用哪一个由 `text-to-speech` 决定。`idleTimeoutMs`（30,000）是使用方等待下一段音频字节的最长时间，首段字节也计入。`providerId`（`deepseek-tts`）是 `text-to-speech` 选择的注册 id。

Provider 先向 `ctx.deepseekAuth` 请求账号登录凭据，再请求 API Key，两者都绑定到该凭据所属部署 origin 下的 `/v1/tools/tts`。任一凭据已配置时为 `ready`，都没有时为带 `sign-in-required` 的 `unavailable`。部署的 base URL 指向没有 `/v1/tools/tts` 的服务时，每次请求以 `service-unavailable` 失败。

接口按提交的字符数对每次请求计费，一个汉字计 2，并且每次请求最多接受 10,000 个这样的单位，所以 Provider 声明 `maxCharacters: 5000`。Bundle 详情以界面语言链接到 DeepSeek 的语音合成指南，其中列出价格。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

每次请求携带 `text`、`voice_id`、`format: "pcm"` 和 `filter_markdown: false`；调用方发送的已经是纯文本。请求拒绝重定向，并且不会重试，因为每个提交的字符都会计费。

HTTP 401 只按状态码分类：账号登录凭据通过授权对象的 `reject()` 失效，失败为 `sign-in-required`；API Key 的失败为 `api-key-invalid`。400 与 413 对应 `text-rejected`，402 对应 `quota-exceeded`，404 对应 `service-unavailable`，408 与 504 对应 `timeout`，429 与 503 对应 `rate-limited`，其他状态码对应 `service-error`。状态码 200 下的 JSON 正文视为错误报告。从不超过 16 KiB 的正文中保留服务错误消息的前 200 个字符。

之后的拉取失败时，已经给出的音频仍然有效。读取正文失败为 `service-error`，没有音频的响应为 `service-error`，没有收到响应的请求为 `service-unavailable`。空闲计时只在有拉取等待时进行，所以播放比合成慢的使用方不会让请求超时。账号退出登录会以 `sign-in-required` 结束请求，调用方取消则以调用方给出的原因结束。失败时以 `[text-to-speech-deepseek]` 前缀记录 endpoint 路径、状态码和服务消息，不记录文本或凭据。

凭据记录或引用变化时，以及账号服务挂载或移除时，会重新检查可用状态；以最新一次检查为准，销毁后停止发布。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[朗读子系统](../../../docs/subsystems/read-aloud.zh.md) · [分段控速决策](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为合成读取的是已经生成的文本，返回的临时音频不进入模型请求。

#### KV 缓存影响

没有影响；模型请求、消息和 Session 事件都不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 响应在音频没有发完时正常结束，无法与完整的响应区分，因为 PCM 流不带长度。语种由服务根据文本识别，不接受语种选择。不能调节语速。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

测试通过回环替身 `tests/service-double.ts` 配合真实的 `DeepSeekAuth` 运行。没有测试调用生产接口。2026-11-23 生产接口对无效的 `x-dsh-auth-token` 回答为无效的账号 token，对缺少凭据回答为缺少 key，说明它识别两种凭据；本仓库没有用有效凭据做过合成。

</details>
