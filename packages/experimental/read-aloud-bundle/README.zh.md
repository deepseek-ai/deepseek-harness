---
description: "启用实验性的助手回复朗读，使用 DeepSeek 云端语音合成。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-read-aloud-bundle

[English](README.md) | 中文

## 概述

这个可选 Bundle 在助手回复下方添加朗读按钮。它组合了[合成注册表](../text-to-speech/README.zh.md)、[DeepSeek 云端合成](../text-to-speech-deepseek/README.zh.md)、[朗读 Remote](../read-aloud/README.zh.md) 和[浏览器按钮](../client-ui-read-aloud/README.zh.md)。朗读使用 DeepSeek 云端语音合成，按提交的字符向 DeepSeek 账号或 API Key 计费。

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

在 **插件** 中开启这个 Bundle。登录 DeepSeek 账号或配置 DeepSeek API Key 后，每条已完成的助手回复下方会出现喇叭按钮；两者都没有时，Bundle 详情会说明缺少什么，并提供登录入口。详情以一张功能预览图开头：一条回复、高亮了朗读按钮的操作栏，以及它变成的语音。

回复随播放进度逐段提交合成，所以提前停止的朗读只为已经请求的段计费。`read-aloud` 行设置段长（`segmentSeconds`，30）和请求下一段的时机（`dispatchBelowSeconds`，15）；音色在 Bundle 详情里选择，保存在 `text-to-speech` 行（`voice`，`stella` 或 `tide`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`cordis.patch.yml` 插入四行：带 `defaultProvider: deepseek-tts` 的 `text-to-speech`、`text-to-speech-deepseek`、`read-aloud` 和 `ui-read-aloud`。包入口在运行时不导出任何内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[朗读子系统](../../../docs/subsystems/read-aloud.zh.md) · [分段控速决策](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为被组合的插件读取已存储的回复，播放的临时音频不进入模型请求。

#### KV 缓存影响

没有影响；模型请求、消息和 Session 事件都不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- DeepSeek 云端合成是唯一的 Provider，所以朗读需要 DeepSeek 凭据和网络连接。代码块、表格和公式不会朗读，插件页没有说明这一点。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

`apps/web/tests/read-aloud.e2e.ts` 在实际交付的 Web 组合上启用这个 Bundle，并以回环合成替身朗读一条预置的回复。

</details>
