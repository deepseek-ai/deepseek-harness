---
kind: upgrade-guide
description: "sdk-minimal profile 现在会在会话持久化无法完成检查点时停止模型和工具调度。"
---

# SDK-minimal 要求持久化检查点

[English](guide.md) | 中文

## 变更

`sdk-minimal` profile 启用 `session-checkpoint-policy`，在模型请求、顶层工具执行和 agent step 之前等待会话历史刷盘。此前，JSONL 写入尚在缓冲时这些操作也可以继续，持久化错误可能只记录为后台警告。现在，检查点失败会停止依赖它的操作。首次文件锁初始化发生在第一次模型请求之前，检查点写入也计入请求延迟。此变更不修改 Session 格式，也不保证强制终止时保留最后尚未刷盘的回复。

## 迁移

1. 确保选定的 `dsh_home` 可写，并让请求超时覆盖存储初始化和检查点写入。仅延长关闭超时不会影响请求前的检查点。
2. 检查 profile 和调用级 patch 是否覆盖了 `session-checkpoint-policy`。要使用此持久化策略，应在 `sessions` 旁保留其默认启用状态。
3. 运行一轮 SDK 短对话，正常关闭，再使用相同 home 和会话 ID 调用 `resume_session()` 验证恢复。重试模型或工具操作前，先排查检查点失败；只有检查点成功后，操作才会执行。
