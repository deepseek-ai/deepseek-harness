# Agent Note: Composer 上下文堆栈顺序

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-composer-context-stack-order.md) | 中文

## 问题

Goal、Todo 与 Queue 独立注册到同一个 `conversation.input.dock` 列表，但各自的注册顺序与间距规则没有编码组合矩阵。因此，渲染器将 Todo 放在 Queue 和 Goal 之前，而 Queue 与 Goal 都带有用于 composer 边界的负外边距。三者同时出现时，Queue 与 Goal 相接，Goal 与 composer 相接，颠倒了设计层级。

## 决策

[Todo 优先的对齐决策](2026-08-02-todo-first-composer-context-order.zh.md)规定当前的升序排列。本记录保留围绕该顺序的堆栈约定：数值间隔使未来条目可以声明预期位置，不必依赖插件激活顺序；composer bar 位于列表之后。

`ConversationRoot` 负责独立上下文卡片之间的 6px 间距。Goal 是一张独立的 752×36px 卡片，折叠后的 Todo 是一张独立的 752×44px 卡片。Queue 是末端 dock 条目：其 776px 包装层包含相同的 752px 面板列，并减去共享间距与具名的 5px 布局重叠量，因此后渲染的 composer 卡片只覆盖 Queue 边缘。空条目渲染为 null，不占用间距。

顺序与重叠是两项独立约定。注册顺序定义语义层级，stack 上的 CSS 变量定义共享几何。系统不能仅因 Queue 是最后一个可见条目，就推断它可以与 composer 重叠，因为没有 Queue 时，Goal 或 Todo 可能成为最后一个可见上下文卡片，而它们必须与 composer 保持间隔。

## 验证

注册测试固定了三个顺序值。无密钥 Queue 浏览器场景同时渲染 Todo、Goal 和 Queue，固定它们的无障碍顺序，并检查其可见卡片边缘；分别针对 Goal 与 Queue 的场景覆盖各自的独立状态。

## 考虑过的替代方案

**Goal 和 Queue 分别保留独立的负外边距。** 不予采纳，因为受影响的相邻项会随 slot 顺序变化；除非语义顺序也固定，否则局部外边距无法表达允许哪一种关系。

**在 `ConversationRoot` 中分别渲染每个已知 dock id。** 不予采纳，因为这会把可扩展的列表 slot 变成硬编码的组件清单，并迫使 owner 在每新增一个注册方时随之修改。

**让最后一个 dock 条目与 composer 相接。** 不予采纳，因为 Goal 和 Todo 是独立卡片；Goal 或 Todo 缺席时的组合不得改变剩余卡片的界面语义。

## 后果

所有存在组合下的视觉层级都保持稳定，Queue 是唯一与 composer 相接的上下文界面。新的 input-dock 插件必须相对于 Todo `0`、Goal `10` 与 Queue `20` 选择顺序；若条目位于 Queue 之后，还必须明确决定由哪个界面负责 composer 边界。
