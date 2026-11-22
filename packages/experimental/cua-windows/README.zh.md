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

`buildTimeoutMs` 默认 300000，`connectTimeoutMs` 默认 600000，`pollIntervalMs` 默认 25。辅助功能树默认最多读取 2000 个节点、深度 25。一次读取可传入 `maxElements` 和 `maxDepth`。组合包仅在原生 Windows 上加载此提供方。显式在 WSL 中配置提供方时，`windowsPowerShellPath` 默认是 `powershell.exe`。目前 WSL 缓存只复制 exe，多文件发布目录不能直接从该缓存启动。

<a id="interface-semantics"></a>
## 接口语义

### 应用发现

`cua.listApps()` 从当前 Windows 会话中符合条件的可见顶层窗口聚合应用。名称搜索和空查询的 `cua.findApps` 返回通过 AppsFolder 枚举的 StartApps 目录中的已安装应用。窗口观察用于补充这些目录条目的运行状态和已知可执行文件路径。目录可能不完整；找不到应用时，可以询问用户其位置。

每条结果包含 `id`、`displayName`、`identity: null` 和 `isRunning`。ID 是 AUMID；Windows 没有提供窗口或进程 AUMID 时，使用完整可执行文件路径。只有完全相同的 ID 字符串才按区分大小写的相等关系合并。将返回的 ID 原样传给 `cua.getApp`，也可以传入现有 `.exe` 文件的绝对路径。

`listApps` 结果中的 `isRunning` 为 `true`。在 `findApps` 结果中，`isRunning` 表示存在关联窗口；目录中的应用没有窗口时返回 `false`。无法访问的窗口或进程会被忽略。应用目录读取失败时，`findApps` 请求失败。`cua.getState().apps` 来自 `listApps()`。

`cua.findApps(query)` 对显示名称、ID 和已知可执行文件路径做不区分大小写的字面子串匹配，或直接检查 `.exe` 绝对路径。`""` 和 `null` 返回目录中的全部应用。非空查询须包含非空白字符，并受 `maxAppMatches` 限制，默认 20；匹配过多时返回 `AMBIGUOUS_APP`。响应大小和时间限制适用于所有查询。

### 应用与窗口选择

- `cua.getApp(id)` 请求应用授权，成功后返回 App。它不读取辅助功能树，也不激活应用。尚未运行的应用在授权后通过 Explorer 启动。
- `app.getWindows()` 读取应用当前的窗口列表。一个应用可以跨多个进程拥有多个窗口。已接纳的 HWND 在有效期间保留在列表中，包括隐藏窗口。
- `app.getWindow(windowId)` 返回 Window 对象，不读取辅助功能树。窗口 ID 是提供方返回的不透明字符串，请原样传递。Windows 首次接纳窗口时检查应用归属，此后只要 HWND 有效就信任它。
- `window.getAccessibilityTree()` 显式读取辅助功能树。元素 ID 属于当前观察；读取同一 App 的另一个窗口会替换门面当前使用的快照。不要跨窗口混用元素或快照。
- 通过 `getActionSchema(action)` 查询动作的参数 JSON Schema。
- `window.getScreenshot()` 截取明确指定的窗口，不读取或替换辅助功能树。辅助功能读取失败时，截图仍可能可用。
- `app.launch()` 请求启动应用的新实例，等待所选应用的 HWND 集合变化或启动等待时限到达。单例程序可能仅激活已有实例，启动的实例也可能归属于另一个应用 ID。
- `app.activate()` 显式请求前台激活。`app.show()` 恢复默认窗口而不请求激活；`window.show()` 恢复指定窗口。没有默认窗口时返回 `WINDOW_NOT_FOUND`，无法唯一确定默认窗口时返回 `AMBIGUOUS_WINDOW`。

<a id="interaction-rules"></a>
## 交互规范

1. 选择操作前先检查 `cua.getCapabilities()`。Windows 的辅助功能和键盘输入仅支持窗口作用域；截图和指针操作也必须使用 Window 对象。
2. 使用元素 ID 前先读取辅助功能树。绝对指针坐标采用最近一次返回的截图像素，以该窗口为原点。`relative: true` 在相应的 AX 观察或截图之后使用 0 到 999 的整数千分比坐标。窗口尺寸变化后重新截图。
3. `pressKey`、`click` 和 `drag` 都接受 `ctrl`（别名 `control`）、`alt` 和 `shift`。只有 `click` 和 `drag` 接受 `win`。系统键盘和指针输入要求目标窗口位于前台。解释必要的焦点切换，显式激活应用或让用户聚焦目标窗口，再重新观察。不要假定选择 App 或 Window 会改变焦点。
4. `dispatched` 只表示分派情况，不证明预期效果已经发生。继续操作前先观察结果。窗口变化、快照过期、超时或取消后，不要盲目重放输入，也不要自动切换目标窗口。
5. 授权针对当前会话中的应用。尊重拒绝和撤销，不使用其他工具绕过。重新连接会使已保留的句柄失效，继续操作前必须重新选择应用。

`win.toggleMouse(button, direction)` 在当前指针位置发送一次系统按键事件。按下时，所选窗口必须在前台，指针也必须命中该窗口。请通过原 Window 对象松开；松开只释放桌面按钮，不切换焦点，也不移动指针。

<a id="model-experience"></a>
## 模型体验

### 明确指定应用与窗口的操作

#### 模型看到什么

程序可以读取应用和窗口标识、观察结果及动作结果。仅执行选择操作不会提供辅助功能树。程序成功后，提醒会列出仍按住的键和鼠标按钮、所属窗口和桌面输入方式。一条连接持有按键或鼠标按钮时，其他连接仍可使用不同的键或按钮。程序异常、取消或重置时会请求按派发顺序的反序释放。断连时，helper 会在关闭时限内最后尝试一次。失败或超时后，它会静默丢弃这条连接的持有记录。

#### Token 影响

程序可以在内存中处理返回的树和截图。需要展示时，把选定的文字或图片传给 `inspect(...values)`。

#### KV 缓存影响

传给 `inspect` 的结果会追加到模型历史。在程序中保留 App、Window 或观察结果时，已有提示词前缀保持不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- `getAccessibilityTree` 或原始 `getState` 的 `showDiff: true` 返回 `UNSUPPORTED`，Windows 的 AX 差分输出暂未实现。省略该选项或传 `false` 可读取完整树。
- 通过 npm 安装的包不含 Windows helper。x64 可使用独立 ZIP，ARM64 需要对应架构的构建产物，见[配置说明](#setup)。
- 悬停、点击、滚动和拖拽使用系统指针。`requireSystemInputApproval` 不会为 Windows 操作弹出单独的指针授权提示。
- 拖拽只检查起点处最上层的窗口。若其他应用遮住路径或终点，即使目标仍在前台，也可能把内容拖到其他应用。
- 持有提醒和清理只依据 helper 自己派发的输入。如果你也按住同一个键或按钮，helper 之后发送的 up 可能打断你的按压。
- Windows 通过桌面派发输入。焦点变化或原窗口关闭后，确认释放表示桌面接受了 up，原窗口可能收不到该事件。释放时直接发送保存的 up 事件，无需检查当前前台窗口或锁屏状态。显式 up 返回 `foregroundChanged: null`。若 Windows 在处理显式清理请求时拒绝 up，本任务不能继续使用 CUA。请先检查桌面，再开始新任务。
- 清理完整动作内的临时输入时，helper 不检查每个按键或鼠标按钮的释放结果。操作失败后如有按键或按钮仍处于按下状态，请先手动释放。
- helper 的身份摘要只覆盖 exe。同一 apphost 搭配不同 DLL 时可能复用旧服务。重新构建前请先关闭使用同一输出目录的 Host，避免文件被占用。
- Windows 握手要求 `maxClickHoldMs` 为正整数。设为 0 会使连接以 `INVALID_CONFIG` 失败，连普通点击和状态查询也不可用。
- 不支持应用级辅助功能；读取树前必须明确选择窗口。
- 如果启动后 `getWindows()` 仍为空，请让用户打开所需窗口。
- 观察和输入需要可访问、未锁定的交互式 Windows 会话。截图需要 Windows Graphics Capture 支持；列出的窗口仍可能无法截图或接收输入。
- 应用授权不提供 **Always allow（始终允许）** 选项。其他会话需要分别获得授权。

<a id="dev-note"></a>
### 开发备注

无。
