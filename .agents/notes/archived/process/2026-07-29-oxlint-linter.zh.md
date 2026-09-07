# Agent Note: 使用 Oxlint 作为仓库 linter

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-oxlint-linter.md) | 中文

## 问题

仓库的自有源码需要类型感知的 TypeScript 正确性规则、一致的格式，以及文件内重复逻辑检查。ESLint 通过 JavaScript 解析器、项目服务和多个插件提供这些检查，但在本地迁移基线上，一次无问题的 lint 运行约需 1 分钟，并且需要 8 GiB Node 堆、CI 结果缓存和单独调优的 ESLint 并发度。

不能以提高运行速度为由丢失规则。迁移必须保留严格类型检查预设、仓库覆盖配置、内联抑制指令、@stylistic 修复、SonarJS 检查、host/client TypeScript 隔离和 vendor 排除规则。

## 决策

根目录的 [`.oxlintrc.json`](../../../../.oxlintrc.json) 是仓库类型感知 lint 配置的权威来源。不加载项目的 [`.oxlintrc.staged.json`](../../../../.oxlintrc.staged.json) 配置继承其源码规则，为有界的 pre-commit 路径禁用类型分析，并重新纳入类型感知后端无法分析但需保留的 TypeGraph fixture（测试前置数据）。`lint` 与 `lint:fix` 包脚本、门禁调度器、CI 和 lefthook 通过 [`scripts/run-oxlint.ts`](../../../../scripts/run-oxlint.ts) 调用 Oxlint；[仅使用 Oxlint 的修复工作流](2026-08-09-oxlint-only-fix-workflow.zh.md)负责多轮插件修复，并取代单独的格式化回退路径。

`options.typeAware` 启用 `oxlint-tsgolint`。其后端按文件发现 TypeScript 项目：包源码使用各自的包项目，host 测试与网站源码使用 `tsconfig.host.json`，client 测试及 `scripts/client-bundle-purity.spec.ts` 使用 `tsconfig.client.json`。不含程序的根解决方案绝不会被扁平化。Oxlint 的 `--tsconfig` 覆盖项会影响导入解析，但类型感知 lint 会忽略它，因此本仓库不设置该选项。该配置显式载入迁移后的严格类型检查规则和仓库覆盖配置，而不启用内容可能发生变化的 Oxlint 宽泛类别。`typescript/no-unnecessary-condition` 仍从 Oxlint 的 nursery 规则集中启用，因为它在迁移前就是仓库强制执行的规则。

Oxlint 的 JavaScript 插件兼容层运行 `@stylistic/eslint-plugin` 和 `eslint-plugin-sonarjs`，从而继续强制执行现有的格式和文件内重复逻辑规则。兼容层会报告 `@stylistic` 违规并执行其安全修复；`max-len` 仍仅用于验证。自有源码中的抑制指令使用 `oxlint-*` 指令和 `typescript/*` 命名空间，未使用的指令仍作为警告报告；vendor 源码保留其上游指令，因为 Oxlint 会排除 `vendor/**`。

CI 不恢复或保存 lint 结果缓存。`DSH_OXLINT_THREADS` 使共享运行器将同一上限传给 Oxlint 的 `--threads` 选项和类型感知后端的 `GOMAXPROCS` 环境变量；普通本地运行对两者均采用默认值。Pre-commit 运行不加载项目的 Oxlint 验证，应用带一次有界重试的安全修复，接受仅含已忽略文件的文件选择，并通过 lefthook 重新暂存结果。公共 `lint` 和 CI 会先准备生成的声明，并保留完整的类型感知规则。

## 验证

解决两处分析器差异后，迁移后的配置报告与迁移前一致的自有源码无问题基线：移除了一项冗余测试断言，而 `tsc` 要求的一处结构性类型转换使用了窄范围的 Oxlint 抑制指令。以已删除 ESLint 配置的精确 blob 为基准进行的一次性审核在完成规则名映射后确认：源码为 88 项对 88 项，示例为 87 项对 87 项，测试为 83 项对 83 项。已提交的指纹锁定这些经审核的 Oxlint 规则配置及完整的覆盖结构；它既不执行已删除的配置，也不纳入后续的上游预设变更。对 `typescript-eslint@8.61.0` 的评估还确认，`strictTypeChecked` 并未启用 `@typescript-eslint/no-empty-function`；已删除、仅用于测试的 `off` 条目不起作用。

可执行约定测试要求包、host 和 client 项目产生类型感知诊断，断言 client 专用脚本所用的项目，拒绝未匹配的回退分析，并检验 Stylistic、SonarJS 和 nursery 兼容路径。它们还锁定暂存配置不加载项目的继承行为与 TypeGraph fixture 覆盖、未使用抑制指令的报告行为、仅选择已忽略暂存文件的情况、完整的 Stylistic 规则集，以及收敛后最终格式化的字节。运行器测试锁定两项工作线程控制，类型检查则确认迁移引发的源码改动没有破坏 TypeScript 程序。

## 考虑过的替代方案

**在全仓库范围内同时运行两个 linter。** 所有正确性规则均可通过 Oxlint 原生规则、nursery 规则或 JavaScript 插件兼容层获得。在全仓库范围启用 ESLint 回退会保留较慢的项目服务初始化和两套正确性配置，却不会增加任何检查。

**使用单独的格式化器。** 迁移保留了窄范围的 ESLint 流程，因为当时认为兼容层无法执行修复。锁定版本的工具链证明能够执行相同修复后，[仅使用 Oxlint 的修复工作流](2026-08-09-oxlint-only-fix-workflow.zh.md)以一次有界重试取代了该部分决策。

**移除尚无原生实现的 @stylistic 或 SonarJS 规则。** 这会移除依赖，但也会削弱机械质量约定。兼容层会保留这些规则，直到能够通过单独决策评估原生替代规则。

**迁移期间用 Oxfmt 替换 @stylistic。** 格式化器迁移会产生超出 lint 引擎边界的输出变化，并带来全仓库格式 diff。保留既有规则可使本次变更便于评审，并让格式化器选择保持独立。

## 结果

本地迁移测量显示，不使用结果缓存时，一次无问题的类型感知 lint 运行从约 61 秒缩短至约 8 秒。确切比例因主机而异，不构成性能保证。

类型感知诊断现在来自通过 `oxlint-tsgolint` 捆绑的 TypeScript Go 分析器，因此即使 `tsc` 接受同一程序，边界场景下的类型推断也可能与 typescript-eslint 不同。lint 与类型检查仍是两项相互独立的必要证据。

JavaScript 插件兼容 API 和暂存配置是需要维护的额外边界。每次提交把类型感知诊断留给公共 lint 和 CI，并避免依赖生成的声明。全仓库验证、修复、类型感知分析、缓存政策、工作线程控制和内联指令仍由 Oxlint 负责。
