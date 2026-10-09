---
kind: upgrade-guide
description: "Python PTC 组合需要沙箱服务，且直接 Python 文件操作遵循已解析文件策略。"
---

# Python PTC 应用共享文件沙箱

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-ptc-runtime-python` 需要 `sandbox` 和 `sandboxPolicy`。此前，直接 Python 文件操作不受约束，提供方拒绝显式 `sandboxPolicy` 输入。现在，它为每个程序应用共享策略，并通过 `PtcRunResult.sandbox` 报告约束情况。无法建立约束时，受限运行以 `sandbox-unavailable` 失败。

这影响选择 Python 运行时的自定义组合。已发布 profile 继续使用 Node 运行时。Python 仍限于本地 macOS 或 Linux；其配置的资源预算保持不变，仍不支持单次 timeout 覆盖。

## 迁移

1. 在选择 Python 运行时的 `cordis.yml` 或 profile patch 中，保留已有共享沙箱服务。若尚未提供，挂载 `@deepseek-ai/dsh-sandbox-local` 和 `@deepseek-ai/dsh-sandbox-policy`，以及后者所需的 `@deepseek-ai/dsh-session-projection` 服务。参见 [Python 运行时要求](../../../../packages/experimental/ptc-runtime-python/README.zh.md#use-this-package)。
2. 为无 Agent 调用设置共享 `sandbox-policy` 行的 `mode` 和 `workspaceRoot`。默认模式是 `read-only`；`workspace-write` 允许工作区写入。PTC 工具调用使用 Session 的已解析策略和目录。不要新增 Python 专用沙箱设置。
3. 直接服务调用方使用 `runtime.run(runtime.resolve(request))`；仅在需要显式覆盖时传入可信 `sandboxPolicy`。面向模型的 `run_code` 通过现有审批流程为一次调用扩大权限，不改变嵌套工具的权限，也不自动重放程序。
4. 验证程序在 `workspace-write` 下可以写入预期工作区、写入工作区外时失败，并返回 `result.sandbox.mode` 和 `result.sandbox.enforcement`。在 `read-only` 下，直接文件写入失败。将 `sandbox-unavailable` 与文件操作被拒绝区分处理，修复本地沙箱安装后再重试。
