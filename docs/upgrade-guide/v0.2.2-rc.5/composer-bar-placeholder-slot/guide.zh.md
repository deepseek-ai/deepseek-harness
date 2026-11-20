---
kind: upgrade-guide
description: "构造 ComposerBarProps 的代码现在必须提供内置输入栏占位提示的 renderSlotChain。"
---

# 输入栏 props 需要提供占位提示的渲染函数

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-conversation/client` 导出的 `ComposerBarProps` 现在要求提供 `conversation.input.placeholder` 的 `renderSlotChain`。构造这组 props 时缺少该属性会导致类型检查失败。使用 `ComposerBarProps` 替换整个输入栏的组件，需要按自己的注册声明定义 props 类型。

## 迁移

1. 若测试夹具构造 `ComposerBarProps`，提供 `renderSlotChain: (_key, _owner, options) => options?.fallback`，让没有插槽贡献的测试显示内置占位提示。
2. 若在 `conversation.composer.bar` 注册替换输入栏，以 `@deepseek-ai/dsh-client-ui-slots` 的 `PropsRuntime<'conversation.composer.bar'>` 为基础类型。按该注册声明的子插槽键加入 `PropsRenderSlots`，并保留组件使用的注入和本地化 props。参见[插槽](../../../subsystems/slots.zh.md)。
3. 运行 TypeScript 类型检查，确认更新后的 props 与注册声明匹配。
