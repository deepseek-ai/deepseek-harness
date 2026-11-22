---
kind: upgrade-guide
description: "Web Client 的 hoc 层转发的 children 现在位于一个 DOM 元素内，影响直接子元素与兄弟元素选择器。"
---

# hoc slot 的 children 与 DOM 选择器

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，`hoc` 层渲染 `children` 时，渲染器不会在该位置添加 DOM 元素。升级后，渲染器会在该处用一个 `[data-slot-children="key"]` 元素包住内层内容。该元素使用 `display: contents`，没有布局盒，但仍参与 DOM 查询与 CSS 选择器的匹配。外层 `[data-slot="key"]` 的位置不变；没有适用层时，它仍原样渲染 owner 的内容，没有 `children` 出口。详见 [hoc 层](../../../subsystems/slots.zh.md#hoc-layers)。

## 迁移

1. 检查插件的样式表、DOM 查询与测试，找出跨越 hoc 层的直接子元素（`>`）、兄弟元素（`+`、`~`）选择器及 `firstElementChild` 等遍历操作。slot 注册、只渲染或替换 `children` 的 React 组件都无需改动。
2. 要定位插件自己的元素，在外层 `[data-slot="key"]` 内按其类名或属性查找，不要按固定层数逐级访问子元素。要匹配 `children` 的兄弟元素，按 slot 名选择出口。例如，若你的 `sidebar.session.action` 层紧跟 `{children}` 放置 `.extra`，`[data-slot-children="sidebar.session.action"] + .extra` 即可选中它。与它同级的是出口，而不是出口里的新建会话按钮。
3. 分别在没有适用层以及两层都转发 `children` 的情况下检查该 slot。确认前者的 owner 内容没有 `children` 出口，后者的 owner 内容位于嵌套的出口中。若某层替换 `children`，检查插件在原始内容缺失时能否正常工作。
