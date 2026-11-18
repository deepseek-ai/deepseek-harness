---
kind: upgrade-guide
description: macOS CUA 的显式键盘和鼠标按下现在可在同一回合内跨程序执行保持。
---
# macOS CUA 输入以回合为持有范围

[English](guide.md) | 中文

## 变更

macOS 的 `sendKeyEvent('down')` 可在同一回合内跨 `run_code` 和 `cua_run_code` 调用持有按键。程序返回或抛错后，回合仍继续时不再自动释放。显式 `up` 立即向原接收方释放。窗口定向和系统 `toggleMouse('down')` 使用相同生命周期。回合正常完成、异常结束或用户取消时，清理按实际派发顺序的反序释放剩余键盘键和鼠标按钮，并等待原生确认。完整的 `pressKey`、`typeText`、`click` 和 `drag` 操作继续在本次操作内清理。Windows 保持现有行为。

## 迁移

MCP 不提供 DSH 回合边界。macOS 的 `sendKeyEvent` 和 `toggleMouse` 显式持有在该入口不可用，请改用完整的 `pressKey`、`click` 或 `drag` 动作。系统鼠标移动仍可使用。

1. 如果程序需要在返回前释放输入，在 `finally` 中显式发送 `up`。否则可由同一回合中的后续程序释放。
2. 同步升级 macOS 包和 helper。自定义 `helperPath` 必须指向已重建、支持新回合输入私有协议的 helper。
3. 验证前一次程序的 `down` 能保持到后一次程序发送 `up`，或回合结束。清理无法确认时，CUA 会禁用该任务的全部操作。请手动检查桌面状态后再创建新任务。
