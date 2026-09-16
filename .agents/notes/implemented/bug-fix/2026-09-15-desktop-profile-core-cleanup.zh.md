# Agent Note: 在 Desktop 生产启动前清理应用管理的包

Status: implemented

[English](2026-09-15-desktop-profile-core-cleanup.md) | 中文

## Problem

旧 Desktop profile 包含已安装的核心包及本地 tarball 依赖声明。即使应用携带一致的发布产物，本地包优先规则仍可能把旧 Web 前端与新插件组合起来。用户切换到已安装应用时，开发模式的回退链接也会残留。

## Decision

生产版 Desktop 在启动 Host 前，持有现有 profile 锁，清理已验证运行时描述符或旧 Desktop 包清单记录列出的包副本。清理删除对应依赖声明和 pnpm overrides，在包状态变化时使锁文件失效，并解除回退链接而不删除其目标。其他插件、bundle 选择、配置和会话数据保留。开发模式跳过清理。

实现与临时启用常量集中在 `apps/desktop/src/profile-core-cleanup.ts`，由 profile 准备流程中的一个调用接入。每次生产启动都执行清理，因为开发模式或包操作可能重新产生残留。这限定了[原地修改 profile 决策](../architecture/2026-09-09-desktop-in-place-profile.zh.md)中的包保留范围；直接写入和失败恢复保持不变。

## Alternatives considered

**仅在安装器中清理**会遗漏其他用户的 profile 和安装后重新产生的包；两个平台都在启动时清理。

**删除组织名前缀下的所有包**可能误删可选官方插件。明确的当前及历史包清单决定归属。

**仅删除包目录**会让 pnpm 根据保留的声明和 overrides 重新安装相同旧包。

## Consequences

生产版不再使用 profile 对应用管理包的本地覆盖。发生变化的 profile 丢弃锁文件，下次 pnpm 操作会重新解析其余插件依赖。清理不运行 pnpm，也不创建回滚状态；失败会停止准备流程，之后可以重试。重定向的包父目录会在删除前报错。定向测试覆盖插件保留、声明、重复清理、开发模式排除、退役包、无效记录及链接目标。
