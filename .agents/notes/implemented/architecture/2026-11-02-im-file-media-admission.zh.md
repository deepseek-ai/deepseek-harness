# Agent Note：IM 媒体准入把非图片保留为原样文件

Status: implemented

[English](2026-11-02-im-file-media-admission.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-im` 会给已存消息的每个媒体元素打上稳定 id 标签（`[图片 #12.1]`、`[文件 #12.2 report.pdf]`、`[语音 #12.3 语音.opus]`），但只能准入图片这一种：`ImMediaStore.admit` 对 `file`、`audio`、`video` 一律返回 `skipped: 'unsupported'`，唯一的读取工具 `im_read_image` 同样拒绝它们。于是在聊天里发出文档、语音或视频的人，交给模型的只是一个打不开的标签——传输层、飞书解码器和 core 的资源抓取其实都已经带上字节（`<file src="satori:…/resources/<file_key>?type=file">`），只是没有人去消费。`media` 字段自己的契约本来就写着图片与文件都会下载，实现落后于它写下的行为。

## Decision

准入按载荷决定，而不是按种类决定。`ImMediaStore` 依旧抓取并按上限裁剪一个引用，随后把图片存成归一化的图片块，把其余每种元素通过 `ctx.attachments.saveFile` 原样存成持久文件。`ImFormatter.format({ media: true })` 把每个准入的文件作为 `file` 内容块追加在文本之后，请求装配因此把它投影成指名已保存只读路径的确定性 handle 文本——和浏览器附件的文件拿到的是同一种表示。

模型通过新增的 `im_read_file` 工具取回已经不在投递窗口里的文件：它把标签解析到对应元素，按原样文件准入，并返回显示名、字节数、内容摘要与读取路径（`attachments.fileHostPath` 经 `fs.processPathFromHostPath` 映射，也就是请求装配自己用的那套解析）。`im_read_image` 保持只处理图片的契约；系统提示词指引同时点明两个工具和两种标签。

## Alternatives considered

**只加读取工具，不做提前准入。** 每条新消息能省下一次下载，但模型得为自己刚收到的东西再发一次请求——而这恰恰是图片路径不需要工具调用就能回答的请求形态。

**把文本类文件读进工具结果。** 靠媒体类型嗅探来内联文本，会引入一份格式白名单和同一份字节的第二种表示；给出路径则让模型自己的文件工具决定读多少。

**通过 `ctx.fs` 把字节写进会话工作目录。** 文件系统 seam 没有二进制写入（`writeText` 只写 UTF-8 文本），而且媒体存储并不属于某一个会话的工作目录，这么做需要新增一个文件系统操作，并让部署去选一个落盘约定。

## Consequences

已准入的文件可不可读由执行环境决定：能映射宿主路径的执行文件系统直接提供已存副本，没有映射的远程环境拿到的是「副本存在但打不开」的 handle 文本——`im_read_file` 会以 `skipped: 'unmapped'` 报告同一限制，而不是编造一个路径。下载仍受每条消息的 `media.maxItems` 与单个元素的 `media.maxBytes` 约束，`media.download: false` 依旧只保留标签。

系统提示词段落多出一句（两种标签、两个工具），工具目录、子系统页面与两份 README 都列出 `im_read_file`。
