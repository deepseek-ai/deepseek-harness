# Agent Note: 通过发现机制获取包清单，而非维护静态列表

Status: proposed

[English](2026-06-20-discover-package-inventory.md) | 中文

## 问题

包与门禁清单在 TypeScript project references、包文档和 CI 描述中反复出现。大多数只是重述包布局、manifest（元数据清单）数据或聚合命令内容。因此每新增一个包都会产生本可避免的同步点。

[包层级结构](../../archived/architecture/2026-06-20-package-hierarchy.md)已经手动消除了其中若干：`scripts/publint-all.ts` 现在从 `packages/<group>/<pkg>` 布局推导列表，两份 `tsconfig` 的 `paths` 映射也合并为一个 `@deepseek-ai/dsh-*` 通配符——该合并此后已被回退为「每包一条、由生成器托管并有门禁把关」的显式别名，因为按顺序试候选的解析开销主导了源码启动时间（[显式 workspace 路径别名](../../archived/process/2026-08-27-explicit-workspace-path-aliases.md)）。剩下的是无法用 glob 消除的清单，主要是聚合配置（`tsconfig.host.json`、`tsconfig.client.json`）中的项目引用（`references`）——TypeScript 要求它们是显式数组（没有通配符形式）。

当静态列表编码的是策略时，它们是合理的；当它们只是重复 `package.json`、workspace glob 或包层级结构中已有的 manifest 数据或布局事实时，就是不必要的摩擦。

## 提案

让剩余的包与门禁清单可被发现。唯一真源，即 `packages/<group>/<pkg>` 层级结构加上包 manifest，应当驱动聚合配置的 `references`、模块图以及任何全量包列表，并配合一个生成加校验步骤（沿用现有的 `gen-module-graph` / `gen-cordis-catalog` 模式：生成器写出产物，`--check` 模式在 `hygiene` / `doc-sync`（文档同步门禁）中发现已提交副本陈旧时失败）。模块图生成已经在读取包 manifest。`doc-sync` 应当成为定义并打印其子门禁的唯一命令，文档链接到该命令，而非重述第二份列表。

层级结构不需要编码关于包的所有事实，但应当编码宽泛的维护策略：core/product 包、集成包、能力 seam 包与 support/test/example 包不应在脚本能区分它们之前先要求一份手工维护的例外列表。

## 验收标准

- 聚合配置的项目引用（`references`）由层级结构生成（生成器输出它们；`--check` 门禁在提交副本陈旧时报错），而非手工维护。
- 新增一个包时，不需要为任何门禁编辑静态包列表。
- 文档描述真源，而非重复生成的清单。
- CI 调用聚合命令，由这些命令自行管理其子门禁列表。

## 风险

发现脚本可能变得过于精巧。实现应当保持朴素：读取 manifest、按显式字段过滤、打印解析后的列表，并在出错时明确失败。收益在于消除手工清单的漂移，而非发明一套构建系统。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
