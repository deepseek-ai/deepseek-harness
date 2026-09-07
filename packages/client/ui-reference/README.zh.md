---
description: "Web @file 与 @session 引用 source：候选项、排序，以及原子行内引用（统一的文件/会话选取）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-reference

[English](README.md) | 中文

## 概述

`dsh-client-ui-reference` 是统一的 Web `@file` 与 `@session` 引用 source：它把 `reference` 条目注册进编辑器的行内建议机制，让用户在输入 `@` 时于同一个列表中看到文件与会话候选。文件排在会话之前，分组标题使用注册在 locale 字典中的标签，任一候选领域失败都会独立降级、不阻塞另一领域。每一行只承载能区分它的信息：文件显示其父目录、位于工作区根目录时不显示；会话仅在其工作区不是当前工作区时显示该工作区；下钻后的目录列表不显示位置，因为面包屑已经承载了它。选择一项会插入原子行内引用——文件、文件夹与会话皆然——其隐藏的序列化与剪贴板形式就是共享 `@path` 语法所定义的自然文本；目录行额外携带一个钻取动词（Tab 或行尾 chevron），保持可编辑的路径纯文本并让菜单在尾部斜杠处保持活跃，用户可以继续进入下一层。选择会话会经 session-reference 服务路由，该服务校验 mention 并在 pre-step 边界捕获模型上下文；本包自身不注册任何提示词或工具。

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

只要组合挂载了本包且存在宿主 `ctx.fileReferences` 提供方，该 source 即处于活动状态。输入 `@` 后跟一个未加引号的 token，会先看到文件、再看到会话；打开 `@"…` 则只搜索文件。候选列表是补全菜单，不是搜索结果页：选一次、继续输入即可。

### 选择后会插入什么

选择文件会关闭补全，并显示为带文件图标与业务色文件名的原子行内引用。目录行携带两个动词：选定 pick（点击行主体或 Enter）把文件夹本身解析为同类原子引用——文件夹图标、带尾斜杠的标签、以规范 `@dir/` mention 为序列化形式；钻取动作（Tab 或行尾 chevron）则保持带文件夹图标的可编辑路径纯文本，并让菜单在尾部斜杠处保持活跃，用户可以继续进入下一层。包含空白的路径使用 `@"path with spaces"`，用户显式打开的引号会继续保留。

选择会话会插入一个原子的行内引用，其隐藏 `ref` 与剪贴板表示均为宿主返回的规范 `@[label](dsh-session:…)` mention；可见形式为聊天气泡图标加会话标题。发送会经 `session.prompt` 携带该 mention，session-reference 服务会在 `agent/pre-step` 校验它并捕获模型上下文。

### 失败行为

某个候选领域不可用或失败时，该领域不产生任何行，另一领域仍正常列出。会话引用准备失败发生在提示词接受后，并会终止该 agent 轮次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该 source 把候选编码保留在注册 effect 内部：`/client` 导出接口只包含插件主体（`apply`/`inject`）。

### 候选流程

对于未加引号的 token，浏览器会同时启动 `fileReferences/list` 与 `sessionReferenceResolver/candidates` Remote 调用，再以确定性顺序把文件排在会话之前，并使用注册在 locale 字典中的文件夹、文件与会话标签。各行分别渲染在不可选择的文件与会话分组标题下，不显示重复的原始 `reference` source 标题。会话行用宿主会话列表的 `updatedAt` 经该列表相同的相对时间分档标注时间，因此同一个会话在两处读到的时长一致；列表中没有的会话回落到候选自带的创建时间。下钻后的查询会发布一条从工作区根目录到当前所列目录的面包屑；每一节携带的下钻载荷与文件夹行相同，因此「回到某一步」与「进入某一层」是同一个结果。

### 序列化

文件选择把共享 `@path` 语法所定义的自然文本保留为隐藏的序列化与剪贴板形式。会话选择使用规范的 `@[label](dsh-session:…)` mention；序列化永远不会根据可见标题重建身份。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖建议机制、引用 seam 与输入流水线。

- [ui-input-trigger](../ui-input-trigger/README.zh.md)——该 source 注册进的行内建议机制。
- [file-reference](../../context/file-reference/README.zh.md)——`@file` seam 及其提供方约定。
- [session-reference](../../context/session-reference/README.zh.md)——`@session` seam 与准备后快照的语义。
- [Web 输入机器与 slash 流水线](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md)——引用与命令如何共享输入机器。

-----

<a id="model-experience"></a>
## 模型体验

间接影响模型体验：通过宿主拥有的提供方实现，本包的引用选择把文件指引与会话快照准备委托给它们。

#### KV Cache 影响

浏览候选项不会影响模型。选择文件或会话只会改变新用户消息的后缀，以及紧随该消息、由宿主准备的会话引用上下文；目标会话更早的历史保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明引用 source 何时帮不上忙；它们是当前包约束。

- **候选失败有意保持静默**：Remote 发现调用不可用或失败时，该领域不产生候选行。会话引用准备失败发生在提示词接受后，并会终止该 agent 轮次。
- **浏览器侧不扫描文件**：Web 补全需要挂载宿主 `ctx.fileReferences` 提供方；浏览器无法回退到自身文件系统。
- **会话搜索仍仅使用元数据**：发现流程通过 `ctx.sessionReferenceResolver` 筛选 session id、cwd 与以日志为依据的最新标题；不搜索消息主体或完整 transcript。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 slash source，HMR 测试覆盖释放；它不发出 Cordis 事件，也不持有跨插件可变状态。
