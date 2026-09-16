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

展开右侧栏，点击**新建终端**即可直接打开上次选择且仍可用的 shell。旁边的箭头展开已安装 shell 菜单；选择后立即记住该项并打开终端。菜单展开时才查询 shell，不分配终端进程；查询失败可在菜单内重试。通过**新标签页**回到开始页并打开更多终端。

双击终端标签标题可重命名。其他页面持有输入权时，点击 **接管输入** 使当前连接可写。暂时断线时保留屏幕并提供 **重新连接**，不展示传输内部错误。已退出的 shell 仍显示退出码并提供 **新建终端**，不会自动重启。已退出的终端仍计入 Session 配额；达到上限时请关闭不用的标签。

关闭或替换终端标签页会立即移除标签页，并在后台结束进程。清理失败时显示带**重试**操作的轻量通知；重试不会重新打开标签页。折叠、切换标签页或 Session、浮动和全屏都保留进程。

刷新后，[侧栏恢复布局](../../client/ui-sidebar-right/README.zh.md#state)，各终端在原标签页中重连保存的 Host 身份。折叠和非当前标签不会产生重复的恢复标签，也不改变选中项。没有保存标签关联的 Host 终端作为恢复标签打开；恢复失败时提供 **重试恢复终端**。保存的进程已消失时，显示本地化的不可用提示和 **新建终端**。点击后在原位置用全新终端替换失效标签；恢复过程不会自动创建替代进程。

终端背景、默认文字、光标和选区跟随 DSH 主题，包括系统偏好和主题令牌覆盖。切换主题会保留运行中的 shell、输出和应用通过 OSC 设置的颜色。颜色重置命令恢复到当前 DSH 默认值。xterm 将文字对比度调整到 4.5:1；光标与所在单元格背景保持至少 3:1 的对比度，包括 Vim 配色方案。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

插件向右侧栏注册 `terminal` 类型及正文和标题 seat。开始页入口使用紧凑的黑底终端图标，页签标题保留线条图标。无 React 依赖的终端模型属于 `api-terminal-controller`，通过框架 keyed hooks 暴露状态。`ui-primitives` 的 Menu 与 Button 提供 shell 选择和启动控件，支持键盘导航与选中标记。正文在 terminal 视图挂载时加载包内 `client.terminal.js` chunk，使 xterm.js 与 FitAddon 不进入启动 `client.js`；加载后由它们负责屏幕渲染和视口测量。正文在面板高度内为页签条下方预留 8px 间距。输入原样传到 PTY，包括 Tab 和控制字符。

Session header contribution 查询 Host 终端，只打开没有现有标签关联的终端。终端 controller 独立保存每个全局唯一内容身份与 Host 的关联，并负责内容恢复；侧栏负责布局持久化。恢复视图不能分配替代进程。侧栏关闭 handler 通过[终端 controller](../../api/terminal-controller/README.zh.md#understand-the-implementation)安排清理并同步返回。浏览器组件清理和 tab 的 abort signal 只停止浏览器工作。

插件启动时，侧栏完整打开标签清单中的 terminal 条目会持有相匹配的已保存 Host 身份，包括非当前 Session。窗口持有关系独立于 React 挂载和屏幕订阅。删除最后一个匹配的 occurrence 会释放持有关系；折叠或切换视图不会释放。[终端控制器](../../api/terminal-controller/README.zh.md#use-this-package) 负责无人持有时的空闲回收和长命令保护。

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
- 应用的 OSC 颜色覆盖由已挂载的渲染器保留；新打开的渲染器无法从 Host 屏幕快照恢复这些颜色。
- 终端历史有上限。此功能不向 Agent 发送终端输出，不在单个标签页内拆分终端，也不在 Host 重启后恢复进程。
- Terminal chunk 加载失败后需要刷新页面，因为 React 会在页面生命周期内缓存被拒绝的 lazy import。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

不发布运行时 invariant companion。终端元数据与屏幕更新由同一对象按序写入，没有独立的进程尺寸观测可供比较。

</details>
