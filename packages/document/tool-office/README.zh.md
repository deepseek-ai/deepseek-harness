---
description: "由技能激活的 Office 工具，用于查看文档页面、转换文档和重算工作簿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-office

[English](README.md) | 中文

## 概述

加载 Office 技能后，模型获得三个工具。`office_render` 将文档页面、幻灯片或工作表区域作为图片返回，用于检查版式，无需临时图片文件或单独读取图片。`office_convert` 生成另一种格式的文档；`office_recalculate` 刷新工作簿公式。二者都返回临时文件，由模型用 shell 复制到目标位置。工具不修改输入，也不写工作区文件，标准模式与 PTC 模式行为相同。

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

[Web bundle](../../bundle/web-app/README.zh.md)和 [SDK bundle](../../bundle/sdk-app/README.zh.md)在 Desktop、普通 `dsh web` 和 SDK 中随 `office-kit` 挂载此插件；Web bundle 中由 `standard` 和 `ptc` Agent 预设包含它，`minimal` 预设不包含。加载任一配置的 [Office 技能](../../skill/skill-office/README.zh.md)后，三个工具从模型的下一步起全部激活，无论技能由模型调用 `skill`、PTC 嵌套调用，还是用户以 `/office` 等方式直接调用。加载失败或加载其他技能不会激活工具。激活前调用返回 `UNKNOWN_TOOL`。

激活只匹配 `activationSkills` 中列出的技能名，因此须同时挂载 [`@deepseek-ai/dsh-skill-office`](../../skill/skill-office/README.zh.md)，或其他注册了同名技能的 provider；否则三个工具永远不会出现。

工具在每次调用时读取 Office 套件服务。Kit 缺失时，调用以该服务的 `unavailable` 消息失败；服务不存在时，调用以 `The document converter is unavailable.` 失败。每个 `unavailable` 失败都提示模型告知用户；原因可能是暂时的（例如输出存储已满或服务正在卸载）时稍后重试，并且不改用系统 soffice、npx 或其他转换工具。

```yaml
- name: '@deepseek-ai/dsh-office-kit'
- name: '@deepseek-ai/dsh-tool-office'
  config:
    maxImages: 20
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `activationSkills` | `[office, office-docx, office-xlsx, office-pptx]` | 非空 kebab-case 技能名列表；成功加载其中任一技能即激活三个工具 |
| `maxImages` | `20` | 一次渲染返回的最大图片数，含工作表分片 |
| `maxImagePixels` | `8388608` | 每张图片的最大像素数 |
| `maxImageDimension` | `8192` | 每张图片的最大宽度和高度 |
| `maxImageBytes` | `33554432` | 一次渲染全部图片的最大 PNG 字节数 |

渲染对每个字段取其与附件存储对应图片上限（`maxImagesPerMessage`、`maxImagePixels`、`maxImageDimension`、`maxMessageImageBytes`）中的较小值，并拒绝超过存储 `maxImageBytes` 的单张图片。超出上限的选择直接失败，不会被截断。渲染要求挂载附件存储，且调用方模型路由声明支持图片输入。工具从会话最近一次模型请求读取该路由，首次请求之前则读取 agent 选项；模型的输入模态不含图片或未声明时，在开始任何渲染工作之前就会被拒绝。

输入相对 Session 工作目录解析，并沿用文件系统后端的读取权限，与 `read` 和 Office 预览一致，因此可以读取工作区外的文件。输入扩展名决定文档类别。`office_convert` 接受 Word、Excel 和 PowerPoint 文档：Word 可导出 pdf、docx、odt 或 txt；Excel 可导出 pdf、xlsx、ods 或 csv；PowerPoint 可导出 pdf、pptx 或 odp。多工作表工作簿导出 CSV 时必须指定工作表名。`office_recalculate` 接受 xls、xlsx 和 ods 工作簿，输出必须为 xlsx 或 ods。`office_render` 还接受 PDF。

转换和重算结果给出 Office 套件私有[输出存储](../office-kit/README.zh.md#use-this-package)中位于 Harness 主目录下的一个文件；模型用 shell 复制它，因此文件落在哪里由 shell 的沙箱和审批决定。文件系统后端无法读取 Host 文件时（例如 SSH 工作区），这两个工具在转换前即失败；渲染不受影响。

每个请求都以 `foreground` 优先级进入 Office 套件的共享队列，与打开的预览同级。前台工作先于后台预热执行，并可驱逐排队中的后台任务，因此推测性预览不会饿死工具调用；工具调用与打开的预览按到达顺序共享准入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

参数检查（包括依赖输入类型的转换格式）和 Office 套件查找在任何文件系统访问之前进行，因此参数错误或服务缺失的调用不会读取输入。随后工具通过 `ctx.fs` 解析输入并要求其为普通文件，用 `fs.readByteRange` 读取其第一个字节后再 stat 一次，因此没有内容读取权限的调用，或文件在 stat 之后被替换的调用，会在 Office 套件可能从缓存应答之前失败。随后工具向 Office 套件提交已授权的源；其延迟读取在有界的 `fs.readBytes` 前后各 stat 一次，版本变化时拒绝。渲染结果在返回前通过 `attachments.saveImages()` 提交，因此 `tool/result` 事件携带持久的图片引用；恢复、分叉和回放会还原相同的图片，图片卸载也像对待其他工具结果图片一样适用于它们。规范值携带附件引用和图片位置；`output.render` 先生成一条摘要文本，再为每个渲染的页面或区域生成位置标签和图片块。`presentationMeta` 记录规范化的输入路径，转换时还记录临时文件路径。输出存储中的文件归调用方 subagent 树的根 Session 所有：挂载 `subagents` 服务时通过 `subagents.rootOf()` 读取，否则为调用方 Session；文件以输入文件名加新扩展名命名。

每个工具分别声明参数和结果 schema。受支持的 schema 子集无法表达页码唯一性、数值范围和跨参数规则，因此这些渲染选择以及依赖输入类型的转换格式在运行时检查。Office 套件的错误报告为 `cannot <operation> "<path>": <message>`，其中 `<path>` 为解析后的输入路径，服务缺失时为调用给出的路径；`unavailable` 附带告知用户、或在其原因可能是暂时的时候稍后重试且不改用其他转换器的提示，`busy` 附带重试提示，渲染过大时附带缩小选择的提示。PTC 嵌套调用重新进入同一执行管线，因此策略和日志同样适用；嵌套渲染的图片在程序运行结束后附加。

成功的 `tools/result` 通知将调用方 Agent 记入插件拥有的 WeakSet。提交后的 `session/event` 事件流也会标记用户直接调用的技能，不依赖 pre-step 监听器顺序。`agent/disposed` 清除标记。三个工具共用一个 `when`：Agent 已被标记，或 Session 最新的公开 `requestHeader()` 中列出了任一 Office 工具。不注册额外的 projection 或 Session 事件。

原生请求头在恢复和分叉后保留 Office 声明，包括还原后的首次请求；压缩只替换对话内容，不删除请求头。PTC 的请求头只记录 `run_code`，因此恢复或分叉后的 PTC Agent 必须重新加载 Office 技能。如果 Agent 在原生 Office 声明落盘前丢失内存，激活状态也会丢失；再次调用 `skill` 即可在下一步恢复。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Office 套件](../office-kit/README.zh.md) — 转换队列、上限和 Kit 定位。
- [Office 工具决策](../../../.agents/notes/implemented/architecture/2026-10-31-native-office-tool.zh.md) — Office 操作为何通过 Host 执行。
- [工具编写参考](../../../docs/cookbook/adding-a-tool.zh.md) — 执行与展示契约。

<a id="model-experience"></a>
## 模型体验

### office_render, office_convert, office_recalculate

#### 模型看到的内容

三个工具的声明见[工具目录](../../../docs/tool-catalog.zh.md)。渲染结果以 `Rendered <count> image(s) of <absolute input path> (<pageCount> in the document) at <dpi> DPI.` 开头，缺少字体时追加 `Fonts not installed and substituted: <families>.`，随后每张图片先给出 `Page <n>: <width>x<height> px` 或 `Sheet "<name>" <range>: <width>x<height> px` 标签，再给出图片。转换时报告 `Converted <input> to <format> (<bytes> bytes[, <n> pages]): <temporary file>`（或 `Recalculated …`），随后是 `Copy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.` 和相同的字体行。失败为 `cannot <operation> "<path>": <reason>`。

#### Token 影响

激活前没有 Office 声明；激活后包含三份固定的工具 schema，在 PTC 模式下表示为程序绑定。每次渲染追加摘要、每张图片一条简短标签以及图片本身，受配置与附件图片上限约束；图片 token 取决于路由的图片计价。转换时追加两行。

#### KV Cache 影响

原生模式下，工具在对话中途激活时追加一条带 `tool-addition` 块的 `developer/message`；声明了 `toolUpdate` 的路由保持请求前缀不变，其他路由开始一次新的请求序列。原生模式的恢复和分叉保留这些声明。PTC 模式下，三个工具是系统提示中 `run_code` 一节列出的程序绑定，因此激活会重写系统提示：声明了 `systemPromptUpdate: in-history` 的路由追加一条系统消息，其他路由开始一次新的请求序列。PTC 恢复或分叉会丢失内存中的标记，因此系统提示会变化两次：下一步移除这些绑定，再次加载 Office 技能后又加回。结果追加到对话末尾；图片卸载之后可能通过其自身记录的事件把某个图片出现替换为占位文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **转换后的文件需要 shell 复制** — 文件系统服务不创建二进制文件，因此模型用 shell 复制每个临时文件。没有 shell 工具的部署无法交付转换后的文件；临时文件在 Office 套件的保留期满或调用方 subagent 树的根 Session 卸载后删除；subagent 产出的文件在该 subagent 结束后仍然保留。
- **远程工作区不支持转换** — Office 套件运行在 Host 上，远程 shell 读不到其输出存储。
- **渲染不保存图片文件** — `office_render` 只返回供模型查看的图片，不写出 PNG 或其他图片文件。需要以文件形式获得页面的用户，通过 `office_convert` 并设置 `format: "pdf"` 获得 PDF。
- **Web GUI 不显示渲染图片** — [ui-tool](../../client/ui-tool/README.zh.md) 的 Office 行显示 `office_render` 结果的文本块并略去其中的图片，因此用户看不到模型检查过的页面。模型仍会收到每张图片。
- **原生引擎在 Host 进程内运行** — 由模型发起的渲染、转换和重算通过 `ctx.officeKit` 在 Host 进程内运行原生 LibreOffice Kit 引擎，因此不受 shell 沙箱和 PTC 权限约束。输入仍受文件系统后端读取权限的约束。原生解析器以 Host 用户的权限处理不可信的文档。
- **PTC 激活状态不跨恢复和分叉保留** — PTC 请求头只记录 `run_code`，因此恢复或分叉后的 PTC Agent 在模型重新加载 Office 技能前不提供 Office 绑定；移除和重新加入各重写一次系统提示，缓存影响见 KV Cache 影响一节。
- **插件重载会清除激活状态** — 热重载、或停用后再启用插件，会清空内存中的标记。如果期间运行过一步，该步的请求头不再包含这三个工具，模型须重新加载 Office 技能才能恢复。
- **直接调用从下一步起激活** — 一步的工具集在用户调用的技能（如 `/office`）内容注入前就已确定，因此调用后的第一个模型请求不声明 Office 工具。这些工具从模型的下一步起出现。
- 渲染保真度、字体和分页取决于 LibreOffice Kit，可能与 Microsoft Office 不同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
