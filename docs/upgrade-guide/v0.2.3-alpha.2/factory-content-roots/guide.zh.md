---
kind: upgrade-guide
description: "Component Factory 现在用 DOM 元素包裹自身输出和调用方选中的局部组件，直接子元素选择器和空元素选择器的匹配结果随之改变。"
---

# Component Factory 的 DOM 根元素

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，渲染器不会在 Component Factory 或其局部组件外添加元素。升级后，渲染已注册的 Factory 时会添加一个根元素，例如 `[data-slot-factory="Tree"]`，即使 Factory 返回 `null` 也一样。如果没有注册定义，`renderFactorySlot()` 原样渲染调用方的 `fallback`，省略时则渲染 `null`，两种情况都没有 Factory 根元素。

只有调用方显式选中局部组件且 Factory 挂载了它，才会出现 `[data-slot-factory-children="Tree:tail"]` 这样的局部根元素。属性值用 ASCII 冒号（`:`）连接注册的 Factory 名和声明的局部 slot 名，两个名字均不编码。默认局部组件没有局部根元素；仅调用 `useFactorySlot()` 而不挂载返回的组件，也不会添加根元素。这两个属性都不标识实现模块或某个具体实例。

## 迁移

1. 更新插件 CSS 和 DOM 查询中的直接子元素选择器（`>`）。例如，`[data-slot-factory="sidebar.files.tree"] > ul` 选中[文件树](../../../../packages/client/ui-sidebar-files/README.zh.md#tree-factory)的顶层列表。同时检查使用 `parentElement` 遍历 DOM 的代码：两种根元素都使用 `display: contents`，自身没有布局盒。要测量尺寸，应测量列表或其布局容器，而不是 Factory 根元素。
2. 如果 HTML 要求使用短语内容（phrasing content），在 Factory 的 `registerFactory()` 选项或相应局部 slot 的声明中设置 `inline: true`，例如 `slots: { tail: { scope: 'root', inline: true } }`。两处设置相互独立，分别让对应的根元素及其错误占位元素使用 `span`，而非默认的 `div`。如果两种标签都不合法，则要移动渲染位置。`renderFactorySlot()` 和 `useFactorySlot()` 的调用签名不变。
3. 要检查 `:empty`，渲染一棵含一个条目的文件树，并由调用方选中一个返回 `null` 的 `accessory` 组件。选择器 `[data-slot-factory-children="sidebar.files.tree:accessory"]:empty` 会匹配局部根元素；其父元素不匹配 `:empty`。省略这个选择，确认文件树仍能渲染，但选择器在树内不匹配任何元素。
