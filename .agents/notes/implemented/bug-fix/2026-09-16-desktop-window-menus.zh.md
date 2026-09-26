# Agent Note: Desktop standard macOS window menus

Status: implemented

[English](2026-09-16-desktop-window-menus.md) | 中文

## 问题

Desktop shell 用自定义模板替换了 Electron 的默认应用菜单，该模板此前只列出应用菜单和 Edit 菜单。Electron 只构建模板中声明的 role，因此 macOS 失去了默认模板提供的 File、Window 菜单和应用隐藏命令，包括 Close Window（⌘W）、Minimize（⌘M）和 Hide（⌘H）。这些快捷键在 Desktop 应用中都没有任何效果，而同类的 macOS 应用都会响应它们（#4374）。

## 决策

macOS 上的模板在 Edit 菜单之后声明 `{ role: 'windowMenu' }`，并在应用子菜单的 Quit 之前声明由分隔符隔开的 `hide`、`hideOthers` 和 `unhide`。这些 role 只提供标准菜单项；不声明 Services 子菜单、窗口列表或其他 macOS 默认项。Windows 和 Linux 保留应用菜单和 Edit 菜单。[页面关闭决策](../architecture/2026-09-21-desktop-page-close-shortcuts.zh.md)负责自定义 File 菜单和关闭行为。

Electron 为 Window 和 Edit role 提供英文默认标签。显式标签会覆盖 role 的默认标签，同时保留原生命令和快捷键；本地化的应用命令见 [Desktop README](../../../../apps/desktop/README.zh.md)。最小化和隐藏通过 Electron 的 role 执行，没有自定义处理器。 关闭与激活行为已被[关闭时隐藏窗口](../architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.zh.md)部分取代；这里的菜单声明仍然有效。

## 考虑过的替代方案

**把 ⌘W 绑定为最小化或隐藏窗口。** macOS 把最小化留给 ⌘M、把隐藏留给 ⌘H，同类应用都用 ⌘W 关闭最前窗口。给这个快捷键绑定其他命令会违背本改动所遵循的平台惯例。

**只声明 Window 菜单。** 该菜单提供 Minimize 和 Zoom，但不提供关闭，⌘W 仍然没有绑定。

**在应用子菜单里直接加一个 `{ role: 'close' }` 项。** 这样可以避免只有一个命令的 File 菜单，但会把窗口命令放到 Plugins、Updates、Hide、Quit 这些应用级命令中间，没有 macOS 应用这样排布。

**在所有平台都声明 File 和 Window 菜单。** 同一份模板在那些平台会把 Ctrl+W 声明为关闭；应用只有一个窗口，关闭它会触发 `window-all-closed` 并退出应用。恢复菜单的任务没有要求这条退出路径；页面关闭决策明确规定了 Desktop 回退。

**让 Dock 激活时无论其他窗口是否存在都重建主窗口。** 插件窗口可以比主窗口存活更久，因此把 `activate` 的判断从 `BrowserWindow.getAllWindows()` 改为 `mainWindow` 能让点击 Dock 总可以恢复主窗口。但这超出了恢复被压掉的平台命令，属于窗口生命周期的行为变更，因此保留现有的 `activate` 判断。

## 影响

macOS 通过四个菜单 role 保留原生 Window 和应用隐藏命令。Window 和 Edit 保留 Electron 的默认英文标签；应用命令使用 Desktop 的语言。

## 测试

`apps/desktop/tests/main-startup.spec.ts` 验证各平台声明的菜单 role，并记录中英文应用标签快照。基于 role 的菜单项由本机执行，因此程序化的 `click()` 和 Vitest 的 Electron mock 都无法触达这些快捷键。独立 Electron 44 demo 确认显式应用标签会显示在原生菜单中；模板快照不能验证原生快捷键的执行。
