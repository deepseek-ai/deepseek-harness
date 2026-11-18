---
kind: upgrade-guide
description: "DSH 要求 Node.js 24.9 或更高版本，不再支持 Node.js 22。"
---
# 必须使用 Node.js 24

[English](guide.md) | 中文

## 变更

DSH 要求 Node.js 24.9 或更高版本。上一版本还支持 Node.js 22.19 及 22.x 系列中的后续版本。此变更影响 npm 安装、源码检出，以及 Python SDK 显式指定 `DSH_RUNTIME_MODE=node` 的开发载体。打包的桌面应用和 Python SDK 的内置可执行文件自带运行时。

## 迁移

1. 将用于启动 DSH 的 Node.js 安装升级至 24.9 或更高版本。更新开发环境、容器和 CI 任务中固定的 Node 版本。
2. 在同一环境中运行 `node --version`，确认版本为 24.9 或更高版本。
3. 对于源码检出，运行 `pnpm install`。使用平常的 profile 启动 DSH，确认它能成功启动。
