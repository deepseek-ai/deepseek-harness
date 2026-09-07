# Agent Note: 以机械质量门禁取代行文约定

Status: implemented

[English](2026-06-11-quality-gates.md) | 中文

本记录中的钩子/CI 对称设计已由[快速本地 Git 钩子](../../archived/process/2026-07-22-fast-local-git-hooks.md)取代；CI 仍是执行完整检查的路径。

## 问题

本代码库主要由 coding agent（智能体）开发。相比行文约定，agent 遵守强制门禁的可靠性远高得多；而当劳动由 agent 承担时，「工作量大」不构成成本论据。早期证据：未通过类型检查的测试被提交（vitest 不做类型检查），仅在评审中才被发现。

## 决策

每条可机械检查的 AGENTS.md 承诺都有一个以非零状态退出的命令。CI 执行完整集合，而 Git 钩子将延迟预算留给可低成本发现的本地缺陷：

- 最严格的 TypeScript 配置（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等）；示例、测试和脚本通过根目录的 no-emit `tsconfig.json` 在 CI 中进行类型检查，而包/vendor 代码保持在各自 project-reference 边界之后。
- [Oxlint](../../archived/process/2026-07-29-oxlint-linter.md) 配合类型感知的 TypeScript 规则以及 @stylistic 和 SonarJS 兼容插件，强制执行统一代码风格和文件内重复逻辑检查；vendor 代码排除在外。
- jscpd 检测包的生产 TypeScript 代码与仓库脚本中的跨文件克隆；窄范围的源码区间例外用于记录有意为之的并行实现。
- `packages/*/*/src` 下按文件 100% 覆盖率（v8）；不可达的防御性守卫使用 `/* v8 ignore */ ` 并注明理由，而非删除。
- publint（包的正确性）、workspace 约束（workspace 规则：private、cordis peer+dev、统一版本、ESM），以及对构建出的包声明文件进行 NodeNext 消费方类型检查。[移除未使用代码门禁的决策](2026-08-19-remove-knip.zh.md)说明了静态死代码扫描为何不属于这套门禁。
- lefthook pre-commit 执行不加载项目的 Oxlint 验证，并应用带[一次有界重试](../../archived/process/2026-08-09-oxlint-only-fix-workflow.md)的安全修复，拒绝已暂存的空白问题并检查 vendor manifest（元数据清单）；pre-push 运行增量类型检查。CI 在 Node 22.19/24/26 上运行完整矩阵，并对 Headless、TUI、ACP（Agent Client Protocol）、JSON-RPC、工作流和代码运行时入口路径执行已构建应用的冒烟测试。

## 后果

- 约定不会因 agent 更替而失效；可低成本发现的 commit/push 缺陷会在本地触发失败，其余违规会在 CI 的完整检查中触发失败。
- 门禁本身也是需要维护的代码；配置变更与其他变更一样需要评审。
- 100% 覆盖率的压力可能催生无断言的测试——变异测试是计划中的对策（见[变异测试提案](../../proposed/testing/2026-06-11-mutation-testing.zh.md)）。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
