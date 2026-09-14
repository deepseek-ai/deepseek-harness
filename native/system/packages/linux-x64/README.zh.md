---
description: "为 Linux x64 提供预编译 Landlock 启动器和 POSIX flock addon。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system-linux-x64

[English](README.md) | 中文

此平台包包含静态 musl 可执行文件 `bin/landlock-run`，以及 Node-API v8 addon `bin/glibc/system.node` 和 `bin/musl/system.node`。入口按运行 Node 进程的 libc 选择 addon；Landlock 可执行文件在两种 libc 系统上共用。

包中没有 JavaScript 或安装编译脚本。平台 prepack 检查完整产物、ELF 架构、Node-API 导出和启动器可执行权限；已安装产物演练核对字节并执行原生行为。参见工作区[支持矩阵](../../docs/support-matrix.md)。
