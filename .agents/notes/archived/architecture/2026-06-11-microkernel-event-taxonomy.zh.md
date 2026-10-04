# Agent Note: 微内核——通过 Cordis 事件分类体系实现扩展，唯一具体循环

Status: implemented
Archived: 2026-09-30

[English](2026-06-11-microkernel-event-taxonomy.md) | 中文

## 问题

产品原则是「一切皆插件」：钩子、/goal、/loop、动态工作流、压缩（compaction）、沙箱、权限、UI、持久化、MCP、skill（技能）都必须能以插件形式编写，无需修改核心。

## 决策

纯 Cordis 事件分类体系。agent loop（智能体循环）的扩展点是带类型的事件，具有明确的分发模式：

- **waterfall（瀑布式事件）**（around-middleware）：插件可变换、短路、恢复或包装：`agent/pre-step`、`agent/request`、`agent/request-error`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`llm/stream`、`system-prompt/assemble`。
- **serial**（按监听器顺序依次 await）：用于 `agent/turn-stopping` 等有序检查点。
- **parallel**（await 扇出）：每个监听器都必须获得独立执行的机会：`session/flush` 持久性检查点。
- **emit**（同步 fire-and-forget）：用于通知：inbox 转换、生命周期、错误，以及受错误隔离的 `tools/result` 观测；该观测接收不可变的最终结果。轮次与步骤边界由持久会话事件拥有。

事件词汇定义在约定包中（`dsh-agent` 声明 `agent/*` 事件）；`@deepseek-ai/dsh-agent-loop` 是唯一的具体循环插件，且自身可替换——外部不得依赖它。

## 曾考虑的替代方案

**专用中间件栈（koa-compose 风格）**与**显式阶段状态机（插件向其中插入阶段）**：两者都需要重新实现 Cordis 原生事件系统已提供的分发、dispose（资源释放）与重载语义；作为 Cordis effect，监听器天然获得 HMR（热模块替换）与 dispose 能力。

## 后果

- 每个 MVP 功能都映射到一个监听器（[功能→机制映射](../../../../docs/cookbook/extension-cookbook.zh.md#the-feature--mechanism-map)是证明义务，保持更新）。
- HMR 与 dispose 无需额外工作：监听器和注册均为 Cordis effect。
- waterfall 语义（调用 `next()` 或短路）不直观，需要教学——在 AGENTS.md 中记录，并由组合测试覆盖。
- 循环必须具备防御性：插件异常在轮次级别被隔离，来自任何扩展点的 steering（中途引导）永远不会被搁置（有回归测试保障）。
