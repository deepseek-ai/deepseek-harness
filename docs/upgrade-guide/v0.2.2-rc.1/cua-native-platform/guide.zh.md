---
kind: upgrade-guide
description: "迁移 CUA 脚本和自定义原生提供方，使用显式窗口、字符串元素 ID 和平台能力声明。"
---

# 原生 CUA 应用和窗口 API

[English](guide.md) | 中文

## 变更

CUA 脚本在指定窗口上截图和操作鼠标。App 和 Window 对象共享同一应用句柄最近读取的辅助功能快照。App 用 `appHandle` 标识，Window 用 `windowId` 标识。查找应用时，运行中的匹配项仍提供 PID。

提供方在安装时声明固定的平台能力并提供操作指引。原生 helper 返回实际的权限和会话锁定状态。Host 合并两者，作为 `getCapabilities()` 的结果。供权限页面使用的响应带有 `darwin` 或 `win32` 平台标记。

## 迁移

1. 调用 `cua.getApp(selector)` 后，从 `app.getWindows()` 返回的列表选定目标，再调用 `app.getWindow(windowId)`。在窗口上调用 `getScreenshot()`、`click()`、`scroll()` 和 `drag()`，将原有的 `hover` 调用改为 `window.mouseMove()`。
2. 将 `getAXState()` 改为 `getAccessibilityTree()`，将 `getAXStateAndScreenshot()` 拆成读取树和截图两次调用。选择窗口时会静默读取初始树。选择应用时，只有 `appLevelAccessibility` 为真才读取。要显示树，请显式读取。
3. 将数字元素索引改为从最新树中取得的字符串 ID。直接发送请求时使用 `elementId` 和 `snapshotId`。原先调用 `performSecondaryAction` 的地方，先用 `listActions(id)` 取得完整动作名，再调用 `performAction(id, exactName, argument?)`。要执行默认动作，可调用 `invoke(id)`。`setValue` 接受提供方支持的 JSON 值。 在 macOS 上，`performAction(id, 'AXRaise')` 只执行元素声明的抬起窗口动作。需要把应用切到前台时先调用 `app.activate()`。
4. 将 `pressKey('shift+Tab')` 之类的组合键写法改为 `pressKey('Tab', ['shift'])`。调用 `sendKeyEvent` 前检查 `(await cua.getCapabilities()).methods`。macOS 支持完整按键，单独发送按下或松开事件会返回 `NOT_IMPLEMENTED`。
5. 从动作结果读取 `dispatched`，再观察应用确认效果。元素没有默认动作时，`invoke` 返回 `dispatched: false`。移除读取旧字段 `verified` 的代码，以及对已选对象和窗口记录中 `pid` 的读取。需要 PID 时，使用 `listApps()` 或 `findApps()` 返回的运行中应用记录。
6. 自定义提供方需将 `CuaBackend.description` 改为 `capabilities`，并向 `installCua` 传入 `guidance` 和 `permissionParameters`。如配置了 `helperPath`，请按[操作协议](../../../../packages/experimental/cua/src/protocol.ts)和[带平台标记的权限响应](../../../../packages/experimental/cua/src/access-types.ts)重新构建 helper。重启提供方，检查它声明的方法和键盘输入范围，再打开 Computer Use 权限页确认平台控件。
