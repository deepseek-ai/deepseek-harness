# Agent Note: 在包编译前生成元数据

Status: implemented

[English](2026-10-18-source-first-metadata-builds.md) | 中文

## Problem

Host 包可以消费生成的 Remote 声明，而不必成为 Client 包。如果在 Host 打包期间生成元数据，构建就必须识别这些消费方、延迟其编译，并把延迟传播给调用方。TypeScript project reference 已经描述包依赖；再维护一张源码导入图会重复处理顺序。

## Decision

产物构建与仅生成声明的构建都在包编译之前运行仅源码的 Typert 生成。现有生成器拒绝工作区构建产物与无法解析的工作区导入，因此元数据生产者不能经由另一个源码包依赖自身生成的声明。TypeScript 保留 compiler face 的归属，并拒绝 project reference 环。生成失败后不启动依赖它的编译与打包。

根打包器使用 `decoratorPlugin()` 转换标准 TypeScript 装饰器，不重复生成元数据。公开的 `typertPlugin()` 保留 package/workspace 生成与 Worker Thread 行为。[开发指南](../../../../docs/development.zh.md#typescript-project-layout)负责当前命令顺序。

该顺序只替代[本地门禁提速](2026-10-12-local-gate-speedups.zh.md)、[无损构建提速](2026-10-11-lossless-build-speedups.zh.md)、[构建／检查拆分](2026-10-11-build-artifacts-check-split.zh.md)与 [Remote 方法生成](../architecture/2026-08-02-typert-remote-method-calls.zh.md)中的生成位置。它们的其他优化、失败保证、公开插件行为与历史测量仍有价值，因此保留为活跃记录。

## Measurements

本地实验使用 macOS ARM64、Node 24.19.0 与 TypeScript 6.0.3。`DSH_GATE_CONCURRENCY=1 pnpm run build:artifacts --profile official` 按基线／候选／候选／基线顺序运行。每轮先执行 `pnpm run clean`，再在源码不变的情况下重跑。安装与清理不计时；native 准备、包编译、bundle、Desktop、Web 与构建记录发布计入时间。暂停本任务的其他重负载工作；主机上仍可能有无关负载。不清空文件系统缓存。

| 输入 | 干净构建基线／候选 (s) | 无改动构建基线／候选 (s) | 干净构建 RSS 峰值基线／候选 (MiB) |
|---|---|---|---|
| 不含 Node Session 消费方 | 56.67, 53.55 / 56.29, 56.37 | 13.64, 13.74 / 15.32, 15.26 | 3855, 3858 / 3255, 3268 |
| 独立原型：Node Session 消费方与后置阶段删除 | 61.18, 61.41 / 56.27, 56.44 | 20.08, 20.09 / 15.98, 16.09 | 4013, 4012 / 3278, 3291 |

RSS 约每 100ms 汇总所有子孙进程；共享页面会重复计数，因此不代表唯一物理内存。每种情况的两个样本是本地证据，不是 CI 预算。两组比较中的全部 150 个 Typert/Remote 生成文件逐字节相同。完整清单分别包含 12,246 与 12,352 个文件；只有装饰器插件模块的四个编译产物不同。

## Alternatives considered

**保留 Host 打包内的生成。** 它保留重叠执行与更快的独立无改动构建，但生成声明的消费方需要单独的后置编译调度。

**手工维护后置包，或改变它们的 compiler face。** 两者都让包归属受构建位置影响，并在 project reference 之外增加一份清单。

**仅在类型检查中采用先生成顺序。** 产物构建仍需要消费方扫描器，留下两套需要维护的调度。

**删除公开生成插件。** 它的 package/workspace API 与 Worker Thread 失败归属仍受支持；仓库调度改变不能成为删除该 API 的理由。

## Consequences

消费方一行是独立集成原型的测量证据，不表示本前置改动交付的包或验证。

独立前置改动使无改动产物构建的中位数增加 1.60s（+11.7%），因为生成不再与打包重叠。干净构建增加 1.22s，小于基线的样本波动。该改动提供顺序支持，并非独立提速。删除后置阶段后，测得的消费方构建在干净状态下快 4.94s，无改动时快 4.05s。两组的进程树 RSS 峰值都下降。

源码生成测试在产物缺失和已存在时均拒绝元数据依赖环。干净的 Host 消费方 fixture 使用同一次构建生成的元数据完成编译。装饰器测试覆盖两个插件入口，完整构建验证应用产物。Wine 的独立命令序列显式准备元数据；源码守卫拒绝缺失的准备步骤，原生 Windows 执行仍由 CI 负责。
