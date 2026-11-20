---
kind: upgrade-guide
description: macOS 和 Windows 的 CUA 显式输入跨程序和回合保持，成功结束的程序通过 system reminder 报告持有状态。
---
# CUA 在程序结束后报告持有输入

[English](guide.md) | 中文

## 变更

macOS 和 Windows 的显式 `sendKeyEvent('down')` 和 `toggleMouse('down')` 跨程序、跨回合保持，直到显式 `up`。正常结束不释放它们。成功结束的 `run_code` 或 `cua_run_code` 通过 system reminder 列出剩余键盘键和鼠标按钮、所属应用或窗口及实际输入方式。程序失败、用户停止、断连、环境重置和销毁按派发顺序的反序释放所属输入。完整的 `pressKey`、`typeText`、`click` 和 `drag` 保持操作内清理。DSH 和 MCP 都在程序成功后保持输入。客户端在两次 MCP 调用之间暂停时，服务端无法观察到，输入可能继续按住。Windows 失焦后松开会释放桌面输入，不重新激活原窗口。

## 迁移

1. 输入不再需要保持时，将显式 down 与 up 配对。继续操作前阅读提醒；没有持有输入时不添加提醒。
2. 同步升级平台包和 helper。自定义 `helperPath` 必须实现按任务区分的 `getHeldInputs` 和 `releaseHeldInputs` 私有操作。
3. 验证成功结束的程序能持有按键、收到提醒，并在后续程序中释放。程序执行中失败或取消时，会等待自身的清理。如果程序执行成功，但后置策略拒绝结果，工具返回策略错误，CUA 单独等待原生释放确认。模型思考期间停止或报错，Agent 可以先结束，原生释放随后确认。后续 CUA 调用会等待清理结果。清理无法确认时，CUA 禁用该任务后续操作；请手动检查桌面后再创建其他任务。
