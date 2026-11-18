# Agent Note: 实时读取的 subagent 模型选择设置

Status: implemented

[English](2026-11-17-live-subagent-model-selection-setting.md) | 中文

## Problem

[用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md)把 Host 允许列表快照到每个新顶层 Session 的 `subagent/model-selection-policy` 中。用户在 Session 进行中启用设置、添加路由或撤销路由后，要到新 Session 开始才会生效；恢复的 Session 保留其创建时记录的列表。设置的可见含义取决于每个 Session 的创建时间，设置页无法解释这一点。

## Decision

`SubagentModelSelectionConfig.allowedRoutes()` 在每次调用时读取 volatile 的 `enabled`；选择关闭时立即返回 `undefined`，否则校验 `allowedModels` 并返回独立的路由列表。`subagent` 执行器和 `list_subagent_models` 在允许模型选择的工具显式选择路由时、每次发现调用时通过 `ctx.get('subagentModelSelection')` 调用它，因此设置编辑会对所有运行中、已恢复和子 Session 的下一次调用生效。服务缺失或设置关闭时，显式选择与之前一样只允许当前父级路由。

不追加 Session 事件，也不注册投影。`subagent/model-selection-policy` 声明保留，使已发布的 Session 日志仍能通过校验，但没有代码读取它；记录过策略的 Session 遵循当前设置。启用但路由列表为空、格式无效或重复时，读取该设置的每次调用都会以 `INVALID_MODEL_SELECTION_SETTINGS` 失败，而不是使 Agent 创建失败。普通委派和关闭模型选择的工具不读取该列表。

## Alternatives considered

**保留创建时快照。** 不采用，因为用户可见的设置是持续生效的授权，编辑后静默跳过所有已打开的 Session，看起来就是控件失效。旧 Agent Note 担心编辑会改变运行中 Session 的能力，而这正是所需行为。

**设置变更时记录新的策略事件。** 不采用，因为每次保存设置都要向所有在线 Session 追加事件，已恢复的 Session 在加载前仍会遗漏，并留下两个可能不一致的来源。允许列表不是模型可见输入：工具 schema 固定，只有 `list_subagent_models` 结果或委派错误会到达模型，两者都作为工具结果记录在日志中。

**存在已记录策略时沿用它，否则回退到设置。** 不采用，因为旧 Session 会因此忽略之后的编辑，恰好在用户最常恢复的 Session 上重现不一致。

## Consequences

- 撤销路由在下一次调用时生效，包括运行中父级的子级；transcript 早先允许的路由现在可能以 `MODEL_ROUTE_NOT_ALLOWED` 被拒绝。
- 重放 Session 时不能仅凭日志重现其授权；日志中的工具结果仍显示模型看到的内容。
- Agent 创建不再依赖设置服务，因此无效设置不会阻塞没有委派工具的 Session。
- `packages/subagent/tool-subagent/tests/model-selection-settings.spec.ts` 中的单元测试固定实时读取、父子 Session 中途编辑生效，以及忽略已记录策略。
