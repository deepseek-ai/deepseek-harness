# Agent Note: 将 Cordis 以源码形式收录，而非作为 NPM 依赖

Status: implemented
Archived: 2026-09-04

[English](2026-06-11-vendor-cordis-as-source.md) | 中文

## 问题

DeepSeek Harness 构建于 Cordis 框架之上。本仓库启动时，Cordis core 处于 4.0.0-rc.6（一个候选发布版本）；harness 依赖框架内部实现（fiber 生命周期、dispose（资源释放）、waterfall（瀑布式事件）分发），其确切行为直接关系到 agent loop（智能体循环）的正确性保证。

## 决策

将所需的 Cordis 包（core、loader、include、group、timer、hmr、logger-console）与 cordiverse 基础库（cosmokit、schemastery）以源码形式复制到 `vendor/`，扁平化放置，保留其原始 npm 包名以实现透明的 workspace 解析。`pnpm-workspace.yaml` 设置 `linkWorkspacePackages: true`，所以只要上游 semver 范围匹配，无论以源码执行还是以构建产物执行，依赖都会解析到这些固定版本的 workspace。真正的第三方依赖（js-yaml、chokidar、@standard-schema/spec 等）仍从 npm 获取。

`vendor/README.md` 是 manifest（元数据清单）：记录每个包的上游仓库和 commit SHA，以及一份详尽的本地修改日志。pre-commit 守卫（`scripts/check-vendor-manifest.sh`）会拒绝未在同一次提交中更新 manifest 的 vendor 源码变更。

## 曾考虑的替代方案

- **依赖 npm 包**：否决。core 处于候选发布阶段，harness 依赖框架内部实现（fiber 生命周期、dispose、waterfall 分发），agent loop 的正确性保证取决于这些行为的确切表现；上游 RC 版本升级可能在没有本地修复路径的情况下破坏它们。
- **递归收录所有传递依赖**：否决。真正的第三方依赖（js-yaml、chokidar、@standard-schema/spec 等）仍从 npm 获取；只有内部实现对我们有影响的框架层才需要自行持有。

## 后果

- harness 完全持有其框架层：可审计、可打补丁、版本锁定。上游 RC 无法导致本项目故障，框架 bug 可以在仓库内直接修复。
- 构建后的包与源码测试执行的是同一版收录的 Cordis；移除 workspace 链接后，构建后的包会在包名不变的情况下静默改用 npm 副本。
- 上游同步是手动操作（流程记录在 manifest 中）。修改日志使 diff 范围始终可知。
- 收录的包保留上游代码风格；lint 与严格性门禁将其排除（它们的 tsconfig 在本地放宽了我们较新的编译器选项）。
- 从第一天起就有一个本地补丁：移除了 hmr 的 locale-YAML 导入（运行时 YAML 导入钩子未被收录）。
