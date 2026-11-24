---
kind: upgrade-guide
description: "list slot 的输出现在位于行根内，直接子元素选择器、兄弟关系和空态判断都会受到影响。"
---

# list slot 条目的 DOM 选择器

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，Web Client 的 `list` slot 将每个胜出组件的输出直接放在 `[data-slot]` 出口内。升级后，每个胜出组件都有一个 `[data-slot-item]` 行根，即使用 `only` 只选一个 `id` 也一样。出口本身、其他 slot 类型及注册 API 均不变。为列表编写样式或查询其 DOM 的插件需要考虑这层新的父元素。元素标签、回退和错误占位的规则见 [list 行根](../../../subsystems/slots.zh.md#list-item-roots)。

## 迁移

1. 更新 CSS 和 DOM 查询中用于选取贡献元素的选择器，例如把 `[data-slot="conversation.session.header.actions"] > button` 改为 `[data-slot="conversation.session.header.actions"] > [data-slot-item] > button`。按钮的 `parentElement` 是行根，不是出口。`button + button` 仍能匹配同一个 Fragment 内相邻的按钮，但不能跨注册项匹配。也要检查 `:last-child` 规则：最后一个行根可能为空。段落内的 list 应声明 `inline: true` 并返回短语内容。如果所处位置不允许 `div` 或 `span` 作为子元素（例如 `tr` 的直接子级），应移动出口。
2. 在交互测试中，按角色和名称在目标出口内查找控件，例如 `getByRole('button', { name: 'Review' })`，不要取 `outlet.firstElementChild`。点击按钮，确认其操作生效。用 `button.getBoundingClientRect()` 检查按钮尺寸；行根使用 `display: contents`，自身没有可测量的布局盒。
3. 用 `{ only: 'review', fallback: <i>Unavailable</i> }` 渲染列表。若匹配的组件返回 `null`，`[data-slot-item]:empty` 会匹配行根，但出口不匹配 `:empty`。改为返回 `'Ready'`：行根虽然没有子元素，但有文本，并非空节点。再换用未注册的 `id`，确认 `<i>` 直接出现在出口下，没有行根。
