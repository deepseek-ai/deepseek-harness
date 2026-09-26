---
description: "具名实验性转写 Provider 及取消操作的所有权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text

[English](README.md) | 中文

## 概述

此服务定义通过 `ctx.speechToText` 选择具名语音识别器。消费者先解析请求再执行，Provider 独立注册。

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

通过[语音输入 Bundle](../voice-input-bundle/README.zh.md)加载，或组合此服务、Provider 与消费者。`defaultProvider` 为必填项，选择确切的注册 id；Bundle 提供 `sensevoice-local`。`language` 提供省略的语言提示。缺失或重复的 Provider 会明确报错。

提供方通过 `downloadSources` 公布准备阶段可用的源。`prepare(id, options)` 为单次任务转发可选的 `downloadSource`；提供方校验选择，并拒绝在准备期间改源。省略时沿用提供方策略。下载源选择不属于持久化的识别偏好。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`resolve()` 捕获 Provider 实例、录音和语言。`transcribe()` 拒绝已撤销或替换的注册。注册的清理函数先拒绝新请求，再取消已接收的请求并等待 Provider 完成；Provider 必须响应取消。服务不会回退到其他识别器或上传音频。不发布运行时不变量伴随模块，因为注册表是 Provider 与准备状态观测的唯一来源。

`defaultProvider` 与 `language` 是 volatile Config 字段：`configure()` 通过 `settings` 服务把传入的字段写入本插件的 profile 条目，运行中的实例无需重挂载即可读到更新值；保存覆盖值之前使用组合配置默认值。Settings 使用条目配置中的 id（`entry.options.id`）定位条目，不包含 Loader 的 Include 路径。没有 `settings` 或 profile 条目时 `configure()` 失败，并在保存前拒绝所选 Provider 不支持的语言。Provider 通过 `languages` 公布支持的语言提示；`resolve()` 在转写前校验所选提示。观察者通过完整 `SpeechSnapshot` 接收 Provider 拥有的准备状态；关闭观察者不会取消准备。

`./wave` 辅助函数为 Remote 消费者与原生识别进程校验规范的 16 kHz 单声道 PCM16 WAV。两者均在解码采样前拒绝不一致的头部和长度。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为录音与准备不进入模型请求；之后的文字由普通用户提交拥有。

#### KV 缓存影响

没有直接影响；普通提交拥有消息内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持完整录音转写。服务没有流式识别或语音合成方法。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
