# Agent Note: Node 运行时下限与兼容性覆盖

Status: implemented

[English](2026-10-15-node-24-runtime-floor.md) | 中文

## 问题

根 `engines.node` 范围承诺安装后的工作区支持其允许的每一个运行时。其下限必须覆盖 DSH 使用的运行时 API 和所安装依赖声明的要求。否则，严格安装可能会在 DSH 启动前拒绝一个受支持的版本。

## 决策

将 `engines.node` 设为 `^24.22.3 || >=26.13.1`。Node 24.22.3 是 DSH 及其开发载体在 Node 24 上的下限，也允许实验性 OAR 子代理集成使用要求 Node 24 的 `@botiverse/oar` 库。它是 Node 安全版本，也是 Electron 44.11.4 及之后版本内嵌的 Node 版本，因此源码、npm、桌面应用和 Python SDK 可执行文件安装都运行同一个最低 Node 版本。Node 24.22.3 内置 undici 7.30.2；Node 26.13.1 是第一个内置 undici（8.12.4）包含同一批安全修复的 Node 26 版本，因此该范围排除更早的 Node 26 版本。Python SDK 可执行文件在 `scripts/build-exe-for-python-sdk.ts` 中精确固定此版本，桌面主运行时在 `scripts/primary-runtime/lock.json` 中固定此版本。此决策取代 [Node 22.19 下限](../../archived/process/2026-07-06-node-engine-floor.md)；Node 23 仍被排除，下文的声明策略也仍比运行时下限更窄。迁移说明见 [Node 24.9 升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.zh.md)和 [Node 24.22.3 升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.1/node-24-22-3/guide.zh.md)。

主要的 Node 24 任务负责完整的类型检查和单元测试覆盖率。聚焦的兼容性任务在固定的 Node 24.22.3 和 Node 26 上运行。固定 24.22.3 能验证这个已验证的下限；主要任务跟随最新的 Node 24。浮动的 `24` 兼容性任务会重复主要任务的覆盖，并停止验证下限。所有受支持的 Node 24 版本都使用 24.12.0 引入的 v2 私有模块加载器；`app-boot` 和 `hmr` 中的 v1 加载器适配代码在受支持的运行时上已不可达。

Node 24.22.3 兼容性任务还构建产物，并检查随产品提供的 Web CLI 能在禁用全文 Session 搜索时启动和释放资源。它通过 `DSH_NODE_COMPAT_BUILD=1` 请求这些依赖构建的 gate，`run-gates` 会在其他 Node 版本上拒绝该请求。Node 版本本身不会触发它们：主要任务可能运行下限版本，并在读取已恢复构建产物的 gate 旁嵌套同一兼容性模式，此时重新构建会删除正在被测试的文件。command-entrypoint、source-worker、Zstandard、source-launch、profile-resolution 和 jsdom-storage 检查在两个兼容性版本上运行。真实 API 的 e2e 任务保留在 Node 24 上，因为它们验证的是提供方集成。

根项目、Web 和桌面项目将 `@types/node` 保留在 22.x 线。它们当前的代码不需要 Node 24 专属声明。较窄的类型 API 仍适用于受支持的运行时，也避免无关的声明变更。当受支持的 API 需要时再提升这些声明，并确保其主版本不高于运行时下限。独立发布的原生 addon 有自己的运行时和类型支持策略。

## 后果

- 使用 Node 22、24.22.3 之前的 Node 24 版本或 26.13.1 之前的 Node 26 版本的安装必须先升级，才能运行 DSH。内嵌运行时的打包应用不要求升级系统 Node。
- 受支持的运行时无需启用标志即可使用 `node:sqlite` 和原生 TypeScript 类型剥离。源码 CLI 仍使用声明的 `tsx/esm` 启动器。
- 兼容性任务图只验证 v2 私有加载器接口；不可达的 v1 适配代码可以删除。
- 后续提升运行时下限时，必须一起更新 `engines.node`、兼容性任务、当前文档、本文和升级指南。

## 考虑过的替代方案

- **保留 Node 22 支持。** 这会将 OAR 库排除在受支持的安装之外。
- **采用 OAR 声明的 Node 24.0 下限。** 现有脚本入口依赖 `import.meta.main`，而 Node 24.0 缺少该功能。仅凭依赖下限无法确定应用下限。
- **保留 Node 24.9 下限。** 这会允许早于桌面应用和 Python SDK 可执行文件内嵌运行时的 Node 版本，以及缺少 24.22.3 安全修复的版本。
- **保留 `>=24.22.3`。** 这会允许 26.13.1 之前的 Node 26 版本，其内置 undici 缺少 Node 24.22.3 中的安全修复。
- **只验证最新的 Node 24。** 这无法验证下限。
- **将 Node 声明提升至下限之上。** 这会允许代码使用受支持运行时可能缺少的 API 编译通过。
