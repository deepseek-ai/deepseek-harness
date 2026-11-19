---
kind: upgrade-guide
description: macOS CUA 的显式输入跨程序和回合保持，成功结束的程序通过 system reminder 报告持有状态。
---
# CUA 在程序结束后报告持有输入

[English](guide.md) | 中文

## 变更

在 DSH 回合中，macOS 的显式 `sendKeyEvent('down')` 和 `toggleMouse('down')` 跨程序、跨回合保持，直到显式 `up`。正常结束不释放它们。成功结束的 `run_code` 或 `cua_run_code` 通过 system reminder 列出剩余键盘键和鼠标按钮、所属应用或窗口及实际输入方式。程序失败、用户停止、断连、环境重置和销毁按派发顺序的反序释放所属输入。完整的 `pressKey`、`typeText`、`click` 和 `drag` 保持操作内清理。MCP 程序在返回前释放剩余输入并报告确认的自动释放，因为客户端在两次调用之间暂停时不会通知服务端。Windows 的状态报告和统一清理仍未实现。

## 迁移

1. 输入不再需要保持时，将显式 down 与 up 配对。继续操作前阅读提醒；没有持有输入时不添加提醒。
2. 同步升级 macOS 包和 helper。自定义 `helperPath` 必须实现按任务区分的 `getHeldInputs` 和 `releaseHeldInputs` 私有操作。
3. 验证成功结束的程序能持有按键、收到提醒，并在后续程序中释放。程序失败和取消必须在结束前释放它。清理无法确认时，CUA 禁用该任务后续操作；请手动检查桌面后再创建其他任务。
