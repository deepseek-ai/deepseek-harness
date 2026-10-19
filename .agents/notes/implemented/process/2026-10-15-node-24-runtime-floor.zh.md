# Agent Note: Node 运行时下限与兼容性覆盖

Status: implemented

[English](2026-10-15-node-24-runtime-floor.md) | 中文

## 问题

根 `engines.node` 范围承诺安装后的工作区支持其允许的每一个运行时。其下限必须覆盖 DSH 使用的运行时 API 和所安装依赖声明的要求。否则，严格安装可能会在 DSH 启动前拒绝一个受支持的版本。

## 决策

将 `engines.node` 设为 `>=24.9.0`。Node 24.9 是 DSH 及其开发载体的下限，也允许实验性 OAR 子代理集成使用要求 Node 24 的 `@botiverse/oar` 库。此决策取代 [Node 22.19 下限](../../archived/process/2026-07-06-node-engine-floor.md)；Node 23 仍被排除，下文的声明策略也仍比运行时下限更窄。迁移说明见[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.zh.md)。

主要的 Node 24 任务负责完整的类型检查和单元测试覆盖率。聚焦的兼容性任务在固定的 Node 24.9 和 Node 26 上运行。Node 24.9 支持现有 `import.meta.main` 脚本入口和原生 TypeScript 类型剥离。固定 24.9 能验证这个已验证的下限及其 v1 私有模块加载器；主要任务跟随最新的 Node 24，验证 24.12.0 引入的 v2 加载器。浮动的 `24` 兼容性任务会重复主要任务的加载器覆盖，并停止验证下限。

Node 24.9 兼容性任务还构建产物，并检查随产品提供的 Web CLI 能在禁用全文 Session 搜索时启动和释放资源。command-entrypoint、source-worker、Zstandard、source-launch、profile-resolution 和 jsdom-storage 检查在两个兼容性版本上运行。真实 API 的 e2e 任务保留在 Node 24 上，因为它们验证的是提供方集成。

根项目、Web 和桌面项目将 `@types/node` 保留在 22.x 线。它们当前的代码不需要 Node 24 专属声明。较窄的类型 API 仍适用于受支持的运行时，也避免无关的声明变更。当受支持的 API 需要时再提升这些声明，并确保其主版本不高于运行时下限。独立发布的原生 addon 有自己的运行时和类型支持策略。

## 后果

- 使用 Node 22 的安装必须先升级，才能运行 DSH。内嵌运行时的打包应用不要求升级系统 Node。
- 受支持的运行时无需启用标志即可使用 `node:sqlite` 和原生 TypeScript 类型剥离。源码 CLI 仍使用声明的 `tsx/esm` 启动器。
- 兼容性任务图保留受支持 Node 版本使用的两种私有加载器接口。
- 后续提升运行时下限时，必须一起更新 `engines.node`、兼容性任务、当前文档、本文和升级指南。

## 考虑过的替代方案

- **保留 Node 22 支持。** 这会将 OAR 库排除在受支持的安装之外。
- **采用 OAR 声明的 Node 24.0 下限。** 现有脚本入口依赖 `import.meta.main`，而 Node 24.0 缺少该功能。仅凭依赖下限无法确定应用下限。
- **只验证最新的 Node 24。** 这既不能验证下限，也不能验证受支持 24.x 系列仍使用的旧私有加载器接口。
- **将 Node 声明提升至下限之上。** 这会允许代码使用受支持运行时可能缺少的 API 编译通过。
