---
description: "为 macOS x64 POSIX 锁提供预编译 system.node。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system-darwin-x64

[English](README.md) | 中文

此平台包提供 `bin/system.node`，这是一个供 `@deepseek-ai/node-addon-system/flock` 使用的稳定 Node-API v8 addon。它不包含 Landlock 可执行文件、JavaScript 加载器或安装构建脚本。Native 工作流在 macOS x64 上构建它，并负责验证安装后的产物。
