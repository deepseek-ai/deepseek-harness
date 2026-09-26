# Agent Note: dsh 通过 tsx ESM 钩子源码启动

Status: implemented

[English](2026-07-29-dsh-source-launch-tsx-esm.md) | 中文

> 取代[原生 TypeScript 源码启动](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md)：Node 移除了该决策所依赖的能力。

## 问题

[已归档的原生源码启动决策](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md)让 `apps/cli/src/bin.ts` 在 `node --experimental-transform-types` 下运行，配合一个只做解析的 paths loader，由 Node 负责 TypeScript 转换。Node 26.0.0 移除了 `--experimental-transform-types`（进程以 `bad option` 拒绝该 flag），只保留 strip 模式，而 strip 模式无法接受这个源码图必需的语法：vendor Cordis 中的参数属性（`constructor(private ctx: Context)`）、`vendor/hmr` 中的 `@Inject` 装饰器，以及遍布 `vendor/` 与 `packages/workflow` 的运行时 enum/namespace。仓库的 engines 范围（`^22.19.0 || >=24.0.0`）包含 Node 26，因此原生启动链在其上完全无法启动——且没有任何 CI 任务执行过真实启动向量，这一不兼容悄然发布。

启动延迟同样是问题：off-thread 的 `module.register()` 钩子工作线程把每次解析都跨线程序列化（TUI 启动期间约 440ms 的 `makeSyncRequest` 等待），而完整的 tsx 默认形态（`--import tsx`）会因其 CJS 钩子放大解析开销而多花约 0.4s。

## 决策

`dsh` CLI（命令行界面）源码启动运行 `node --import tsx/esm`：由 tsx 的 ESM-only 钩子同时负责 TypeScript 转换与 tsconfig `paths` 投影。根目录的 `dsh` 脚本直接从仓库根目录使用同一启动方式；产物生成是独立操作，由[源码启动与构建分离决策](../../archived/simplification/2026-08-12-separate-source-launch-from-build.md)规定。CJS 钩子保持关闭，因为 CLI 源码图是纯 ESM；实现时测得启动至 TUI banner 耗时约 0.7s，对比完整 tsx 默认形态约 1.1s、已移除的原生链约 0.75s。

tsx 负责 workspace `paths` 映射，不检查导入方是否把每个包声明为运行时依赖。声明完整性由静态门禁保障：配置的裸插件走 `verify-cordis-config`，manifest（元数据清单）走 workspace constraints。已移除的仓库自有 paths loader 曾在运行时强制这些声明，并发现过将 `@deepseek-ai/dsh-llm` 仅声明在 devDependencies 中的 import；tsx 不提供这项检查。

导入方 URL 含有 `/node_modules/` 时，tsx 会跳过 paths 映射。因此，[runtime resolution](2026-09-09-profile-resolution-generations.zh.md)记录声明包的真实锚点，也覆盖递归依赖。这让 workspace fallback import 一致解析到 `src/`，避免混用构建后的 `lib/` 提供方与模块本地 Symbol 不同的源码调用方。没有 workspace 映射的包仍使用普通导出解析。

node-compat CI 矩阵在不执行 build 的情况下运行 `dsh-source-launch-smoke`（`apps/cli/tests/source-launch.compat.spec.ts`）：无密钥启动断言必需 profile 的诊断，以及不混用 Tools/AgentLoop `src/` 与 `lib/` 实例的 profile 依赖解析。源码与构建入口测试共享普通目录和 npm-link profile 用例；后者通过普通 Node 加载构建后的导出。必跑的 build-backed smoke 还运行 `apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts`：在 native addon 和生成的 typert 贡献文件就绪后，通过 tsx 检查真实 headless 工具派发，同时仍要求核心 workspace 模块从源码加载。模块钩子或 TypeScript 处理的后续变化由这些真实入口检查。

## 备选方案

**在 Node ≤25 保留原生链并按版本分叉。** 拒绝：两套转换语义（amaro 与 esbuild）在边缘语法上会分歧，启动器要加版本探测，node-compat 矩阵要覆盖两条路径——为一个已经变动过的 experimental flag 付出沉重维护。而且 amaro 也不支持 `vendor/hmr` 使用的 `@Inject` 装饰器，原生路径本来就无法启动随附的默认 TUI 配置。

**把源码图改成 erasable-only 以适配 Node 26 strip 模式。** 拒绝：参数属性与值 namespace 遍布 vendor 的 Cordis/cosmokit/loader/schemastery；改写是无界 churn，且每次 vendor sync 都要重做。

**仓库自有的同线程 loader（`module.registerHooks()` 加 esbuild 或 `@swc/core` 转换）。**不予采纳：原型实测约 0.45s，而 esbuild 路径缺少端到端验证，SWC 在两种装饰器模式下都会因 `vendor/hmr` 的装饰器与 namespace 合并失败。该方案还会让仓库负责转换正确性和 tsx 已经提供的解析钩子。仅当实测约 0.3s 的差距成为实质成本时再重新考虑。

**Node 26 运行构建产物 `lib/`，24 保留原生。** 拒绝：在最新 Node 版本线上失去零构建开发循环，且混淆源码面与产物面。

## 结果

- 整个 engines 范围（包括未来改变原生 TypeScript 支持的 Node 版本线）只有一个启动向量；冒烟门禁按矩阵行强制执行。
- TypeScript 转换重新委托给 tsx/esbuild，逆转了前一篇 Agent Note「证明 Node 原生转换可用」的目标；在 vendor 源码使用不可擦除语法且 Node 不再提供 transform 模式的情况下，该目标不可达。
- 源码启动中的运行时依赖声明强制不复存在；未声明的 workspace import 现在只能通过静态门禁或构建模式的解析失败暴露。
- 每个 CLI 源码 profile 都使用相同的 ESM-only 钩子，包括 ACP（Agent Client Protocol）。该启动方式访问的 workspace 运行时入口必须提供 ESM 导出；启动器不安装 CJS TypeScript 转换钩子。
