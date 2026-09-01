---
description: "原生目录选择表面：驱动宿主操作系统选择器的浏览器半部，用于工作区目录流程；供选择拾取交互的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-directory-picker-native

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的原生目录拾取表面：当工作区流程请求一个目录时，一个无渲染的浏览器填充会在运行宿主的机器上打开操作系统自带的选择器，并回报唯一结果——拾取的路径、取消或失败。它填充 `ui-workspace` 声明的两个目录流程槽位，用一行 cordis.yml 组合出原生拾取交互的客户端一侧。当浏览器与宿主运行在同一台机器上时选择它；进程内与远程浏览器部署则需要 [`-browse`](../ui-directory-picker-browse/README.zh.md) 表面。

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

与 `ui-workspace` 及宿主后端 [`dsh-host-directory-picker-native`](../../host/directory-picker-native/README.zh.md) 一起挂载本插件；一行 cordis.yml 随即组合出完整的原生拾取交互。当工作区添加或选择器流程发起目录请求时，用户看到操作系统的文件夹对话框；拾取的路径被工作区流程采纳，取消则关闭对话框。

### 何时选择

当浏览器与宿主运行在同一台机器上、操作系统对话框可以在那里打开时，选择此表面。当浏览器为远程或进程内、没有本地选择器时，选择 [`-browse`](../ui-directory-picker-browse/README.zh.md) 表面。两个表面填充相同的槽位，因此切换只是组合改动，而非代码改动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个槽位注册经嵌套的 `ctx.slots.inject()` 调用作为一次事务性效果安装，因为任一声明条目都可能晚些激活或替换其声明。填充在每个上升沿 `open` 时只武装一次，因此重渲染永远不会再拉起一个选择器；结算结果挂在 ref 上，让答复到达持有方最新的处理器。卸载（HMR 替换填充）会整体丢弃结算：线上没有按请求中止的机制，因此宿主侧选择器会一直存活到被答复，而它的答复无处落地。node 半部是一个空 `apply`，让插件留在宿主名单上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当拾取面不够用时阅读以下页面。它们从浏览器半部进入宿主后端与它所填充的槽位。

- [dsh-host-directory-picker-native](../../host/directory-picker-native/README.zh.md)——本表面驱动的操作系统选择器后端。
- [ui-workspace](../ui-workspace/README.zh.md)——声明目录流程槽位并拥有拾取对话。
- [ui-directory-picker-browse](../ui-directory-picker-browse/README.zh.md)——面向远程与进程内部署的应用内浏览替代方案。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无，因为目录选择器属于浏览器界面；本包中的任何内容都不会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了原生选择器的适用时机。它们是当前包约束，不是通用选择器对比或任务积压。

- **无法取消已打开的选择器**——线上没有按请求中止的机制，因此已显示在宿主上的选择器无法从浏览器关闭；被丢弃的结算会被忽略。
- **仅限本地宿主承载**——操作系统对话框在运行宿主的机器上打开，因此进程内与远程浏览器部署需要 `-browse` 组合。平台失败经由持有方的可重试文件夹对话框呈现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件用一个事务性 effect 把无渲染 flow occupant 注册到两个 workspace hole，HMR 测试覆盖释放，pick 之间不保留状态。
