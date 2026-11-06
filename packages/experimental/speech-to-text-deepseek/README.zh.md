---
description: "使用 DeepSeek One-Shot 云端服务识别完整录音。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-deepseek

[English](README.md) | 中文

## 概述

此 Provider 向 `speech-to-text` 注册 `deepseek-asr`，把每段完整录音以 16 kHz 单声道 PCM16 裸数据发送到 DeepSeek One-Shot 转写接口。它使用已登录的 DeepSeek 账号鉴权，只有存在已保存的账号时才接受录音。启用时不访问识别服务。

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

[语音输入 Bundle](../voice-input-bundle/README.zh.md) 启用这一行。`endpoint` 是完整的转写 URL，默认为 `https://harness.deepseek.com/api/v0/asr/transcribe`。必须使用 HTTPS；`allowLoopbackHttp: true` 只允许以明文 HTTP 访问本机回环地址上的服务替身。endpoint 不能包含凭据、query 或 fragment。`timeoutMs`（30,000 毫秒）、`maxRequestBytes`（3,932,160）、`maxDurationSeconds`（120）和 `maxResponseBytes`（65,536）限制单次请求。

与账号模型路由相同，每次请求都把 DeepSeek 账号服务为 `endpoint` 发放的令牌作为 `x-dsh-auth-token` 发送。账号服务只为它允许的 origin 发放令牌，其中包括它的 `harnessOrigin`，默认是 `https://harness.deepseek.com`；因此自定义 `endpoint` 需要配置相应的 `harnessOrigin`；已保存账号却拿不到该 endpoint 的令牌时，就绪状态报告失败，而不是要求登录。服务拒绝令牌（HTTP 401、code 40002 或 40003）时，只作废被拒绝的那个令牌，账号随之退出登录，失败提示用户重新登录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

就绪状态跟随账号服务的 `watch()` 流；以最新一次检查为准，卸载后不再发布。没有账号服务或没有已保存账号时，Provider 处于带 `sign-in-required` 的 `unavailable`，自动选择会跳过它。`prepare()` 只重新检查；没有需要下载或取消的资源。

录音先按规范 WAV 校验，去掉 44 字节头，再补零到 32 字节的整数倍（最多 1 毫秒静音），因为服务拒绝其他长度的裸 PCM。multipart 请求体包含 `file`、`format=pcm` 和新生成的 `audio_id`；发送前检查完整长度。`languages`（默认 `auto`、`zh`、`en`、`ja`、`es`、`fr`、`de`、`ru`、`pt`、`yue`、`ko`）列出服务的语言代码，必须包含 `auto`。`auto` 以外的已列出提示作为 `preferred_language` 发送；`auto` 不发送。客户端的界面语言按服务的写法作为 `x-client-locale` 发送：连字符换成下划线，单独的 `zh`、`en`、`pt` 补上地区 `CN`、`US`、`BR`。服务综合这两个值匹配语言。请求拒绝重定向，令牌不会随重定向转发。

服务按 `audio_id` 去重，因此在没有收到响应、HTTP 5xx 或 `biz_code 3` 时，原样重新提交一次。其他结果都是最终结果：`biz_data.code` 6 和 10 返回空文本；1、2、4、7、8 分别映射为 `service-unavailable`、`rate-limited`、`invalid-audio` 和 `timeout`；11（`daily_limit_reached`，当日识别时长额度已用完）映射为 `quota-exceeded`；HTTP 429 映射为 `rate-limited`；其他状态码、code 和格式错误的响应映射为 `service-error`。失败时抛出 `SpeechTranscriptionError`，并以 `[speech-to-text-deepseek]` 前缀记录 endpoint 路径、状态码和返回码，从不记录音频、令牌或响应正文。

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

- 只支持对完整录音做 One-Shot 转写，不使用 WebSocket 流式接口和 `fetch_cached`。录音不能超过 120 秒。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

测试都使用本机回环服务替身：Provider 测试使用 `tests/service-double.ts`，`apps/web/tests/voice-input-cloud.e2e.ts` 在发布的组合中验证浏览器登录与听写。没有测试访问生产接口，因为其账号令牌只能通过交互式浏览器登录获得。

</details>
