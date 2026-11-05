---
kind: upgrade-guide
description: "依赖 macOS 全局 no-drag 排除的自定义 Client 浮层必须声明自己的窗口区域。"
---

# 自定义 Client 浮层显式声明窗口区域

[English](guide.md) | 中文

## 变更

从 0.2.2-rc.1 升级后，macOS Desktop 仅自动排除 `data-window-drag` 行或 `data-window-drag-controls` 范围内的交互控件。此前，应用中任意位置匹配的控件和 ARIA role 都会获得 `no-drag`。自定义 Client 插件若依赖该规则使覆盖可拖动页头的内容保持可交互，现在必须声明排除。未显式声明区域的普通滚动内容不贡献区域，因此被裁剪到视口上方的内容不会再阻挡页头拖动。

该变更影响这些范围之外、覆盖拖动行的自定义浮层。已位于标记行内的控件、使用自带排除的共享原语的浮层，以及已显式声明 `no-drag` 的组件无需迁移。规则仅适用于 macOS Desktop，普通 Web 和 Windows 行为不变。

## 迁移

1. 检查可能覆盖页头的自定义 Client 浮层的 JSX 与 CSS Modules，确认其交互内容是否依赖此前的自动排除。
2. 对不含嵌套拖动行的交互视口，在可见视口元素上添加 `data-window-drag-exclude`。它仅排除视口自身矩形，使被裁剪的子元素不参与区域计算。若容器内的控件需要分别排除，在承载这些控件的元素上添加 `data-window-drag-controls`。浮层和含嵌套拖动行的容器必须单独声明区域，遵循[窗口区域规则](../../../../packages/client/web/README.zh.md#understand-the-implementation)。
3. 在可见区域所有者上声明排除，不要逐个排除可聚焦子元素。对应浮层采用共享 `Modal` 或 `MenuSurface`，或显式排除自定义浮层的可见矩形。不产生布局矩形的 body portal 需在可见内容上声明排除。
4. 在 macOS Desktop 加载更新后的插件，将浮层打开到页头上方，确认其控件正常生效且不会拖动窗口。关闭浮层后确认页头空白区域仍可拖动；将插件内容滚出可见区，确认被裁剪内容不会阻挡页头。
