---
kind: upgrade-guide
description: "Client UI 使用方必须将 JavaScript 面板定位和 Menu 矩形回调替换为 CSS 锚点。"
---

# CSS 锚定菜单

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-primitives` 移除 `useAnchoredPosition` 值导出和 `AnchoredPositionOptions` 类型导出。`Menu` 将 `getAnchorRect` 替换为指向外部触发元素的 `anchorRef`，或用于按坐标打开菜单的 `anchorPoint`。导入已移除导出或传入已移除 prop 的自定义 Client UI 必须迁移。

使用 portal 的菜单通过 CSS Anchor Positioning 跟随锚点。尺寸限制采用布局视口；浏览器缩放和平移时菜单随页面移动，面板可以超出视觉视口，包括键盘打开时。菜单关闭、键盘导航和内部滚动保持可用。浏览器必须支持组件使用的 CSS 锚点定位属性。

## 迁移

1. 移除 `useAnchoredPosition` 和 `AnchoredPositionOptions` 导入。自定义面板为触发元素设置唯一的 `anchor-name`，将面板的 `position-anchor` 设置为相同名称，并用 CSS 定义位置和尺寸限制；参见[模型选择器](../../../../packages/client/ui-model-selection/README.zh.md#understand-the-implementation)。
2. 原 `Menu.getAnchorRect` 返回触发元素矩形时，改为通过 `anchorRef` 传入该元素的 ref。由 `Menu` 渲染的内联 `anchor` 无需外部 ref。
3. 原回调为指针手势返回零尺寸矩形时，改为通过 `anchorPoint` 传入 `{ x, y }`，坐标与 `event.clientX`/`clientY` 或 `getBoundingClientRect()` 使用相同的客户端视口坐标系。`Menu` 在打开或坐标变化时执行 Safari 到布局视口的转换；调用方不要自行叠加视觉视口偏移。
4. 重新构建自定义 Client UI，确认不再使用已移除的导入或 prop。在浏览器缩放前后验证打开、滚动、Escape、焦点恢复和选择。断言应允许超出视觉视口，同时保留布局视口约束及内容访问能力。
