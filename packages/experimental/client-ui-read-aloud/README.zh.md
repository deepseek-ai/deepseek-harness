---
description: "在消息操作栏朗读助手回复，随播放进度请求合成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-read-aloud

[English](README.md) | 中文

## 概述

此 Client 插件在每条已完成的助手回复下方的操作栏添加朗读按钮。点击后通过 [`readAloud` Remote](../read-aloud/README.zh.md) 朗读该回复，并在浏览器中播放音频。插件每次只请求一段，并且只在已收到的音频所剩不多时才请求，所以提前停止后，后面的段不会被合成，也不会计费。

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

[朗读 Bundle](../read-aloud-bundle/README.zh.md) 启用这一行。按钮空闲时显示喇叭；从点击到出声之间，以及播放等待音频时，显示四根依次闪动的短条；朗读时显示业务色的跳动波形。悬浮提示为「朗读」，朗读中为「停止朗读」，再点一次即停止。开始朗读另一条回复会停止当前的朗读。

只有在 Host 报告合成为 `ready`，并且当前 Peer 可以调用 `readAloud/synthesize` 时，按钮才出现；没有 DeepSeek 账号登录或 API Key 时不显示。正在朗读的那条消息始终保留按钮，所以朗读总能被停止。原本只在悬停或聚焦时显示的操作栏，在其回复被朗读期间保持显示。

失败时，已收到的音频播完后朗读结束，并在输入框上方弹出提示说明原因。对于可能恢复的失败（服务繁忙或无法访问、超时、响应中断），再次点击同一条回复会从失败的那一段继续。离开 Session 会停止它的朗读并丢弃它的提示。

Bundle 详情里有音色偏好：一个字段列出 Provider 的音色，选中即保存到 Host，之后开始的朗读使用它；没有保存成功时在字段下方说明。字段旁边的喇叭用保存的音色播放一句简短的试听，状态与朗读按钮的三种状态相同，失败以弹出提示报告；没有可用凭据时它不可点，离开详情会停止试听。朗读和试听会互相打断。详情还说明合成按提交的字符计费，列出服务支持朗读的语种并说明语种按文字自动识别，以界面语言链接到 DeepSeek 的语音合成指南，并在没有可用凭据时提供登录入口。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`Reader` 拥有一次朗读。它向 Host 请求规划，然后对每一段：等到播放器中未播放的音频不超过 `dispatchBelowMs`，打开这一段的流，并把每一帧排入队列。一个定时器在队列应当播完时唤醒：如果后面还有音频，阶段回到 `loading`。已停止的运行通过对象标识识别，所以之后到达的帧和失败不会改变任何状态。

`createPcmPlayer` 在处理点击时为每次朗读打开一个 `AudioContext`，把每一帧转换成缓冲区，并让它恰好从上一帧结束的位置开始播放。关闭时停止排队的音源并释放输出。

按钮以 `read-aloud` 注册到 `conversation.chat.assistant-actions`（order 20，排在评价按钮之后），提示以 `read-aloud-notice` 注册到 `conversation.input.overlay`，详情以 Bundle 的 key 注册到 `plugins.bundle.config`。三者共享一个 `Reader` 和一个可用状态镜像。朗读期间按钮带有 `data-action-ongoing`，`ui-chat` 读取这个属性，让悬停才显示的操作栏保持可见。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[朗读子系统](../../../docs/subsystems/read-aloud.zh.md) · [分段控速决策](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为按钮在浏览器中播放临时音频，不向 Agent 提交任何内容。

#### KV 缓存影响

没有影响；模型请求、消息和 Session 事件都不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 没有暂停、进度显示和语速控制，同一时间只有一次朗读。Session 离开屏幕时朗读会停止，包括输入框被卸载的布局。播放需要浏览器允许页面在点击后打开音频输出。提示只在其 Session 位于屏幕上时显示。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

`tests/reader.client.spec.ts` 用假定时器和与之绑定的音频时钟驱动控速循环。`tests/player.client.spec.ts` 使用 `AudioContext` 替身。`tests/components.client.spec.tsx` 渲染按钮、提示和详情，`tests/mount.client.spec.ts` 覆盖注册和销毁。`src/client/index.ts` 导入生成的 Remote 定义，由 `apps/web/tests/read-aloud.e2e.ts` 运行。

</details>
