---
kind: upgrade-guide
description: "Web Client 的 hoc 层转发的 children 现在位于一个 DOM 元素内，影响直接子元素与兄弟元素选择器。"
---

# hoc slot 的 children 与 DOM 选择器

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，`hoc` 层渲染 `children` 时，渲染器不会在该位置添加 DOM 元素。升级后，渲染器会在该处用一个 `[data-slot-children="key"]` 元素包住内层内容。属性值是向该层提供这份 `children` 的 slot 名，即使最终由另一个 slot 渲染也不变。该元素使用 `display: contents`，没有布局盒，但仍参与 DOM 查询与 CSS 选择器的匹配。外层 `[data-slot="key"]` 的位置不变；没有适用层时，它仍原样渲染 owner 的内容，没有 `children` 出口。详见 [hoc 层](../../../subsystems/slots.zh.md#hoc-layers)。

## 迁移

1. 检查插件的样式表、DOM 查询与测试，找出跨越 hoc 层的直接子元素（`>`）、兄弟元素（`+`、`~`）选择器及 `firstElementChild` 等遍历操作。slot 注册、只渲染或替换 `children` 的 React 组件都无需改动。
2. 假设 `outer.frame` 的一层把 owner 传入的按钮和额外添加的按钮放在同一个 Fragment 中，交给 `inner.frame` 转发。若 `inner.frame` 的层原样返回 `children`，`[data-slot-children] > button` 会选中两个按钮，在任一按钮上调用 `closest('[data-slot]')` 找到的也都是 `inner.frame`。
3. 在目标实例的 `[data-slot="outer.frame"]` 元素内查询。用 `[data-slot-children="outer.frame"] > button` 选中 owner 传入的按钮，用 `[data-slot-children="inner.frame"] > button` 选中额外添加的按钮。若要用兄弟选择器匹配后者，应使用 `[data-slot-children="outer.frame"] + button`：它紧跟的是出口，而不是 owner 的按钮。
4. 渲染两个 `outer.frame` 实例，确认按 slot 名筛选的选择器在目标实例内都只选中预期的按钮。`outer.frame` 没有适用层时，owner 的按钮是 `[data-slot="outer.frame"]` 的直接子元素；若某层替换 `children`，原始按钮应不存在。
