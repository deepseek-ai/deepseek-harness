---
description: "office 工具：把文档页面渲染为模型可直接查看的图片，并通过共享 Office 套件转换文档、重算工作簿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-office

[English](README.md) | 中文

## 概述

为模型提供一个用于 Office 操作的 `office` 工具。`render` 把文档页面、幻灯片或工作表区域作为图片放进工具结果，模型无需临时文件或单独读取图片即可检查版式。`convert` 生成另一种格式的文档，`recalculate` 生成公式结果已刷新的工作簿，二者都给出一个临时文件，由模型用 shell 复制到目标位置；工具本身不写工作区文件。三种操作都在 Host 进程中通过共享的 [Office 套件](../office-kit/README.zh.md)服务执行，标准模式与 PTC 模式相同。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[Web bundle](../../bundle/web-app/README.zh.md)和 [SDK bundle](../../bundle/sdk-app/README.zh.md)在 Desktop、普通 `dsh web` 和 SDK 中随 `office-kit` 挂载此工具；Web bundle 中由 `standard` 和 `ptc` Agent 预设包含它，`minimal` 预设不包含。无论是否安装 LibreOffice Kit、是否挂载 `office-kit` 服务，工具都会注册，并在每次调用时读取该服务。Kit 缺失时，每次调用都以 Office 服务的 `unavailable` 消息失败；服务不存在时，每次调用都以 `The document converter is unavailable.` 失败。两种失败都提示模型告知用户该操作不可用，不改用系统 soffice、npx 或其他转换工具。[Office 技能](../../skill/skill-office/README.zh.md)告诉模型何时渲染以及如何检查结果。

```yaml
- name: '@deepseek-ai/dsh-office-kit'
- name: '@deepseek-ai/dsh-tool-office'
  config:
    maxImages: 20
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxImages` | `20` | 一次渲染返回的最大图片数，含工作表分片 |
| `maxImagePixels` | `8388608` | 每张图片的最大像素数 |
| `maxImageDimension` | `8192` | 每张图片的最大宽度和高度 |
| `maxImageBytes` | `33554432` | 一次渲染全部图片的最大 PNG 字节数 |

渲染对每个字段取其与附件存储对应图片上限（`maxImagesPerMessage`、`maxImagePixels`、`maxImageDimension`、`maxMessageImageBytes`）中的较小值，并拒绝超过存储 `maxImageBytes` 的单张图片。超出上限的选择直接失败，不会被截断。渲染要求挂载附件存储，且调用方模型路由声明支持图片输入。工具从会话最近一次模型请求读取该路由，首次请求之前则读取 agent 选项；模型的输入模态不含图片或未声明时，在开始任何渲染工作之前就会被拒绝。

输入相对 Session 工作目录解析，并沿用文件系统后端的读取权限，与 `read` 和 Office 预览一致，因此可以读取工作区外的文件。输入扩展名决定文档类别，`format` 决定 `convert` 和 `recalculate` 的输出格式。其结果给出 Office 套件私有[输出存储](../office-kit/README.zh.md#use-this-package)中位于 Harness 主目录下的一个文件；模型用 shell 复制它，因此文件落在哪里由 shell 的沙箱和审批决定。文件系统后端无法读取 Host 文件时（例如 SSH 工作区），`convert` 和 `recalculate` 在转换前即失败；`render` 不受影响。

每个请求都以 `foreground` 优先级进入 Office 套件的共享队列，与打开的预览同级。前台工作先于后台预热执行，并可驱逐排队中的后台任务，因此推测性预览不会饿死工具调用；工具调用与打开的预览按到达顺序共享准入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具通过 `ctx.fs` 解析输入并要求其为普通文件，用 `fs.readByteRange` 读取其第一个字节后再 stat 一次，因此没有内容读取权限的调用，或文件在 stat 之后被替换的调用，会在 Office 套件可能从缓存应答之前失败。随后工具向 Office 套件提交已授权的源；其延迟读取在有界的 `fs.readBytes` 前后各 stat 一次，版本变化时拒绝。渲染结果在返回前通过 `attachments.saveImages()` 提交，因此 `tool/result` 事件携带持久的图片引用；恢复、分叉和回放会还原相同的图片，图片卸载也像对待其他工具结果图片一样适用于它们。规范值携带附件引用和图片位置；`output.render` 先生成一条摘要文本，再为每个渲染的页面或区域生成位置标签和图片块。`presentationMeta` 记录规范化的输入路径，转换时还记录临时文件路径。输出存储中的文件归调用方 subagent 树的根 Session 所有：挂载 `subagents` 服务时通过 `subagents.rootOf()` 读取，否则为调用方 Session；文件以输入文件名加新扩展名命名。

schema 无法表达的参数规则——各操作专用的参数、互不重复的从 1 开始的页码、dpi 范围以及各操作的输入输出格式——在访问任何文件之前检查。Office 套件的错误报告为 `cannot <operation> "<path>": <message>`，`unavailable` 附带告知用户的提示，`busy` 附带重试提示，渲染过大时附带缩小选择的提示。PTC 嵌套调用重新进入同一执行管线，因此策略和日志同样适用；嵌套渲染的图片在程序运行结束后附加。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Office 套件](../office-kit/README.zh.md) — 转换队列、上限和 Kit 定位。
- [Office 工具决策](../../../.agents/notes/implemented/architecture/2026-10-31-native-office-tool.zh.md) — Office 操作为何使用常驻的 Host 工具。
- [工具编写参考](../../../docs/cookbook/adding-a-tool.zh.md) — 执行与展示契约。

<a id="model-experience"></a>
## 模型体验

### office

#### 模型看到的内容

插件挂载期间，[office schema](../../../docs/tool-catalog.zh.md#office) 始终存在。渲染结果以 `Rendered <count> image(s) of <absolute input path> (<pageCount> in the document) at <dpi> DPI.` 开头，缺少字体时追加 `Fonts not installed and substituted: <families>.`，随后每张图片先给出 `Page <n>: <width>x<height> px` 或 `Sheet "<name>" <range>: <width>x<height> px` 标签，再给出图片。转换时报告 `Converted <input> to <format> (<bytes> bytes[, <n> pages]): <temporary file>`（或 `Recalculated …`），随后是 `Copy this temporary file to its destination with the shell now; it is deleted when this conversation ends.` 和相同的字体行。失败为 `cannot <operation> "<path>": <reason>`。

#### Token 影响

挂载期间每个请求包含一份固定的工具 schema。每次渲染追加摘要、每张图片一条简短标签以及图片本身，受配置与附件图片上限约束；图片 token 取决于路由的图片计价。转换时追加两行。

#### KV Cache 影响

schema 在挂载期间保持不变，且不依赖已加载的技能，因此工具声明前缀保持稳定。结果追加到对话末尾；图片卸载之后可能通过其自身记录的事件把某个图片出现替换为占位文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **转换后的文件需要 shell 复制** — 文件系统服务不创建二进制文件，因此模型用 shell 复制每个临时文件。没有 shell 工具的部署无法交付转换后的文件；临时文件在 Office 套件的保留期满或调用方 subagent 树的根 Session 卸载后删除；subagent 产出的文件在该 subagent 结束后仍然保留。
- **远程工作区不支持转换** — Office 套件运行在 Host 上，远程 shell 读不到其输出存储。
- **渲染不保存图片文件** — `render` 只返回供模型查看的图片，不写出 PNG 或其他图片文件。需要以文件形式获得页面的用户，通过 `convert` 并设置 `format: "pdf"` 获得 PDF。
- **原生引擎在 Host 进程内运行** — 由模型发起的渲染、转换和重算通过 `ctx.officeKit` 在 Host 进程内运行原生 LibreOffice Kit 引擎，因此不受 shell 沙箱和 PTC 权限约束。输入仍受文件系统后端读取权限的约束。原生解析器以 Host 用户的权限处理不可信的文档。
- 渲染保真度、字体和分页取决于 LibreOffice Kit，可能与 Microsoft Office 不同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
