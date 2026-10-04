# Agent Note: 按 preset 提供的 Schedule 工具

Status: implemented

[English](2026-09-24-preset-scoped-schedule-tools.md) | 中文

## Problem

`@deepseek-ai/dsh-schedule` 自己注册 `schedule_create`、`schedule_list`、`schedule_update` 和 `schedule_delete`，在 `agent/created` 监听器中把它们附加到每个 live 根 Agent，唯一的过滤条件是 `ctx.agents.roots()` 的成员资格。该判据不涉及 Agent preset，因此为能力克制而组合的 `minimal` 也携带全部四个 schema，并承担其固定的请求上下文 token 成本。存储、投递和 preset 机制各自都是正确的；可用性决策落在了拥有存储服务的包里。

## Decision

`@deepseek-ai/dsh-tool-schedule`（`packages/schedule/tool-schedule`）以 preset 级 Consumer 的身份贡献这四个工具。它声明 `inject = ['tools']`，并在 `ctx.inject(['schedule'], …)` 内通过 `ctx.tools` 注册这些定义，因此拥有它们的是挂载它的作用域，而注册会等待同一作用域中的宿主 Schedule 服务。发布版 Web profile 在其 `standard`、`cordis` 和 `ptc` preset 中挂载该行，`minimal` 不挂载。Cordis 的 effect 所有权随挂载卸载而释放这些定义，而始终未解析出 `schedule` 的组合不会注册其中任何一个。[Web bundle](../../../../packages/bundle/web-app/README.zh.md)负责随发行版交付的组合挂载的 `schedule` 与 `ui-schedule` 两行；本记录负责提醒工具的 preset 归属。

`@deepseek-ai/dsh-schedule` 保留版本 1 storage domain、宿主定时器与串行队列、经由 Session controller 的宿主投递、自动化任务页面的读取来源，以及 `ctx.schedule` 接口。`dsh-tool-schedule` 是该接口面向模型的消费者：它在调用服务前校验选择器与身份约束，从 `exec.agent` 读取 Session 绑定，并把非 `ScheduleInputError` 的失败映射为 `internal_error`，使存储细节不会到达模型。

## Alternatives considered

**继续在宿主服务中通过 `Config` 开关注册。** `exposeTools` 这类字段会把组合选择放进存储插件，而任何 preset 都无法在那里声明它，且每个 preset 仍要各自编辑才能改变结果。

**只要 `ctx.schedule` 存在就注册这些工具。** 随发行版交付的 Web 组合为整个部署挂载 `schedule` 宿主服务，包括 `minimal`，因此该条件会恢复本决策所移除的、存储与模型界面之间的耦合。

## Consequences

- `minimal` 的请求头与工具列表不含任何提醒工具 schema。
- 挂载该行的每个 preset 承担四个 schema 的固定 token 成本，工具可用性取自组合，而不是由宿主服务是否存在推断。
- 部署可以只为存储与投递挂载 `dsh-schedule`，而不授予其 Agent 由模型驱动的提醒管理能力。
- `dsh-schedule` 不注入 `ctx.tools`，也不注册任何面向模型的工具。
- 被委派的子 agent 无法通过两道中的任何一道使用这四个工具：`standard`、`cordis` 与 `ptc` 中的 `tool-subagent` 与 `tool-subagent-fork` 两行通过 `toolFilter` 拒绝全部四个名称，provider 会在子作用域内通过 `ctx.tools.restrict()` 应用该过滤，因此这些工具会从子 agent 的 prompt 中消失；`dsh-tool-schedule` 中的 `subagentCallerRefusal` 会在调用方委派深度大于零时，从四个工具中的每一个独立返回 `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }`，因此即使某个调用仍能到达工具，也会被拒绝。
- 被委派子 agent 拥有的 Session 永远收不到投递的提醒，因此 `ScheduleService.create` 与 `ScheduleService.update` 会以 `subagent_session` 拒绝它。该拒绝读取委派深度——委派封顶本身执行的记账，由持久化 session header 承载并跨冷恢复保留。这条规则在服务层，因此其它消费方（包括自动化任务页面）也会命中。

## Testing

`packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` 固定这四个定义及其错误映射，包括 `refuses every tool for a delegated child caller`。`apps/cli/tests/web-agent-presets.e2e.ts` 断言 `minimal` preset 的工具列表，`snapshots/web/minimal-preset/tool-schemas.expected.json` 记录其只含 `bash` 的工具表。`packages/schedule/schedule/tests/subagent-ownership.spec.ts` 固定委派深度拒绝，`scripts/optional-bundles.spec.ts` 断言三个 preset 的两行委派行都拒绝全部四个工具名。
