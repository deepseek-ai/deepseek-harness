---
kind: upgrade-guide
description: "SubagentActivationSpec 直接接受任务选项，不再使用嵌套的 request 对象。"
---

# 子代理 activation 选项

[English](guide.md) | 中文

## 变更

调用 `ctx.subagents.startActivation()` 的插件代码必须将 `prompt`、`parent` 和可选执行设置直接放在 `SubagentActivationSpec` 上。嵌套的 `request` 字段已移除。类型名称、提供方请求、取消和结果投递保持不变。

## 迁移

1. 在每个 `startActivation()` 调用中，将 `request` 内的字段移到外层对象。已有任务对象时，将 `request: task` 替换为 `...task`；将 activation 的 `label` 和 `signal` 放在展开操作之后，以确保它们优先生效。
2. 将 `spec.request.prompt` 等读取替换为 `spec.prompt`。保持后端的 `SubagentStartRequest` 实现不变。
3. 对插件运行类型检查和委派测试，验证更新后的调用。
