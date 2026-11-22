---
kind: upgrade-guide
description: "DSH 要求 24.x 系列中的 Node.js 24.22.3 或更高版本，或 Node.js 26.13.1 或更高版本，不再支持更早的 Node.js 24 与 26 版本。"
---
# 必须使用 Node.js 24.22.3 或 26.13.1

[English](guide.md) | 中文

## 变更

DSH 要求 Node.js 24.22.3 或更高的 24.x 版本，或 Node.js 26.13.1 或更高版本（`engines.node` 为 `^24.22.3 || >=26.13.1`）。这些是内置 undici 首次包含 2026 年 11 月安全修复的版本。上一版本支持 Node.js 24.9 及更高版本，包括所有 Node.js 26 版本。此变更影响 npm 安装、源码检出，以及 Python SDK 显式指定 `DSH_RUNTIME_MODE=node` 的开发载体。打包的桌面应用和 Python SDK 的内置可执行文件自带 Node.js 24.22.3 运行时。

## 迁移

1. 将用于启动 DSH 的 Node.js 安装升级至 24.22.3 或更高的 24.x 版本，或 26.13.1 或更高版本。更新开发环境、容器和 CI 任务中固定的 Node 版本。
2. 在同一环境中运行 `node --version`，确认版本为 24.22.3 或更高的 24.x 版本，或 26.13.1 或更高版本。
3. 对于源码检出，运行 `pnpm install`。使用平常的 profile 启动 DSH，确认它能成功启动。
