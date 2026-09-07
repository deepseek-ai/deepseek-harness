# Agent Note: 将 Node 编译缓存重定向到数据卷 runner 临时目录

Status: implemented

[English](2026-08-28-ci-node-compile-cache-data-disk.md) | 中文

## 问题

自托管 Linux CI 虚拟机（`vm-backup` 池，32 个 runner 实例共宿一机）的根分区 inode 正在耗尽。issue #3134 的残留（`/tmp/dsh-*`）是来源之一；第二个、更大的来源是 Node.js 模块编译缓存。CI 工具链中的工具显式调用 `module.enableCompileCache()`：pnpm 11.7.0 在入口（`bin/pnpm.mjs` 中的 `module.enableCompileCache?.()`）每次调用都启用缓存，TypeScript 在 `tsc`/`tsserver` 中启用；vitest 转发该 API 但自身不启用。每次这样的调用都把序列化 V8 字节码缓存写到 `os.tmpdir()/node-compile-cache`。在共享虚拟机上即根分区的 `/tmp`：2026-08-28 实测为 **697,389 个 inode、9.2 GB**，其中 34,110 个文件不足 1 小时——缓存每次 CI 运行都在增长且从不清理，即使 `dsh-*` 残留被控制，根分区 3,276,800 个 inode 仍趋向耗尽。

## 决策

每个可能运行在 `vm-backup` 池的 Linux lane（`ci.yml` static/coverage/snapshots——默认 hosted，仅 `DSH_CI_FAILOVER_LINUX=selfhosted` 时自托管；`ci-master.yml` serial standby——始终自托管）都把 `NODE_COMPILE_CACHE` 重定向到 per-runner 数据卷临时目录 `${{ runner.temp }}/node-compile-cache`。`runner.temp` 在 `/data_local`（1 TB，inode 用量约 1%）上，per-runner（`_workNN/_temp`），因此缓存不再消耗根分区 inode。

重定向是在 `actions/checkout` 之后的一个 step，把 `NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache` 写入 `$GITHUB_ENV`，因此 lane 中后续每个 step——`pnpm/action-setup`、store 路径探测、安装、Playwright 安装和测试门禁——都会继承该变量。必须用注入而非 job 级 env：`runner` 上下文在 job 级 `env` 不可用（与早前 TMPDIR 工作相同的约束）；而仅给门禁 step 设 step 级 env 会让更早的 pnpm 调用继续写根分区 `/tmp`。sandbox（bwrap/Landlock）未授权 `runner.temp` 路径的受限子进程会继承该变量但**静默跳过缓存**——已在虚拟机上验证：`NODE_COMPILE_CACHE` 指向 bwrap 内未授权路径时，`node` 正常运行（exit 0），与 `mkdtemp` 的只读文件系统硬失败不同。编译缓存按设计是尽力而为；写失败只是缓存未命中，不是崩溃。

## 验证

- VM 探针：`NODE_COMPILE_CACHE=/data_local/ci/compile-cache-probe node -e 'require("node:fs")'` 在数据盘写出了 `v22.23.2-x64-*` 缓存子目录（位置切换生效）。
- VM 探针（bwrap）：`NODE_COMPILE_CACHE` 指向 bwrap profile 未授权的路径时，`node` 正常运行（exit 0）——缓存写失败被容忍。
- `scripts/ci-workflow.spec.ts` 断言每个 Linux lane 都在 `pnpm/action-setup` 之前把 `NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache`（`$GITHUB_ENV` 的 `KEY=VALUE` 行）注入 `$GITHUB_ENV`；位置断言在注入移出首次 pnpm 调用之后时会失败。
- CI lane：三个必需的 Linux job（默认 hosted，`DSH_CI_FAILOVER_LINUX` 时自托管 `vm-backup`）会在新 env 下跑完整套件；缓存处理回归会表现为 lane 失败。

## 备选方案

### 为什么不彻底禁用编译缓存？

`NODE_DISABLE_COMPILE_CACHE=1` 会立即停止根分区增长，但会放弃每次运行的启动加速，而缓存是 Node 正当有用的特性（由 pnpm 和 TypeScript 显式启用）。重定向在保留收益的同时把成本移出受限分区。

### 为什么不把 `node-compile-cache` 纳入 `dsh-*` 清理？

CI 清理（残留清理改动中新增）针对测试残留；编译缓存是缓存而非残留。每次运行删掉它会丢弃缓存本要提供的加速。重定向是结构性修复：缓存的增长移到为它准备的卷上。

### 为什么不用 job 级 env 或只给门禁 step 设 env？

`runner` 上下文只在 step 级 `env` 可用；job 级 `env` 会求值为空字符串（GitHub contexts-availability），静默让缓存留在根分区。只给门禁 step 设 step 级 env 也只覆盖那一个 step：lane 中更早的每次 pnpm 调用（setup、store 路径探测、安装）仍会写根分区 `/tmp`。在 checkout 与 `pnpm/action-setup` 之间的 step 注入 `$GITHUB_ENV`，使变量在 lane 首次 pnpm 调用之前生效，一个 step 即可覆盖整条 lane。

## 后果

- **买到**：Node 编译缓存不再消耗根分区 inode；该来源的 inode 压力被移除且不损失缓存的启动收益。缓存现在位于数据卷上的 per-runner `_workNN/_temp`。
- **代价**：缓存在 `runner.temp` 累积，而 runner 不会在 job 之间清空它（早前实测）——但在数据卷（inode 用量约 1%）上无碍。
- **代价**：没有 `runner.temp` 授权的受限子进程会为其自身的 `node` 调用跳过缓存；这是缓存未命中而非失败，符合 Node 的尽力而为契约。
- **代价**：改动只涉及 CI 配置；本地开发保持默认 `os.tmpdir()` 位置。
