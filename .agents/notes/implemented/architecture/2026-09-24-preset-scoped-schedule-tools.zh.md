# Agent Note: 按 preset 提供的 Schedule 工具

Status: implemented

[English](2026-09-24-preset-scoped-schedule-tools.md) | 中文

## Problem

`@deepseek-ai/dsh-schedule` 自己注册 `schedule_create`、`schedule_list`、`schedule_update` 和 `schedule_delete`，在 `agent/created` 监听器中把它们附加到每个 live 根 Agent，唯一的过滤条件是 `ctx.agents.roots()` 的成员资格。该判据不涉及 Agent preset，因此为能力克制而组合的 `minimal` 也携带全部四个 schema，并承担其固定的请求上下文 token 成本。存储、投递和 preset 机制各自都是正确的；可用性决策落在了拥有存储服务的包里。

## Decision

`@deepseek-ai/dsh-tool-schedule`（`packages/schedule/tool-schedule`）以 preset 级 Consumer 的身份贡献 `schedule_create`、`schedule_list`、`schedule_view` 和 `schedule_edit`。它声明 `inject = ['tools', 'systemPrompt']`，并在 `ctx.inject(['schedule'], …)` 内注册这些定义和共用授权指令，因此挂载作用域拥有它们，注册会等待同一作用域中的宿主 Schedule 服务。发布版 Web profile 在其 `standard`、`cordis` 和 `ptc` preset 中挂载该行，`minimal` 不挂载。Cordis 的 effect 所有权随挂载卸载而释放这些定义，而始终未解析出 `schedule` 的组合不会注册其中任何一个。[Web bundle](../../../../packages/bundle/web-app/README.zh.md)负责随发行版交付的组合挂载的 `schedule` 与 `ui-schedule` 两行；本记录负责提醒工具的 preset 归属。

`@deepseek-ai/dsh-schedule` 保留 `schedule` 存储域，现写入 v2 并读取 v1，同时保留宿主定时器与串行队列、宿主投递、自动化任务页面的读取来源，以及 `ctx.schedule` 接口。`dsh-tool-schedule` 是该接口面向模型的消费者：它将 RRULE 与目标输入映射为服务请求，从 `exec.agent` 读取操作者与 `this_session` 目的地，并把未声明的失败映射为 `internal_error`，使存储细节不会到达模型。管理按 id 寻址宿主全部任务；仅目标选择接收 Session。

## Alternatives considered

**继续在宿主服务中通过 `Config` 开关注册。** `exposeTools` 这类字段会把组合选择放进存储插件，而任何 preset 都无法在那里声明它，且每个 preset 仍要各自编辑才能改变结果。

**只要 `ctx.schedule` 存在就注册这些工具。** 随发行版交付的 Web 组合为整个部署挂载 `schedule` 宿主服务，包括 `minimal`，因此该条件会恢复本决策所移除的、存储与模型界面之间的耦合。

## Consequences

- `minimal` 的请求头与工具列表不含任何提醒工具 schema。
- 挂载该行的每个 preset 承担四个 schema 的固定 token 成本，工具可用性取自组合，而不是由宿主服务是否存在推断。
- 部署可以只为存储与投递挂载 `dsh-schedule`，而不授予其 Agent 由模型驱动的提醒管理能力。
- `dsh-schedule` 不注入 `ctx.tools`，也不注册任何面向模型的工具。
- 被委派的子 agent 继承 preset 的四个提醒 schema。调用方委派深度大于零时，`dsh-tool-schedule` 中的 `runForCaller` 从每个工具返回 `{ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }`。[preset 组装决策](../simplification/2026-10-09-preset-owned-subagent-composition.zh.md)移除了重复的子级过滤；可见性不授予执行权限。
- 被委派子 agent 拥有的 Session 永远收不到投递的提醒，因此 `ScheduleService.create` 以及通过 `ScheduleService.edit` 改变目标或启用任务时会以 `subagent_session` 拒绝它。该拒绝读取委派深度——委派封顶本身执行的记账，由持久化 session header 承载并跨冷恢复保留。这条规则在服务层，因此其它消费方（包括自动化任务页面）也会命中。

## Testing

`packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` 固定这四个定义及其错误映射，包括 `refuses every call from a registered delegated child whose scope mounts the tools`；`packages/subagent/subagent/tests/schedule-tools.spec.ts` 通过工具执行器运行一个被委派的子 agent，并在没有已存任务时固定该拒绝。`apps/cli/tests/web-agent-presets.e2e.ts` 断言 `minimal` preset 的工具列表，`snapshots/web/minimal-preset/tool-schemas.expected.json` 记录其不含提醒工具 schema 的工具表。`packages/schedule/schedule/tests/subagent-ownership.spec.ts` 固定委派深度拒绝，`scripts/optional-bundles.spec.ts` 断言三个 preset 的两行委派行都不含 `toolFilter`。Web preset e2e 还检查父子工具 schema 相等，且四个提醒执行器对新建和带种子的子级均拒绝执行。`snapshots/web/subagent-fork-schedule` 通过出货 Web 组合记录带种子 fork 中的四次拒绝，并共享 standard preset 的提示和 schema 预期。
