---
kind: upgrade-guide
description: "JobId 现在跨注册表生命周期标识一次后台执行。"
---

# 后台 job id 标识一次执行

[English](guide.md) | 中文

## 变更

job 注册表返回 `<kind>-<short-uuid>`，不再返回 `<kind>-N`；后缀是 UUID 的 16 位小写十六进制字符。运行期控制、`job/registered` 和 `job/settled` 使用同一个 `JobId`；生命周期记录不再携带 `executionId`。访问仍按所有者授权。已有 Session 历史保持原样，不会恢复其中的 job。

## 迁移

1. 把启动结果或 `jobs.list()` 返回的原始 id 传给 `job_output` 和 `job_kill`；等待时为 `job_output` 设置 `wait: true`。移除按 kind 和序号构造 id 的代码。
2. 使用 `data.jobId` 配对 SDK 生命周期事件。移除 `JobExecutionId` 导入，以及将它映射为进程内 `jobId` 的代码。
3. 核对新 job 的注册与结算含有相同 `jobId`，后续注册表实例发放不同 id。
