---
kind: upgrade-guide
description: "自动生成的 worktree 名称将 worktree- 前缀和完整 UUID 后缀改为 dsh- 前缀与基于 Session 的名称。"
---

# 更新依赖自动生成 worktree 名称的使用方

[English](guide.md) | 中文

## 变更

在 v0.2.1-rc.3 中，调用 `create_worktree` 或 `ctx.worktrees.create` 时省略 `name`，默认生成 `worktree-<UUID>`。下一版本默认生成 `dsh-<Session id 中 UUID 的前八位十六进制数>-<四位随机十六进制数>`，例如 `dsh-6b1f02c4-9a3e`。Session id 不含 UUID 时，生成 `dsh-<八位随机十六进制数>`。

依赖 `worktree-` 前缀或完整 UUID 后缀的脚本和忽略规则需要更新。显式名称、配置的检出父目录以及已有的检出目录和分支保持不变。`namePrefix` 配置项仍然可用，但只控制前缀，不控制后缀格式。

## 迁移

1. 更新识别自动生成名称的脚本和忽略规则。优先使用返回的 `path` 与 `branch` 字段，不要按旧模式重新拼接；[worktree 服务参考](../../../../packages/experimental/worktree/README.zh.md#use-this-package)说明了这些字段。
2. 如需保留旧前缀，在现有的 `@deepseek-ai/dsh-experimental-worktree` 配置行中将 `config.namePrefix` 设为 `worktree-`。这不会恢复完整 UUID 后缀；集成要求特定完整名称时，请显式传入 `name`。
3. 创建一个省略 `name` 的 worktree，检查返回的 `branch` 与 `path`，确认更新后的自动化能识别它。已有 worktree 无需改名或迁移数据。
