---
description: "Web GUI 的产出文件与可点击文件引用：已完成轮次末尾的产出文件行，以及收尾正文中的行内代码链接；供产出物体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

[English](README.md) | 中文

## 概述

本包渲染已完成轮次末尾的产出文件行——列出修改工具创建或修改的文件——并把收尾正文中匹配的行内代码引用转为链接，让被点名的文件在右侧 Sidebar 中打开。链接路径来自成功的文件修改与显式交付，而非收尾正文——无论模型是否记得点名，产出文件都会被列出。正式提供的组合中只有 Web patch 加载本包；删除其 cordis.yml 条目会同时移除指引、文件行与正文链接。

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

与 `ui-conversation` 一起挂载本插件；已完成轮次随即以产出文件行收尾，位于收尾消息正文与其动作页脚之间。每个标签项经属主的 `openFile` 打开文件——chat 视图把它路由到右侧 Sidebar 作为一个文本预览 tab——相对路径按会话 cwd 解析。该行不提供文件夹动作：Sidebar 没有目录形态，因此省略项只显示为标签。

<a id="explicit-deliveries"></a>
### 显式交付

Web 的 `standard`、`ptc` 与 `cordis` preset 提供 `present` 用于声明交付会话文件系统可访问的最终文件，包括通过 Bash 创建的文件。创建文件后，以 `files: [{ path, description? }]` 调用。[present 工具](../../fs/tool-present/README.zh.md)拥有文件数量限制和会话声明。收尾轮次把单个交付显示为横向占满内容区的卡片，把多个交付显示为间距 10px 的双列网格。文件超过四个时，列表默认收起，并提供显示或隐藏完整列表的控件。每张卡片高 60px，上下内边距为 8px、左右为 10px；40px 图标框内使用 20px 的共享 `FileTypeIcon`，文件名为 13px、次要文本为 10px，“打开”操作为 12px。卡片显示 basename 与说明；没有说明时显示文件类型，说明末尾的括号后缀会被省略，悬停卡片时该行切换为侧栏预览提示。点击卡片或分段“打开”控件的左侧会在右侧 Sidebar 中预览文件；右侧箭头打开标准菜单，其中提供 Host 默认应用，以及 macOS 上的“在 Finder 中显示”、Windows 和 WSL 上的“在文件资源管理器中显示”或 Linux 默认文件管理器的“打开所在文件夹”。匹配的行内代码引用在右侧 Sidebar 中预览相同源文件；原生打开需要显式选择卡片菜单中的操作。同一路径重复声明时，选择收尾回复之前最近一次的说明。

`present` 工具行显示正在交付、已交付、失败或中断状态；展开已结束的调用可查看其记录的结果。可折叠卡片网格保留全部交付文件。菜单中的两个操作共享等待状态，并显示进度、成功确认或各自可重试的错误。交付卡片出现时读取桌面信息，连接更换时清除缓存，旧连接的响应不能更新元数据。选择原生菜单操作后，键盘焦点回到仍可用的侧边栏“打开”按钮。等待操作完成时关闭菜单，用户再次点击才会打开。Host 没有桌面时禁用“打开”菜单；桌面信息读取失败时提供“重试”。服务 Host 必须具备桌面和合适的默认应用；远程浏览器不会打开其所在设备上的应用。

### 该行

“本轮文件改动”行列出成功的文件工具修改；最终文件交付需要调用 `present`。首个文件区块位于收尾正文下方 20px，后续显式交付区块位于该行下方 16px，操作页脚位于最后一个文件区块下方 20px。该行通过 CSS 容器宽度档位响应式展示至多六个文件标签项。Flexbox 负责收缩文件名并用省略号截断，CSS 为未展示路径选择匹配的本地化 `+ N 个文件` 标签；完整路径仍保留在 `title` 中，该行不执行 JavaScript 布局观察，也不提供横向滚动。

### 行内代码链接

收尾正文链接产出或已交付的路径：行内代码 token 按精确路径解析，或当它恰好等于其中某条路径的 basename 且该路径唯一时解析——两条路径共享同一 basename 时保持不可点击而不作猜测，因此提及绝不打开错误的文件。解析成功的提及保留代码标签，并采用 Markdown 样式表的链接样式，完整路径作为其 `title`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Node 半部注册静态 `ui:deliverable-file-references` 系统提示词段，要求模型点名成功创建或修改的主要文件，并把这些文件以及正文中提到的其他本轮变更文件写成 Markdown 行内代码。浏览器半部把组合 `ProducedFiles` 与显式交付的包装组件注册进 chat 视图的 `conversation.chat.turnTail` 洞。`deliverablesDefinition` 根据 `write`、`edit` 和有修改作用的 `str_replace_editor` 命令中经过校验的原始参数，把每个轮次成功的第一方修改调用折叠进 `DeliverablesTurnData`。读取、删除、不受支持的工具、格式错误的调用和失败结果不贡献任何条目。新的修改工具必须增加显式 Client contribution 才能加入列表。本包还提供 chat 视图按收尾消息查询的 `chatFileMentions` 服务；把插件组合出去会同时移除两个表面，视图的空链以零成本留下。

原生打开使用经过认证的 POST，通过当前查看的会话、事件序号和原始文件索引定位声明。Host 读取声明及当前查看的会话 header，将其中的 cwd 传给 `workspaceFiles.stat`；未记录 cwd 时使用部署的工作目录。它与侧栏预览使用同一组合文件系统，无需启动 Agent，子会话也适用。原生操作要求规范化的进程路径能从 Host 路径映射回同一进程路径。提供方没有这种映射时返回 422，卡片提示使用侧栏预览；Host 上存在同名文件并不足够。同一份桌面可用性配置同时约束信息查询和实际执行。编辑会影响后续打开的内容；删除后返回错误。不创建文件内容副本或附件。插件释放时取消并等待进行中的原生打开请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当产出物面不够用时阅读以下页面。它们从该行进入 turn-tail 洞与词表背后的决策。

- [ui-conversation](../ui-conversation/README.zh.md)——声明 `conversation.chat.turnTail` 洞并渲染收尾正文。
- [工作区文件链接](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.zh.md)——产出文件行背后的决策；其 Host 打开路径已被[右侧 Sidebar](../../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)取代。
- [行内文件提及](../../../.agents/notes/archived/feature/2026-08-07-web-inline-file-mentions.md)——收尾正文可点击提及背后的决策。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

### 可点击文件引用指引

#### 模型看到的内容

一段固定提示词要求模型在最终回复中点名成功创建或修改的主要文件，并将这些文件以及正文中提到的其他本轮变更文件写成采用精确路径或唯一 basename 的 Markdown 行内代码，例如 `out/report.html`。

#### Token 影响

加载本包时增加一段固定提示词。[present 工具](../../fs/tool-present/README.zh.md#model-experience)拥有交付 schema 和结果文本。

#### KV Cache 影响

该段落在本包挂载期间始终以 first-party 顺序 9000 保持静态，因此留在可复用的提示词前缀中，不会随轮次改变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前产出物词表。它们是当前包约束，不是通用文件链接对比或任务积压。

- **提及匹配只认精确路径或唯一 basename**——后缀式提及保持惰性；等真实的收尾消息形态产生需求后再放宽匹配规则。
- **终端创建的文件需要显式交付**——调用 `present` 声明后才会显示交付卡片和可点击引用。
- **声明不保存文件内容**：重新打开或转移 Session 后，源文件仍需能被当前查看的 Session 文件系统访问。文件缺失、为目录或最终路径为符号链接时返回 404。
- **目录没有打开目标**——标签项在右侧 Sidebar 的文本预览中打开文件，该预览仅支持文件，不提供原生文件夹打开动作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。提示词、slot、dictionary、文件操作路由与可选 service 注册归 effect 所有；Session 日志拥有声明，文件系统拥有文件内容。
