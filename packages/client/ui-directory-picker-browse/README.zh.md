---
description: "应用内目录浏览表面：填充工作区目录流程的 Miller 分栏「选择工作区目录」对话框；供 Web 拾取体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-directory-picker-browse

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的应用内目录浏览表面：一个「选择工作区目录」对话框，通过本地宿主列出、导航并创建文件夹，不涉及任何操作系统选择框。它填充 `ui-workspace` 声明的两个目录流程槽位，用一行 cordis.yml 组合出浏览拾取交互的客户端一侧。当浏览器为远程或进程内、没有本地操作系统选择器时选择它；本地部署可优先选择 [`-native`](../ui-directory-picker-native/README.zh.md) 表面。

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

与 `ui-workspace` 及宿主后端 [`dsh-host-directory-picker-browse`](../../host/directory-picker-browse/README.zh.md) 一起挂载本插件；一行 cordis.yml 随即组合出完整的浏览拾取交互。当工作区流程发起目录请求时，用户看到应用内对话框：头部承载路径面包屑与可编辑路径区，未选中行时是一整栏层级，选中后该行分为层级与子项两栏。

### 导航与创建

逐级进入文件夹、直接编辑路径，或用前缀过滤最后一栏；宿主标记的隐藏条目默认不显示，直到页脚开关揭开。**新建文件夹**打开一个嵌套创建对话框，目标为选中的文件夹，并选中它创建出来的那个；**打开**采纳选中的文件夹，没有选中时回落到当前层级。确认一个目录即为选中的路径；关闭对话框即为取消。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

对话框是 680×500 的 Miller 分栏视图（在较矮或较窄的视口中限制尺寸），经 `ctx.workspaces` 驱动宿主的 `listDirectory` 与 `createDirectory` 原语。两处注册经嵌套的 `ctx.slots.inject()` 调用作为一次事务性效果安装，因为任一声明条目都可能晚些激活或替换其声明；对话框文案注册在本包自己的 locale 命名空间下，让两份字典作为一个单元落地。浏览类失败留在对话框自己的提示区内，因此本填充从不驱动持有方的 `onError` 分支。node 半部是一个空 `apply`，让插件留在宿主名单上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当拾取面不够用时阅读以下页面。它们从浏览器半部进入宿主后端与它所填充的槽位。

- [dsh-host-directory-picker-browse](../../host/directory-picker-browse/README.zh.md)——本表面驱动的目录列出后端。
- [ui-workspace](../ui-workspace/README.zh.md)——声明目录流程槽位并拥有拾取对话。
- [ui-directory-picker-native](../ui-directory-picker-native/README.zh.md)——面向本地部署的原生操作系统选择器替代方案。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无，因为目录浏览器属于浏览器界面；本包中的任何内容都不会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前浏览表面。它们是当前包约束，不是通用文件浏览器对比或任务积压。

- **无搜索、无多选、无重命名或删除**——对话框只负责列出与创建目录；到达目标靠导航、编辑路径，或用前缀过滤最后一栏。
- **隐藏条目的过滤在客户端**——宿主始终列出隐藏条目并加标记，因此开关只改变对话框渲染什么。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 workspace directory-flow owner，HMR 测试覆盖释放；显示的目录内容每次都从 Host 重读。
