# Agent Note: Todo 优先的 composer 上下文顺序

Status: implemented
Archived: 2026-09-04

[English](2026-08-02-todo-first-composer-context-order.md) | 中文

## 问题

composer 上下文堆栈将 Goal 渲染在 Todo 之前，但 Harness 设计稿把当前任务计划排在进行中的目标和待处理 Queue 之前。Todo 还把 Queue 包装层的 776px 宽度用作自身的可见卡片宽度，而 Goal 和 Queue 面板则渲染在共享的 752px 卡片列上。结果既颠倒了预期的信息层级，也让 Todo 比相邻两个面板更宽。

## 决策

`conversation.input.dock` 列表采用统一的产品顺序，升序依次为 Todo `0`、Goal `10`、Queue `20`，随后是位于列表外的 composer bar。注册顺序仍是语义真源；渲染器不会硬编码已知组件 id，也不会使用 CSS 修正它们的顺序。

Todo、Goal 与可见的 Queue 面板共用 800px composer 宽度上限内的 752px 卡片列。Queue 保留 776px 包装层，并在两侧各留 12px 透明内缩，因为该包装层负责与 composer 重叠。Todo 是独立卡片，而非包装层，因此其响应式宽度和最大宽度都会直接扣除两层内缩。Goal 使用相同的响应式卡片列，并将内层横条的宽度上限设为 752px，从而在低于桌面宽度上限时也保持边缘对齐。

[composer 堆栈约定](2026-07-30-composer-context-stack-order.zh.md)继续规定卡片间距，以及仅限 Queue 与 composer 重叠。本决策只取代该记录中 Goal 优先的顺序。

## 验证

Todo 与 Goal 的注册测试分别固定顺序 `0` 和 `10`；Queue 仍固定为 `20`。无密钥 Queue 浏览器场景同时渲染三个面板，记录 Todo–Goal–Queue 的无障碍顺序，并在 1680px 桌面基线和低于宽度上限的 640px 视口下比较其可见边界框，随后再执行 Queue 变更。

## 考虑过的替代方案

**在 `ConversationRoot` 内重新排列已知面板。** 不予采纳，因为 `conversation.input.dock` 是可扩展的有序列表；硬编码的组件清单会使插件激活顺序与渲染顺序不一致。

**使用 CSS `order` 移动 Todo 的视觉位置。** 不予采纳，因为无障碍顺序和键盘顺序必须与视觉层级一致，而 slot 账本已经负责语义顺序。

**让 Todo 保持 Queue 包装层的宽度。** 不予采纳，因为 Queue 包装层的透明内缩是其与 composer 重叠所需的布局基础设施，不属于可见面板列。

## 后果

当前有效的任务计划显示在进行中的目标之前，待处理 Queue 工作仍最靠近 composer，三张可见卡片共用相同的横向边缘。未来的 input-dock 插件必须相对于 Todo `0`、Goal `10` 和 Queue `20` 选择明确位置；仅 Queue 负责末端包装层与 composer 的重叠。
