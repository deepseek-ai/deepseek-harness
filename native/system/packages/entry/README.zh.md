---
description: "预编译 Landlock 启动器与异步 POSIX flock 的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`；导入任一入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

可选操作系统/CPU 平台包携带二进制。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。flock 绑定缺失或无法加载时，锁获取请求会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

两个 C 源文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
