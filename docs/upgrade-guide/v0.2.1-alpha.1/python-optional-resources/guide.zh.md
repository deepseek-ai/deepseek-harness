---
kind: upgrade-guide
description: "Python 运行时 wheel 的 Office 转换与内置创作环境需要显式下载。"
---

# 显式下载可选 Python 运行时资源

[English](guide.md) | 中文

## 变更

Python 运行时 wheel 不包含 Office sidecar、创作解释器和库。SDK 启动不会下载这些资源。Office 操作需要显式下载；创作环境和转换引擎可以独立选择。SDK 仍打包常规 `dsh` CLI，无需系统 Node.js。

## 迁移

1. 处理 Office 文件前调用 `deepseek_harness_runtime.download_office()`。使用内置创作环境前调用 `deepseek_harness_runtime.download_primary_runtime()`。两者复用完整缓存并返回绝对路径。
2. 离线部署时，在目标平台使用匹配的运行时发布版本准备缓存，并将其复制到该平台的部署环境。下载和启动 SDK 前，将 `DSH_RESOURCE_CACHE` 设为缓存的绝对根目录。详见[运行时参考](../../../../python/sdk-runtime/README.zh.md)。
3. 启动 SDK 并确认所需资源可用。`deepseek_harness_runtime.resolve_office_launch_args()` 检查 Office CLI 路径，不执行下载。既有 `DSH_PRIMARY_RUNTIME` 路径仍受支持；空值禁用创作环境查询。Profile patch 可独立禁用 `skill-office`。
