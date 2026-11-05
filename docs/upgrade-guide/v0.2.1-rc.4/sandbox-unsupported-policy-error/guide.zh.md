---
kind: upgrade-guide
description: "sandbox 包移除 SandboxUnsupportedPolicyError；Windows 进程忽略额外可写根目录。"
---

# 移除 SandboxUnsupportedPolicyError 导入

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-sandbox` 不再导出 `SandboxUnsupportedPolicyError`。Windows 子进程隔离忽略额外可写目录，不再以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝执行。Harness 的 `write` 与 `edit` 工具仍执行这些目录的授权；Windows 进程在 `workspace-write` 下保留工作区与私有临时目录访问权限。

## 迁移

1. 移除针对 `SandboxUnsupportedPolicyError` 或 `SANDBOX_UNSUPPORTED_POLICY` 的导入与错误处理。
2. 在 Windows 上使用 Harness 文件工具写入额外目录。不要假定进程启动成功就意味着这些目录已获授权。
3. 重新构建消费方，验证工作区命令可以运行，额外目录仍仅能通过文件工具访问。
