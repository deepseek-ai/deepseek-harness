---
description: "把朗读文本交给已注册的语音合成 Provider，并流式返回它的音频。"
kind: "package-reference"
---

# @deepseek-ai/dsh-text-to-speech

[English](README.md) | 中文

## 概述

`ctx.textToSpeech` 是实验性的语音合成 Provider 注册表。Provider 以一个 id 注册，同时给出音频格式、文本长度上限和可用状态。使用方按配置的 Provider 解析一段文本，再从它拉取 16 位 PCM。此服务自身不做合成，也不会把文本发给配置之外的 Provider。

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

[朗读 Bundle](../read-aloud-bundle/README.zh.md) 以 `defaultProvider: deepseek-tts` 启用这一行。`defaultProvider` 必填，指定为所有请求合成的 Provider；该 Provider 未注册时发起的请求以 `service-unavailable` 失败。`voice` 是保存的音色偏好，由 `configure()` 写入；它缺省或指向该 Provider 不提供的音色时，使用该 Provider 的第一个音色。

Provider 调用 `register()`，传入 `info`（id、显示名称、`host-local` 或 `cloud`、16 位单声道 PCM 的采样率、`maxCharacters`，以及 `voices`，即一组非空的音色 id，第一个为默认）、可选的 `availability` 状态源，以及 `synthesize(input, signal)`。使用方先调用 `resolve({ text, voice })`，它捕获配置的 Provider 和音色，拒绝超过其 `maxCharacters` 的文本和该 Provider 不提供的指定音色，未指定音色时使用保存的音色；再调用 `synthesize(spec, signal)`，它以异步迭代器返回该 Provider 的音频。`snapshot()` 与 `follow(signal)` 报告每个 Provider 的可用状态、实际使用的音色和配置的 id。`configure({ voice })` 通过 `settings` 服务把配置的 Provider 提供的一个音色保存到这一行的 profile 条目，无需重启即可生效。

Provider 通过抛出带有 `SynthesisFailureCode` 的 `SpeechSynthesisError` 报告已分类的失败：`sign-in-required`、`api-key-invalid`、`rate-limited`、`quota-exceeded`、`service-unavailable`、`text-rejected`、`timeout` 或 `service-error`。使用方按错误码显示本地化文案，消息只作为 Host 诊断信息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

同一个 id 再次注册会抛错，原注册保持不变。`register()` 返回的清理函数可重复调用：它移除 Provider、取消对其可用状态的订阅、中止该 Provider 所有流收到的 signal，并等待仍在进行的 Provider 调用结束。没有人在拉取的流不占用任何 Provider 调用，所以停止读取的使用方不会拖延注销；它下一次拉取会被拒绝。

`synthesize()` 在调用 Provider 前检查调用方的 signal，并确认 spec 中的 Provider 仍是当前注册的那一个；每次拉取前后都会再次检查。提前结束迭代会同时结束 Provider 的迭代器。

`follow()` 先给出当前快照，之后每次变化给出一个。落后的订阅者只会收到最新的快照。调用方的 signal 中止或服务被销毁时，流结束。

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

- 所有请求都由配置的那一个 Provider 合成；不能按请求选择 Provider，也没有回退。这一行只保存一个音色偏好，不按 Provider 各存一个。音频只有 16 位单声道 PCM。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

`tests/service.spec.ts` 覆盖注册生命周期、可用状态发布、路由拒绝，以及注销时对进行中 Provider 调用的等待。

</details>
