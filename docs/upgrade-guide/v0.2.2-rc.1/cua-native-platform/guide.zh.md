---
kind: upgrade-guide
description: "迁移 CUA 脚本和自定义原生提供方，使用显式窗口、字符串元素 ID 和平台能力声明。"
---

# 原生 CUA 应用和窗口 API

[English](guide.md) | 中文

## 变更

截图和指针输入要求显式选择窗口。App（`appHandle`）和 Window（`windowId`）对象共享所属应用句柄的最新辅助功能快照。应用发现返回运行中匹配项的 PID。

提供方声明启动能力，并实现 `getGuidance(kind)`，不再传入 `guidance` 字符串。`raw` 选择原始 `cua` 工具的指引，`standalone` 选择 `cua_run_code` 的指引。原生 helper 返回运行时权限和会话锁定状态，Host 将其与启动能力合并到 `getCapabilities()` 中。供权限页面使用的响应带有 `darwin` 或 `win32` 平台标记。

## 迁移

1. 调用 `cua.getApp(selector)` 后，从 `app.getWindows()` 返回的列表选定目标，再调用 `app.getWindow(windowId)`。在窗口上调用 `getScreenshot()`、`click()`、`scroll()` 和 `drag()`，将原有的 `hover` 调用改为 `window.mouseMove()`。在 macOS 上，`window.click(id)` 在元素中心发送鼠标事件。需要执行默认辅助功能动作时，改用 `invoke(id)`。需要打开控件菜单且控件声明了 `AXShowMenu` 时，调用 `performAction(id, "AXShowMenu")`。
2. 将 `getAXState()` 改为 `getAccessibilityTree()`，将 `getAXStateAndScreenshot()` 拆成读取树和截图两次调用。选择应用或窗口不读取 AX。使用元素 ID 前须显式调用 `getAccessibilityTree()`；使用 `{ emit: false }` 可保留快照但不显示树。截图不要求 AX 读取成功。所有坐标输入（包括相对坐标）之前都须成功读取覆盖该窗口的 AX 或取得截图；绝对坐标要求截图。[读取上限的迁移说明](../cua-ax-read-limits/guide.zh.md)列出了 macOS 默认值和配置含义的变化。
3. 将数字元素索引改为从最新树中取得的字符串 ID。直接发送请求时使用 `elementId` 和 `snapshotId`。原先调用 `performSecondaryAction` 的地方，先用 `listActions(id)` 取得完整动作名，再调用 `performAction(id, exactName, argument?)`。要执行默认动作，可调用 `invoke(id)`。`setValue` 接受提供方支持的 JSON 值。 在 macOS 上，`performAction(id, 'AXRaise')` 只执行元素声明的抬起窗口动作。需要把应用切到前台时先调用 `app.activate()`。
4. 将 `pressKey('shift+Tab')` 之类的组合键写法改为 `pressKey('Tab', ['shift'])`。调用 `sendKeyEvent` 前检查 `(await cua.getCapabilities()).methods`。在 macOS 上，同一次 `run_code` 或 `cua_run_code` 中可调用此方法跨工具调用保持按键。如果需要一次重复按下，可在这次执行中对已按住的普通键再发一次 `down`。执行返回、异常退出或用户暂停时会释放仍按着的键。如果脚本用 `NATIVE_ERROR` 识别 macOS 上的未知键名，请改为处理 `INVALID_ARGUMENT`，并在重试前修正键名。
5. 从动作结果读取 `dispatched`，再观察应用确认效果。元素没有默认动作时，`invoke` 返回 `dispatched: false`。移除读取旧字段 `verified` 的代码，以及对已选对象和窗口记录中 `pid` 的读取。需要 PID 时，使用 `listApps()` 或 `findApps()` 返回的运行中应用记录。
6. 自定义提供方将 `CuaBackend.description` 改为 `capabilities`，将 `guidance` 改为 `getGuidance(kind)`，并向 `installCua` 传入 `permissionParameters`。两种形态可以返回相同文本。按[操作协议](../../../../packages/experimental/cua/src/protocol.ts)和[带平台标记的权限响应](../../../../packages/experimental/cua/src/access-types.ts)重新构建自定义 `helperPath` 对应的 helper。重启后验证两种工具形态的指引、声明的方法、键盘输入范围及 Computer Use 权限页的平台控件。
