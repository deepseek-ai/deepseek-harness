---
description: "按 AUMID 发现 Windows 应用，并观察或操作明确选择的窗口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cua-windows

[English](README.md) | 中文

## 概要

通过共享的 [Computer Use API](../cua/README.zh.md) 发现 Windows 应用、获取授权，然后观察和操作应用窗口。选择应用、选择窗口、读取辅助功能树和前台激活是彼此独立的动作。本页说明 Windows 平台的接口语义与安全交互规范。

## 目录

- [接口语义](#interface-semantics)
- [交互规范](#interaction-rules)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="interface-semantics"></a>
## 接口语义

### 应用发现

应用发现采用 PowerShell `Get-StartApps` 所使用的 AppsFolder 目录口径：当前用户可发现的开始菜单应用，而不是所有后台进程或磁盘上的可执行文件。`cua.listApps()` 还会补充可访问的顶层窗口所关联的应用。最终结果不保证与该命令的输出逐项一致；应以 `cua.listApps()` 返回的 ID 为准。

每条结果包含 `id`、`displayName` 和 `isRunning`。ID 是 AUMID；Windows 没有提供窗口或进程 AUMID 时，使用完整可执行文件路径作为兜底标识。只有完全相同的 ID 字符串才合并。匹配区分大小写，不规范化路径，也不按名称或可执行文件合并。必须原样传回返回的 ID；显示名称、PID、窗口 ID 或任意路径都不是替代选择器。

`isRunning` 表示本次发现存在关联窗口，不表示存在后台进程。目录中的应用没有窗口时返回 `false`；仅最小化窗口不会使应用被判定为未运行。无法访问的窗口或进程会被忽略。应用目录读取失败时，请求整体失败，不会只返回窗口侧的发现结果。`cua.getState()` 汇总相同的应用发现结果，不读取辅助功能树。

### 应用与窗口选择

- `cua.getApp(id)` 请求应用授权，成功后返回 App。它不读取辅助功能树，也不激活应用。Windows 不支持启动应用；无窗口应用的选择还受下方限制约束。
- `app.getWindows()` 读取应用当前的窗口列表。一个应用可以跨多个进程拥有多个窗口；窗口关闭后，列表也可以变为空。
- `app.getWindow(windowId)` 返回 Window 对象，不读取辅助功能树。窗口 ID 是十进制字符串，应原样保留，不要转换为 JavaScript 数字。执行窗口操作时会检查目标是否仍属于所选应用。
- `window.getAccessibilityTree()` 显式读取辅助功能树。元素 ID 属于当前观察；读取同一 App 的另一个窗口会替换门面当前使用的快照。不要跨窗口混用元素或快照。
- `window.getScreenshot()` 截取明确指定的窗口，不读取或替换辅助功能树。辅助功能读取失败时，截图仍可能可用。
- `app.activate()` 显式请求前台激活。`app.show()` 恢复默认窗口而不请求激活；`window.show()` 恢复指定窗口。没有默认窗口时返回 `WINDOW_NOT_FOUND`，无法唯一确定默认窗口时返回 `AMBIGUOUS_WINDOW`。

<a id="interaction-rules"></a>
## 交互规范

1. 选择操作前先检查 `cua.getCapabilities()`。Windows 的辅助功能和键盘输入仅支持窗口作用域；截图和指针操作也必须使用 Window 对象。
2. 使用元素 ID 前先读取辅助功能树。绝对指针坐标采用最近一次返回的截图像素，以该窗口为原点。`relative: true` 在相应的 AX 观察或截图之后使用 0 到 999 的整数千分比坐标。窗口尺寸变化后重新截图。
3. 系统键盘和指针输入要求目标窗口位于前台。解释必要的焦点切换，显式激活应用或让用户聚焦目标窗口，再重新观察。不要假定选择 App 或 Window 会改变焦点。
4. `dispatched` 只表示分派情况，不证明预期效果已经发生。继续操作前先观察结果。窗口变化、快照过期、超时或取消后，不要盲目重放输入，也不要自动切换目标窗口。
5. 授权针对当前会话中的应用。尊重拒绝和撤销，不使用其他工具绕过。重新连接会使已保留的句柄失效，继续操作前必须重新选择应用。

<a id="model-experience"></a>
## 模型体验

### 明确指定应用与窗口的操作

#### 模型看到什么

应用和窗口标识、请求的观察内容及动作结果会进入正常的 Session 历史。仅执行选择操作不会提供辅助功能树。

#### Token 影响

树和图片会增加模型输入。只在内存中处理观察结果而不打印时使用 `emit: false`，避免再次打印已经输出的结果。

#### KV 缓存影响

新的观察会追加到历史；保留 App 或 Window 对象本身不会把对象内容加入提示词。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 不支持 `findApps`、启动应用、应用级辅助功能和持续按键 `sendKeyEvent`。请让用户打开所需应用或窗口。
- 可以发现 `isRunning: false` 的应用，但当前 `getApp` 流程会尝试未支持的启动操作，并以 `UNSUPPORTED` 失败。选择这类应用前应先打开窗口。
- Windows 当前忽略按次传入的 `maxElements` 和 `maxDepth` 覆盖值，仍使用提供方配置中的限制。
- 观察和输入需要可访问、未锁定的交互式 Windows 会话。截图需要 Windows Graphics Capture 支持；列出的窗口仍可能无法截图或接收输入。
- 应用授权不提供 **Always allow（始终允许）** 选项。其他会话需要分别获得授权。

<a id="dev-note"></a>
### 开发备注

无。
