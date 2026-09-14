# Agent Note: 预编译系统原语

Status: implemented

[English](2026-09-07-prebuilt-system-primitives.md) | 中文

## Problem

JSONL 写入方依赖的 `fs-ext` 在用户安装时编译 NAN addon。因此，原生编译器是否可用以及 Node 模块 ABI 的变化会影响普通安装，包括 Node 26。仓库已经维护了 Landlock 启动器及其按平台发布的工作流。

## Decision

[native/system](../../../../native/system/README.zh.md) 中独立版本的 `@deepseek-ai/node-addon-system` 包族分发既有 `landlock-run` 可执行文件和使用稳定 Node-API v8 的 `system.node` addon。平台包按操作系统和 CPU 选择；Linux 分别携带 glibc 与 musl addon 文件。macOS 携带 addon，但不包含 Landlock 可执行文件。入口包和平台包都不在安装期间编译。

包不提供根导出。`./landlock-run` JavaScript 入口保留 Landlock API 和 [CLI 协议](../../../../native/system/docs/cli-contract.md)。`./flock` 入口仅在调用 `tryLockExclusive(fd)` 时加载 addon。它在异步原生工作中执行 `flock(fd, LOCK_EX | LOCK_NB)`，并在该工作线程保存 errno。调用方在完成前持有描述符，并通过关闭它释放锁。绑定缺失时拒绝获取锁，不授予没有保护的锁。

[Session 写租约决策](../feature/2026-08-31-cross-process-session-write-lease.zh.md) 继续负责获取时机、inode 校验、关闭所有权和崩溃语义。Windows 保留既有 koffi 信号量。浏览器 worker 仅替换 flock 子路径，使用未经修改的 `./landlock-run` JavaScript API。

源码构建在需要 addon 的仓库测试与构建之前显式编译当前宿主 addon。Native CI 构建完整平台产物，并让相同 addon 字节跨 Node 版本测试；Linux 还在 Alpine 中执行 musl 产物。平台 prepack 拒绝格式错误或不完整的二进制，离线 npm 安装演练检查安装字节与真实锁行为。Native [测试](../../../../native/system/test/flock.test.js) 覆盖描述符与进程竞争、关闭和崩溃释放、独立 errno 值及 worker 清理。

## Alternatives considered

**保留 NAN，为每个 Node ABI 发布构建。** 这会为仅需稳定 Node-API 操作的绑定保留 Node 主版本构建矩阵。已评估的 `fs-ext-extra-prebuilt@2.2.14` 在 Node 26 ABI147 下选中 Node 25 ABI141 二进制；默认安装回退还会在 NAN 被提升安装时提前退出而不编译。

**将 fs-ext 打入父包 tarball。** npm 默认仍执行 bundled 依赖的安装钩子。仅打包既不能禁止编译，也不能让一个二进制跨操作系统、CPU、libc 实现或 Node ABI 通用。

**将 flock 换成 OFD/fcntl 锁。** 在普通 Linux 文件系统上，这些锁不一定排斥既有 flock 持有者。tmpfs 探针在 fs-ext 持有 flock 时仍取得 OFD 锁，因此这不是保持行为的替换。

**通过 koffi 执行 POSIX 调用。** 同步调用改变事件循环的阻塞行为；在异步回调后读取 errno 会读到错误线程的值。原生 async-work 适配器把系统调用结果和 errno 保存在一起，无须另加 FFI 协调层。

## Consequences

包族维护小型 C 绑定、平台构建和安装产物验证，而不是整套文件系统扩展 API。Node-API 消除按 Node 主版本分发二进制的要求，但不消除操作系统、CPU 和 libc 要求。统一原生发布包含两项能力，但导入或使用其中一项不会加载另一项。Landlock 二进制语义、Windows 锁和已发布 Session 数据格式保持不变。
