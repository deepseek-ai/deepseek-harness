# Agent Note：IM 媒体准入把非图片保留为原样文件

Status: implemented

[English](2026-11-02-im-file-media-admission.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-im` 会给已存消息的每个媒体元素打上稳定 id 标签（`[图片 #12.1]`、`[文件 #12.2 report.pdf]`、`[语音 #12.3 语音.opus]`），但只能准入图片这一种：`ImMediaStore.admit` 对 `file`、`audio`、`video` 一律返回 `skipped: 'unsupported'`，唯一的读取工具 `im_read_image` 同样拒绝它们。于是在聊天里发出文档、语音或视频的人，交给模型的只是一个打不开的标签——传输层、飞书解码器和 core 的资源抓取其实都已经带上字节（`<file src="satori:…/resources/<file_key>?type=file">`），只是没有人去消费。`media` 字段自己的契约本来就写着图片与文件都会下载，实现落后于它写下的行为。

## Decision

准入按载荷决定，而不是按种类决定。`ImMediaStore` 依旧抓取并按上限裁剪一个引用，随后把图片存成归一化的图片块，把其余每种元素通过 `ctx.attachments.saveFile` 原样存成持久文件。`ImFormatter.format({ media: true })` 把每个准入的文件作为 `file` 内容块追加在文本之后，请求装配因此把它投影成指名已保存只读路径的确定性 handle 文本——和浏览器附件的文件拿到的是同一种表示。

模型通过新增的 `im_read_file` 工具取回已经不在投递窗口里的文件：它把标签解析到对应元素，按原样文件准入，并通过 `ctx.fs.writeBytes` 把字节暂存到会话工作目录下的 `<tools.fileDir>/<seq>.<index>-<name>`，返回该路径与显示名、字节数、内容摘要。为此给 seam 增加了 `writeBytes`：走 `writeText` 会把字节解码并归一化，而附件存储的宿主路径在远端执行文件系统里根本不存在。`im_read_image` 保持只处理图片的契约；系统提示词指引同时点明两个工具和两种标签。

## Alternatives considered

**只加读取工具，不做提前准入。** 每条新消息能省下一次下载，但模型得为自己刚收到的东西再发一次请求——而这恰恰是图片路径不需要工具调用就能回答的请求形态。

**把文本类文件读进工具结果。** 靠媒体类型嗅探来内联文本，会引入一份格式白名单和同一份字节的第二种表示；给出路径则让模型自己的文件工具决定读多少。

**解析已存附件的宿主路径直接交给模型。** 这正是请求装配为已投递 `file` 块做的事，但它只在执行文件系统能映射宿主路径时成立——本地后端可以，远端 SSH 环境不行，而那恰恰是最需要它的部署。走 seam 暂存则在任何能写字节的提供方上成立，返回的路径模型自己的文件工具就能打开。

## Consequences

执行文件系统必须能存下这些字节：`fs-local` 通过与文本写入相同的原子暂存文件落盘，`fs-ssh` 把字节以 base64 交给辅助进程并受其单帧预算（8 MiB）限制，保留基类拒绝的提供方会让 `im_read_file` 直接失败，而不是编造一个路径。已投递的文件仍要靠宿主路径映射才有 handle 文本，因此远端 worker 只知道副本存在、按需自行暂存。暂存会多一份副本（持久附件加工作区文件），同一个 id 总是落到同一相对路径，重读只会覆盖而不会堆积。下载仍受每条消息的 `media.maxItems` 与单个元素的 `media.maxBytes` 约束，`media.download: false` 依旧只保留标签。

系统提示词段落多出一句（两种标签、两个工具），工具目录、子系统页面与两份 README 都列出 `im_read_file`。
