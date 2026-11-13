---
description: "按 AUMID 发现 Windows 应用，并观察或操作明确选择的窗口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cua-windows

[English](README.md) | 中文

## 概述

通过共享的 [Computer Use API](../cua/README.zh.md) 发现 Windows 应用、获取授权，然后观察和操作应用窗口。模拟键盘和鼠标输入已可用，支持文本输入、粘贴、按键、独立按下与抬起事件、鼠标移动、点击、滚动和拖拽。选择应用、选择窗口、读取辅助功能树和前台激活是彼此独立的动作。本页说明 Windows 平台的接口语义与安全交互规范。

## 目录

- [运行条件与配置](#setup)
- [接口语义](#interface-semantics)
- [交互规范](#interaction-rules)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="setup"></a>
## 运行条件与配置

在原生 Windows 的源码检出中，提供方启用时通过 PATH 中的 .NET 10 SDK 构建当前架构的 helper，输出到 `native/bin/win-<arch>`。`helperPath` 可指定现有 exe 的绝对路径。手动构建时，在本包中执行 `pnpm run build:native:x64` 或 `pnpm run build:native:arm64`。使用独立 win-x64 ZIP 时，需要完整解压，并将 `helperPath` 指向其中的 exe。使用 `build:native` 生成的 `native/bin/local` 产物时，需要匹配的 Windows .NET 运行时，并显式配置 `helperPath`。

`buildTimeoutMs` 默认 300000，`connectTimeoutMs` 默认 30000，`pollIntervalMs` 默认 25。辅助功能树默认最多读取 2000 个节点、深度 25。一次读取可传入 `maxElements` 和 `maxDepth`。组合包仅在原生 Windows 上加载此提供方。显式在 WSL 中配置提供方时，`windowsPowerShellPath` 默认是 `powershell.exe`。目前 WSL 缓存只复制 exe，多文件发布目录不能直接从该缓存启动。

<a id="interface-semantics"></a>
## 接口语义

### 应用发现

应用发现采用 PowerShell `Get-StartApps` 所使用的 AppsFolder 目录口径：当前用户可发现的开始菜单应用，而不是所有后台进程或磁盘上的可执行文件。`cua.listApps()` 还会补充可访问的顶层窗口所关联的应用。最终结果不保证与该命令的输出逐项一致；应以 `cua.listApps()` 返回的 ID 为准。

每条结果包含 `id`、`displayName` 和 `isRunning`。ID 是 AUMID；Windows 没有提供窗口或进程 AUMID 时，使用完整可执行文件路径作为兜底标识。只有完全相同的 ID 字符串才合并。匹配区分大小写，不规范化路径，也不按名称或可执行文件合并。必须原样传回返回的 ID；显示名称、PID、窗口 ID 或任意路径都不是替代选择器。

`isRunning` 表示本次发现存在关联窗口，不表示存在后台进程。目录中的应用没有窗口时返回 `false`；仅最小化窗口不会使应用被判定为未运行。无法访问的窗口或进程会被忽略。应用目录读取失败时，请求整体失败，不会只返回窗口侧的发现结果。`cua.getState()` 汇总相同的应用发现结果，不读取辅助功能树。

### 应用与窗口选择

- `cua.getApp(id)` 请求应用授权，成功后返回 App。它不读取辅助功能树，也不激活应用。Windows 不支持启动应用；无窗口应用的选择还受下方限制约束。
- `app.getWindows()` 读取应用当前的窗口列表。一个应用可以跨多个进程拥有多个窗口；窗口关闭后，列表也可以变为空。
- `app.getWindow(windowId)` 返回 Window 对象，不读取辅助功能树。窗口 ID 是提供方返回的不透明字符串，请原样传递。执行窗口操作时会检查目标是否仍属于所选应用。
- `window.getAccessibilityTree()` 显式读取辅助功能树。元素 ID 属于当前观察；读取同一 App 的另一个窗口会替换门面当前使用的快照。不要跨窗口混用元素或快照。
- `window.getScreenshot()` 截取明确指定的窗口，不读取或替换辅助功能树。辅助功能读取失败时，截图仍可能可用。
- `app.activate()` 显式请求前台激活。`app.show()` 恢复默认窗口而不请求激活；`window.show()` 恢复指定窗口。没有默认窗口时返回 `WINDOW_NOT_FOUND`，无法唯一确定默认窗口时返回 `AMBIGUOUS_WINDOW`。

<a id="interaction-rules"></a>
## 交互规范

1. 选择操作前先检查 `cua.getCapabilities()`。Windows 的辅助功能和键盘输入仅支持窗口作用域；截图和指针操作也必须使用 Window 对象。
2. 使用元素 ID 前先读取辅助功能树。绝对指针坐标采用最近一次返回的截图像素，以该窗口为原点。`relative: true` 在相应的 AX 观察或截图之后使用 0 到 999 的整数千分比坐标。窗口尺寸变化后重新截图。
3. `pressKey`、`click` 和 `drag` 都接受 `ctrl`（别名 `control`）、`alt` 和 `shift`。只有 `click` 和 `drag` 接受 `win`。系统键盘和指针输入要求目标窗口位于前台。解释必要的焦点切换，显式激活应用或让用户聚焦目标窗口，再重新观察。不要假定选择 App 或 Window 会改变焦点。
4. `dispatched` 只表示分派情况，不证明预期效果已经发生。继续操作前先观察结果。窗口变化、快照过期、超时或取消后，不要盲目重放输入，也不要自动切换目标窗口。
5. 授权针对当前会话中的应用。尊重拒绝和撤销，不使用其他工具绕过。重新连接会使已保留的句柄失效，继续操作前必须重新选择应用。

<a id="model-experience"></a>
## 模型体验

### 明确指定应用与窗口的操作

#### 模型看到什么

程序可以读取应用和窗口标识、观察结果及动作结果。仅执行选择操作不会提供辅助功能树。

#### Token 影响

程序可以在内存中处理返回的树和截图。需要展示时，把选定的文字或图片传给 `inspect(...values)`。

#### KV 缓存影响

传给 `inspect` 的结果会追加到模型历史。在程序中保留 App、Window 或观察结果时，已有提示词前缀保持不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 通过 npm 安装的包不含 Windows helper。x64 可使用独立 ZIP，ARM64 需要对应架构的构建产物，见[配置说明](#setup)。
- 悬停、点击、滚动和拖拽使用系统指针。`requireSystemPointerApproval` 不会为 Windows 操作弹出单独的指针授权提示。
- 拖拽只检查起点处最上层的窗口。若其他应用遮住路径或终点，即使目标仍在前台，也可能把内容拖到其他应用。
- 清理输入时，helper 不检查每个按键或鼠标按钮的释放结果。操作失败后如有按键或按钮仍处于按下状态，请先手动释放。
- helper 的身份摘要只覆盖 exe。同一 apphost 搭配不同 DLL 时可能复用旧服务。重新构建前请先关闭使用同一输出目录的 Host，避免文件被占用。
- Windows 握手要求 `maxClickHoldMs` 为正整数。设为 0 会使连接以 `INVALID_CONFIG` 失败，连普通点击和状态查询也不可用。
- 不支持 `findApps`、启动应用和应用级辅助功能。请让用户打开所需应用或窗口。
- 可以发现 `isRunning: false` 的应用，但当前 `getApp` 流程会尝试未支持的启动操作，并以 `UNSUPPORTED` 失败。选择这类应用前应先打开窗口。
- 观察和输入需要可访问、未锁定的交互式 Windows 会话。截图需要 Windows Graphics Capture 支持；列出的窗口仍可能无法截图或接收输入。
- 应用授权不提供 **Always allow（始终允许）** 选项。其他会话需要分别获得授权。

<a id="dev-note"></a>
### 开发备注

无。
