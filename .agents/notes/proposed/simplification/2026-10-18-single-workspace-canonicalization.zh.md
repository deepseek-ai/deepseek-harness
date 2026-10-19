# Agent Note: 每个沙箱工作区只规范化一次

Status: proposed

[English](2026-10-18-single-workspace-canonicalization.md) | 中文

## Problem

[`LocalSandboxProvider.confine()`](../../../../packages/sandbox/sandbox-local/src/index.ts) 在分派前规范化 `workspaceRoot` 并复制策略。POSIX 配置构建函数调用 [`workspaceWritableRoots()`](../../../../packages/sandbox/sandbox/src/roots.ts)，再次解析同一工作区。对于不授予工作区写权限的 POSIX 只读策略，公共预处理也会执行。

## Proposal

移除公共策略复制。保留共享 POSIX 根目录推导中的规范化；在 `windowsAclRunnerArgv()` 内规范化一次，并在 argv、SID 推导和 ACL 授权中复用该值。保留每次调用的额外根目录校验，以及各后端的临时目录规则。

## Alternatives considered

**保留公共预处理。** 它为每个后端提供统一的物理工作区标识，但 POSIX 会重复访问文件系统。显式保留 Windows 规范化可维持 [Windows ACL 决策](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)。

## Acceptance criteria

直接调用配置构建函数和使用 `runnerCommand` 时仍得到规范化的根目录。Windows argv、SID 与授权键保持一致。现有别名拒绝和只读检查通过；聚焦的跟踪结果确认重复的工作区查找已移除。

## Risks

迁移不完整可能使 Windows 授权标识不一致。不得缓存额外根目录：执行权限限制时必须重新检查被符号链接替换的目录。
