# Agent Note: Headless 调用者对 Auto review 的授权

Status: implemented

[English](2026-10-18-headless-auto-review.md) | 中文

## Problem

Headless、SDK 和 ACP 以 `source.kind: 'user'` 接纳任务。Auto 必须将这些任务识别为指令，而不要求浏览器 RPC 身份。仅有消息角色不足以判断：注入上下文也使用 user role，但声明自己的 source。

## Decision

[实验性 Auto 层](../../../../packages/experimental/auto-review/README.zh.md#headless-supervision)支持显式 headless 选择。默认 profile 保持不变。这扩展了[逐工具 Auto review](2026-08-28-auto-review.zh.md)仅限 Web 的范围；其风险分类、完全访问执行、PTC 排除项和生命周期仍具权威性。

Reviewer 将 user-source 文本归为 `user-instruction`，包括已有历史和选择 Auto 前接纳的任务。用户可以是人或监督调用者；两者都可定义任务，并明确授权 medium 风险动作、准确目标和范围。当前 child 的创建 prompt 和直接父级消息保留从属角色；继承的创建 prompt 与无法验证的创建 prompt 仍是事实。文件、约束、checkpoint、图片和工具结果不会获得指令权威。输入生产者负责来源归属；任务文本不能选择自己的 source。消息类型和持久字段保持不变。

Headless 在选择权限预设后应用显式 `--approval-policy`。恢复时省略两个选项会延续已保存的策略。传入 `--permission-mode auto --approval-policy never` 可显式选择无人值守 Auto。这保留结构化拒绝，并避免依赖人工应答者。`ask` 仍遵循[审批兜底决策](2026-09-24-auto-review-user-approval-fallback.zh.md)；它不添加 CLI 审批传输。应用关闭保留已保存的 Auto 选择。恢复时需要该 integration，即使要选择其他预设也是如此；应用仍运行时移除插件则仍将存活 Session 迁移到 Full access。

JSON 投影在正常输出限制内包含已有的持久错误字段。最终拒绝携带 `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` 和可选 reviewer 详情；技术或解析失败携带 `AutoReviewFailedError` / `AUTO_REVIEW_FAILED`。两者都不执行工具 body。Agent 执行完成不代表每个请求动作都成功。

## Alternatives considered

**复用浏览器 RPC id。** Headless 调用不是浏览器请求。伪造该身份会将授权耦合到另一种传输，并错误描述持久来源。

**添加 headless 入口标记。** 已有 user source 已标识任务输入。传输专属标记增加持久元数据和读取规则，却不改变所需的权威判断。

**提升每条 user-role 消息。** 插件也提供 user-role 上下文。已有 source 判别字段区分接纳的用户输入与注入内容。

**实时调用者审批通道。** Headless 将 stdin 作为一个任务消费。审批暂停的调用需要双向协议、请求关联、断连与取消处理，以及应答者生命周期。后续调用可以改为提供限定范围的授权并接受新审查，不声称批准了先前调用。

## Consequences

监督者可以使用 Auto 实现修改和运行检查、查看结构化拒绝，并通过修订指令恢复。原生工具让所有支持的工具 body 都经过审查；PTC 内的直接 Node 效果仍不在范围内。Reviewer 仍是可能出错的模型，执行具有完全访问权限的后果，integration 仍保持实验性与显式启用。使用 user source 的自定义生产者被视为用户；后台上下文必须使用自己的 source。
