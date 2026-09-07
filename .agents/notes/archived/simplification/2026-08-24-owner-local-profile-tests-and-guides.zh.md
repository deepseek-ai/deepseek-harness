# Agent Note: 归属方本地的 Profile 测试与可运行指南

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-owner-local-profile-tests-and-guides.md) | 中文

## 问题

顶层 `examples/` 树混合了四种互不相同的角色：重复的应用组合、跨包 profile 测试、包专属 Loader fixture，以及可运行的用户指南。它的 umbrella workspace manifest 主要用于让任意嵌套 Cordis 文件解析包，因此测试与文档位置决定了依赖解析，也让不受支持的 demo launcher 看起来像产品接口。

## 决策

仓库不存在顶层 `examples/` 树。具名 `dsh` profile 是唯一的 Node 应用组合。跨包 ACP、headless 与 SDK profile 测试位于 `apps/cli/tests/profiles/`；包专属 Loader 配置与 driver 位于该包的 `tests/fixtures/`。录制会话测试继续位于顶层 `snapshots/`，非会话预期输出继续归属方本地保存。

可选用户 overlay 作为交付资产位于 `apps/cli/config/examples/`，其中的裸插件名通过 CLI 应用 manifest 解析。GitHub 评审、Schedule、记忆 MCP 与运行时 Cordis 指南位于 `docs/user/` 并链接这些资产。可运行的 Python SDK 程序与极简 overlay 位于 `python/sdk/examples/`。

仓库不存在 `demo:acp` 与 `demo:cordis` 脚本。ACP 通过 `dsh --profile acp` 启动；Cordis 指南使用显式 overlay 启动 `dsh web`。`demo:ptc` 继续作为薄 wrapper，以 `DSH_TOOLS_MODE=ptc` 运行 `dsh --profile headless`。

## 考虑过的替代方案

**只为模块解析保留 examples workspace。** 已否决：包含无关测试与指南依赖并集的 resolver manifest 会隐藏所有权，并让任意 leaf 表现得像应用包。

**把所有文件都移到 CLI 应用下。** 已否决：包专属测试组合随对应包演进，用户说明属于发布指南层级，Python 示例属于 SDK。

**保留兼容 demo 命令。** 已否决：具名 profile 与显式 overlay 已经提供受支持的启动方式；兼容 wrapper 会保留第二套应用词汇。

## 后果

路径本身即可表达所有权，无需查阅裁决表。CLI profile 测试从单一应用 manifest 解析；包测试携带自己的 fixture；交付的可选 overlay 随 CLI 包安装；用户指南进入网站导航；Python 示例位于 SDK 旁。删除指南或测试不再改变全局依赖 umbrella。
