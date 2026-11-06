---
kind: upgrade-guide
description: "模型菜单扩展需要区分 composer 锁定状态与模型选择的保存状态。"
---

# 模型菜单的保存状态与锁定状态分离

[English](guide.md) | 中文

## 变更

向 `conversation.input.model.options` 提供内容的扩展会接收独立的 `pending` owner 属性。此前保存模型或推理等级选择时，`locked` 也会变为 true。现在 `locked` 仅表示 composer 不可用，`pending` 表示正在保存。因此，仅检查 `locked` 的扩展可能在保存期间接受另一个操作。

## 迁移

1. 从 `PropsRuntime<'conversation.input.model.options'>` 推导扩展 props，并同时读取 `locked` 与 `pending`。手动构造的测试 owner 需要提供 `pending`。
2. 在 `locked || pending` 时拒绝修改状态或打开子页的操作。对 `locked` 使用原生 `disabled`；对临时保存状态使用 `aria-disabled` 与 `aria-busy`，同时保留控件的焦点与外观。
3. 验证切换推理等级不会使扩展行变淡或位移，并确认在暂停响应的保存期间激活该行不会产生操作。另行验证 composer 真正锁定时仍禁用控件。

当前 owner 属性见[模型菜单扩展参考](../../../../packages/client/ui-model-selection/README.zh.md)。
