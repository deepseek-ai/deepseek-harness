# Agent Note: 移除独立的 CLI demo

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-remove-cli-demo.md) | 中文

## 问题

在 [`dsh --profile headless`](../architecture/2026-08-06-app-owned-command-line.zh.md) 成为产品的一次性命令后，`@deepseek-ai/dsh-cli-demo` 仍是承担同一工作的第二个应用包。它另行拥有一套可执行文件、参数语法、应用组装、取消生命周期、文本／JSON／stream-JSON 输出约定、构建产物、配套文档和测试套件。两个入口组装的树也不相同，因此 demo 成功不能证明已交付的 `headless` profile 可用，用户还必须在功能重叠的命令之间作出选择。

回放套件仍需要规范会话事件来固定组装后的后端行为。这一测试需求不需要已发布命令或兼容性约定。

## 决策

彻底删除 `@deepseek-ai/dsh-cli-demo`：包括它的包、bin、解析器、应用插件、输出格式、测试、workspace 引用、生成目录条目和现行文档。不保留别名或兼容包。源码用户通过 `pnpm dsh --profile headless` 调用产品命令；stdout 上的最终文本、stderr 上的失败诊断、持久化、退出状态和关闭行为均由该命令负责。

`apps/cli/tests/profiles/headless` 加载已交付的 `base` 与 `headless` 组合包层，然后只对回放或模拟提供方、隔离持久化及被测行为应用窄 overlay。支持层的 `@deepseek-ai/dsh-loader-smoke` 包负责交付 profile 组装 helper、共享的直接 agent 轮次 helper 与仅限测试的 driver；该 driver 将规范事件渲染为 JSONL，但不定义受支持的产品输出格式。

## 考虑过的替代方案

- **保留 `dsh-cli-demo` 作为 `dsh --profile headless` 的别名或包装层。** 不予采纳：第二个 bin 和包会让同一功能继续存在两个可发现的归属方，却没有增加任何能力。
- **把 JSON 和 stream-JSON 标志移到 `dsh --profile headless`。** 不予采纳：当前没有产品消费方需要这些标志；沿用旧 demo 协议，只会为了保留测试机制而扩大规范 CLI（命令行界面）约定。
- **随包一并删除规范事件快照。** 不予采纳：这些快照固定了模型可见的组装行为，而只检查最终文本的产品验收无法观察这些行为。
- **保留应用插件，只删除它的 bin。** 不予采纳：隐藏的组装仍会重复显式的 headless profile，并掩盖测试叶节点挂载了哪些服务。

## 后果

这是有意为之的破坏性变更。`dsh-cli-demo`、它的 `--output-format` 选项以及对 `@deepseek-ai/dsh-cli-demo/src/cli.ts` 的导入都不再可解析。本变更不提供公开的事件流替代接口；调用方使用 `dsh --profile headless` 执行一次性任务，需要结构化自动化时则必须选择现有的协议接口。

仓库通过仅供测试的基础设施保留后端回放覆盖，产品冒烟测试和 built-bin 验收则运行 `dsh --profile headless`。只有当独立的一次性包负责一套真正独立、带版本且不能归产品启动器所有的协议时，它才可以重新引入；第二种命令写法或输出 shim 并不足以构成理由。

## 验证

聚焦的 Loader 冒烟测试在源码模式和由普通 Node 启动的构建模式下覆盖显式组装，快照测试对比其规范 JSONL 和持久化日志，产品验收覆盖 `dsh --profile headless`，文档检查及生成图谱／目录门禁则拒绝对已移除包的活跃引用。冻结的 Agent Note 归档保留为历史证据，不会被重写。
