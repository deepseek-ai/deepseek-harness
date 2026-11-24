---
description: "为浏览器端的控速朗读规划助手回复，并逐段合成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-read-aloud

[English](README.md) | 中文

## 概述

`ctx.readAloud` 提供实验性的 `readAloud` Remote 命名空间。它在已存储的 Session 日志中找到一条已完成的助手消息，把 Markdown 转成朗读文本，切成每段约 30 秒的段，并通过 `ctx.textToSpeech` 每次调用合成一段。Client 只在播放接近已有音频末尾时才请求下一段，所以听者还没听到的文本不会被提交。朗读不增加 Session 事件，也不增加模型输入。

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

[朗读 Bundle](../read-aloud-bundle/README.zh.md) 启用这一行。`segmentSeconds`（30，范围 5 到 300）是一次合成请求所带文本的估算朗读时长。`dispatchBelowSeconds`（15，范围 1 到 300）是 Client 请求下一段时，已收到的音频最多还可以有多少没有播放。段越短，提前停止后已付费却没听到的音频越少，但请求更多，语调重新起头的次数也更多。

`follow(signal)` 在每次变化时流式给出状态：`ready`、`sign-in-required` 或 `unavailable`，以及在配置的 Provider 已注册时它的音色 id、保存的音色和采样率。`configure({ voice })` 保存之后朗读使用的音色。`plan({ sessionId, messageId })` 返回消息在日志中的位置、以朗读文本区间表示的各段、`dispatchBelowMs`、采样率和当时保存的音色；文本不离开 Host。`synthesize({ sessionId, messageId, seq, voice, start, end })` 用计划中的音色为一个已规划的段流式返回帧，每帧是 200 毫秒的 base64 编码 16 位单声道 PCM，所以一次朗读只用一个音色。`sample({ voice, language })` 为 Host 固定的一句话（中文、英文或日文；其他语言使用英文那一句）流式返回同样的帧，供听者比较音色。

段落、标题、引用和列表项各读作一行。强调、链接和行内代码保留文字。代码块、表格、图片、HTML、分隔线、块级公式和脚注不读，行内公式只有不超过 20 个字符时才读。块级公式是成对 `$$` 之间的文字。行内公式是同一行里两个 `$` 之间的文字，并且开头的 `$` 后面紧跟非空白字符，结尾的 `$` 前面紧跟非空白字符、后面不紧跟数字，所以 `$20` 这样的金额仍是普通文字；代码和 HTML 里的美元符号不算分隔符。剩余内容里没有任何字母或数字的回复没有段。

Session 中没有这条助手消息时，`plan` 与 `synthesize` 以 `readAloud/message-not-found` 拒绝。请求的区间不是该消息在当前配置下的一个段时，`synthesize` 以 `readAloud/stale-plan` 拒绝；合成失败时以 `readAloud/synthesis-failed` 拒绝，Provider 已分类时带上它的失败码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

一段的估算达到 `segmentSeconds` 后在句末收段，达到 1.5 倍后在分句标点或空格处收段，达到 2 倍后可在任意位置收段。剩余部分的估算不超过目标的一半时并入前一段，任何段都不超过 Provider 的 `maxCharacters`。段之前、之间或之后没有字母或数字的文本不属于任何段。估算时，表意文字、假名、谚文音节或数字计 200 毫秒，其他字母计 70 毫秒，句末计 300 毫秒，分句标点计 150 毫秒。规则和数值沿用 DeepSeek chat 服务；取舍见决策记录。

消息以每次 256 个事件的窗口从存储中读取：日志长度已知时从末尾向前，否则从头向后。活动的 Session 会先落盘。`plan` 报告事件的序号，`synthesize` 只读取这一个事件并核对其标识。控制器不保存朗读状态：每次调用都重新推导文本和分段，所以配置变化会表现为 `readAloud/stale-plan`。

两个朗读方法都把所指的 Session 声明为访问资源；liveshare 的访问者分类把这个命名空间列为仅所有者可用，因为合成费用由所有者支付。Client 取消时，Provider 请求随之结束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[朗读子系统](../../../docs/subsystems/read-aloud.zh.md) · [分段控速决策](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为朗读读取已存储的回复，返回的临时音频不进入模型请求。

#### KV 缓存影响

没有影响；模型请求、消息和 Session 事件都不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只能朗读已完成的助手消息，仍在流式生成的回复不能朗读。用 TeX 分隔符 `\(…\)` 或 `\[…\]` 写的公式会被当作普通文字读出，分隔符内侧带空格的写法（如 `$ x $`）也一样。同一行里前置和后置美元符号混用的文字（如 `$5 … 4$`）仍会被当成公式。估算针对中文和英文调校，不是实测音频，所以一段的实际时长与 `segmentSeconds` 有出入。每段是一次独立的合成，所以语调在段的边界重新起头。存储后端不提供事件数的 Session 从第一个事件开始查找。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

`tests/segments.spec.ts` 固定每条收段规则，`tests/speech-text.spec.ts` 固定 Markdown 转换，`tests/message.spec.ts` 固定窗口查找，`tests/controller.spec.ts` 在存储日志替身上固定各 Remote 方法。`apps/web/tests/read-aloud.e2e.ts` 以回环合成替身运行实际交付的组合。

构建把 Markdown 解析器嵌入包入口，清单把它列在 `devDependencies` 下。如果作为运行时依赖安装，Web Worker 里的 Host 会解析到解析器的浏览器构建，它在导入时读取 `document`。数学语法包没有引入，因为它们会安装 KaTeX；`speech-text.ts` 改为按美元分隔符找公式。

</details>
