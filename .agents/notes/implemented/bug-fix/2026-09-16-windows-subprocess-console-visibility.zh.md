# Agent Note: 在创建时隐藏 Windows 子进程控制台窗口

Status: implemented

[English](2026-09-16-windows-subprocess-console-visibility.md) | 中文

## 问题

PTC 运行时和 shell 调用共用 Windows 子进程提供方。其普通 Job runner 未设置窗口隐藏，原生目标只提供标准句柄而没有启动可见性标志。因此，Desktop 执行短命令时可能闪现控制台窗口。

## 决策

私有 Node Job runner 使用 `windowsHide: true`。普通和受限令牌原生进程创建在目标代码运行前，将 `STARTF_USESHOWWINDOW` 和 `SW_HIDE` 与标准句柄一起传入。控制台继承、恢复线程前分配 Job 和管道归属保持不变。任何操作都不隐藏已有父控制台，也不承诺抑制命令显式打开的窗口。

[ACL 沙箱决策](../feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md) 仍负责受限令牌策略和控制台隔离限制。设置初始窗口可见性不需要向受限进程创建添加 `CREATE_NO_WINDOW` 或 `CREATE_NEW_CONSOLE`。

## 考虑过的替代方案

**仅隐藏外层 runner。** 原生目标创建独立于 Node 启动选项，因此也需要明确设置初始可见性。

**移除所有进程的控制台。** 受限令牌配合控制台隔离标志存在已记录的 DLL 初始化失败。启动可见性设置保留现有控制台附着规则。

**PowerShell 启动后再隐藏窗口。** 窗口可能在脚本执行前已经可见；创建时设置可避免这一间隔。

## 后果

普通子进程启动抑制附带控制台窗口，不改变工具输出或进程清理。原生 Windows 测试检查后代进程和两种 ACL 模式的控制台可见性，并配合现有流、控制管道和 Job 生命周期测试。没有控制台也是有效状态；测试不要求控制台必须存在。启动参数测试固定创建时的保证，单独观察最终可见性无法确认这一点。

会话录制无法观察原生控制台窗口，转录内容也没有变化。此回归由 Windows 原生测试负责；浏览器截图无法确认桌面窗口不存在。
