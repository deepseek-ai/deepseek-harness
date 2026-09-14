---
description: "在 Web 右侧栏打开、恢复和控制交互式 shell 标签页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-terminal

[English](README.md) | 中文

## 概述

从右侧栏开始页选择已安装的 shell，在会话工作区运行命令。在标签页上重命名终端，并在刷新页面后恢复保留的进程。折叠侧栏让命令继续运行，关闭终端标签页则请求结束进程。Tab 补全使用 shell 的配置。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

展开右侧栏，在开始页选择**新建终端**；已有其他标签页时，先选择**新标签页**。选择已安装的 **Shell**，再点击**启动终端**。localStorage 会记住上次选择的 shell 并预选；首次使用或已保存选项不可用时，预选当前默认项。通过侧栏的**新标签页**控件打开更多终端。

双击终端标签页标题即可重命名。另一页面持有输入权时，**接管输入**让当前连接可写。连接失败时可以**重新连接**。shell 退出后仍显示屏幕和退出码，不自动重启。 已退出的终端计入 Session 数量上限；达到上限时请关闭不用的标签页。

关闭或替换终端标签页会立即移除标签页，并在后台结束进程。清理失败时显示带**重试**操作的轻量通知；重试不会重新打开标签页。折叠、切换标签页或 Session、浮动和全屏都保留进程。

刷新页面后显示某个 Session，会把 Host 保留的终端重新打开为新标签页。恢复失败时可点击**重试恢复终端**。恢复目标进程消失时显示错误，不启动另一个 shell。[侧栏布局仅保存在内存中](../../client/ui-sidebar-right/README.zh.md#state)。

终端背景、默认文字、光标和选区跟随 DSH 主题，包括系统偏好和主题 token 覆盖。切换主题会更新现有屏幕，不清空输出或重启 shell。shell 输出的 ANSI 颜色仍然生效。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

插件向右侧栏注册 `terminal` 类型及正文和标题 seat。开始页入口使用紧凑的黑底终端图标，页签标题保留线条图标。无 React 依赖的终端模型属于 `api-terminal-controller`，通过框架 keyed hooks 暴露状态。`ui-primitives` 的 Menu 与 Button 提供 shell 选择和启动控件，支持键盘导航与选中标记。xterm.js 与 FitAddon 负责屏幕渲染和视口测量。正文在面板高度内为页签条下方预留 8px 间距。输入原样传到 PTY，包括 Tab 和控制字符。

Session header contribution 查询 Host 终端并打开恢复标签页。导航参数中的 `terminalId` 只在当前页面内保留；恢复视图不能分配替代进程。侧栏关闭 handler 通过[终端 controller](../../api/terminal-controller/README.zh.md#understand-the-implementation)安排清理并同步返回。浏览器组件清理和 tab 的 abort signal 只停止浏览器工作。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Subprocess](../../subprocess/subprocess/README.zh.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.zh.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.zh.md)

<a id="model-experience"></a>
## 模型体验

无；此包只处理用户交互式终端，不向模型请求添加内容。

#### KV 缓存影响

无；终端输出只在浏览器与 Host 之间传输。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 默认 shell 或原生 PTY 可能启动失败。标签页显示错误，不启动其他 shell。
- 补全菜单和内联建议取决于 shell 配置，Web UI 不提供独立补全引擎。
- 终端历史有上限。此功能不向 Agent 发送终端输出，不在单个标签页内拆分终端，也不在 Host 重启后恢复进程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

不发布运行时 invariant companion。终端元数据与屏幕更新由同一对象按序写入，没有独立的进程尺寸观测可供比较。

</details>
