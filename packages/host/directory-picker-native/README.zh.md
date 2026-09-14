---
description: "目录选择 seam 的原生 OS 选择器后端：为坐在 web GUI 宿主屏幕前的操作者每次打开一个平台选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-native

[English](README.md) | 中文

## 概述

坐在宿主屏幕前的操作者通过原生 OS 选择器选择工作区目录：`dsh-host-directory-picker-native` 每次选择打开一个平台目录选择器，并解析出所选绝对路径（取消时为 `null`）。macOS 驱动 `osascript`，Linux 使用 Zenity 并以 KDialog 回退，Windows 在 spawn 的子进程中打开现代 `IFileOpenDialog`。只有操作者坐在宿主屏幕前时才可用——远程部署应组合[浏览后端](../directory-picker-browse/README.zh.md)。一行组合配置还会在工作区流程中注册匹配的浏览器侧交互，因此同时选择两侧。

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

当操作者工作在宿主屏幕前，且原生选择器是合适的交互时，组合此后端。打开目录选择器的工作区流程每个打开请求调用一次 `pick(signal)`；返回的 Promise 解析为所选绝对路径，操作者取消时解析为 `null`。

### 何时选择

为 macOS、Windows 或桌面 Linux 上的工作站本地操作者选择此后端。当客户端无法触达 OS 选择器时——远程浏览器、SSH 转发会话或无人值守宿主——请选择[浏览后端](../directory-picker-browse/README.zh.md)。具体情况不固定时，[自适应选择器](../directory-picker-auto/README.zh.md)会在启动时判定。

### 操作者会看到什么

每次调用在宿主屏幕上打开一个原生选择器并等待操作者；中止调用方的信号会终止选择器进程，而不是让它留在屏幕上。Linux 上选择器需要安装 Zenity 或 KDialog 之一；两者都没有时，`pick` 以包含解决建议的错误拒绝，而不会回退为手输路径提示。本包的浏览器端向工作区流程注册一个无渲染的流程占用者——每次 `open` 请求驱动 `directoryPicker/pick`，并上报唯一结果（所选路径、取消或失败）。

### 可观察的失败

取消返回 `null`，不是错误。平台工具缺失、选择器启动失败或选择操作中止都会导致 Promise 拒绝，界面可呈现相应错误；[浏览后端](../directory-picker-browse/README.zh.md)仍是原生目录选择不可靠时的组合层回退方案。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

后端是平台选择器之上的一层薄服务：`NativeDirectoryPicker` 注册 `native` 能力，其 `pick` 转发给 `pickNativeDirectory`，选择器以子进程运行，因此宿主进程不会因对话框而阻塞。命令边界（`DirectoryPickerRunner`）与平台事实可注入；共享的免 shell 子进程运行器位于 [`dsh-native-command`](../../util/native-command/README.zh.md)。

### 平台机制

平台工具不经 shell 调用：macOS 使用 `osascript`，Linux 使用 Zenity 并以 KDialog 回退；调用方的中止信号会终止原生进程。Windows 在 spawn 的子进程中打开现代 `IFileOpenDialog`——由 koffi 在子进程主线程上驱动的 COM 会话，采用宿主接受的最佳线程 DPI 感知（优先 per-monitor-v2），中止时向对话框线程投递 `WM_CLOSE`。在 `Show` 之前，子进程立即通过 `keybd_event` 合成一次 Alt 按键，让对话框即使由后台宿主进程 spawn 也能激活为前台窗口。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：持有稳定 `native` 能力的 `NativeDirectoryPicker` 服务 |
| [`src/native-picker.ts`](src/native-picker.ts) | 选择器分发：平台选择、子进程运行、中止接线 |
| [`src/win32-dialog.ts`](src/win32-dialog.ts) 及同族文件 | Windows 经 koffi 的子进程 `IFileOpenDialog`、DPI 处理、`WM_CLOSE` 中止 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当后端约定不够用时阅读以下内容：先看 seam 定义，再看替代后端与在两者之间选择的那个选择器。

- [目录选择 seam](../directory-picker/README.zh.md)——`native` 能力约定与类型化错误词汇。
- [目录选择能力 seam 决策](../../../.agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.md)——后端为何在交互形态上彼此不同。
- [浏览后端](../directory-picker-browse/README.zh.md)——面向远程客户端的应用内替代方案。
- [自适应选择器](../directory-picker-auto/README.zh.md)——native 与 browse 之间的启动时判定。
- [免 shell 子进程运行器](../../util/native-command/README.zh.md)——选择器运行所依赖的共享子进程原语。

-----

<a id="model-experience"></a>
## 模型体验

无。GUI 宿主的目录选择后端不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明原生交互何时不可用或不稳定。它们是当前包约束，不是任务积压。

- **Linux 依赖桌面工具**——Zenity 与 KDialog 均未安装时，`pick` 以包含解决建议的错误拒绝；它不会回退为手输路径提示（组合层面的回退是浏览后端）。
- **Windows 没有机制级回退**——通过打包依赖 koffi 运行的子进程选择器是唯一原生层级，因此 COM 拒绝或对话框崩溃会直接上报失败；组合层面的回退仍是浏览后端。
- **Windows 前台授权依赖注入的输入**——子进程在 `Show` 之前合成一次 Alt 按键，对话框才能从后台宿主取得前台；在合成输入被抑制的环境（安全桌面、受限远程会话、提权前台窗口）中，对话框仍可能在其他窗口后面打开。该技术仅在 Windows 11 上验证过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每次选择都是一次无状态的子进程往返；选择器的结果仅为返回的路径。
