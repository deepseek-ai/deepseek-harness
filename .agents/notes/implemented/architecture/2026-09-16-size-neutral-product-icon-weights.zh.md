# Agent Note: 尺寸无关的产品图标线重

Status: implemented

[English](2026-09-16-size-neutral-product-icon-weights.md) | 中文

## 问题

共享产品图标的导出名称包含一个历史渲染尺寸，但每个组件已经接受 `size` prop。消费方还会通过本地 CSS 或独立图稿加粗部分图标，视觉强调没有具名的图标库选项，因而可能在不同功能间漂移。

## 决策

每个共享产品图形都导出尺寸无关的 `Regular` 和 `Medium` 组件。`Regular` 渲染提供的 1px 图稿，`Medium` 使用相同路径并继承 1.3px 描边；填充区域保持不变。`size` prop 控制渲染尺寸；仅当图稿没有 16px 来源时，原数字后缀才作为默认尺寸保留。

`LinkIconRegular` 与 `LinkIconMedium`、`ReferenceIconRegular` 与 `ReferenceIconMedium`，以及三组 `PermissionIcon*Regular`/`PermissionIcon*Medium` 遵循同一规则。仓库内消费方使用具名线重，不再使用带数字的导出名。

Medium 线重只用于明确强调的场景：新建会话控件、设置入口与导航图标、外观选项、输入框加号按钮，以及可点击产物链接的图标。其他既有消费方使用 Regular。编辑器加号菜单中的权限命令使用 `PermissionIconFullAccessRegular`，因为该行表示权限提升，而不是当前权限模式。

## 考虑过的替代方案

**在导出名中保留像素尺寸。** 否决，因为后缀重复了运行时 `size` prop，并为相同几何创建了多个名称。

**只导出一个带 `weight` prop 的组件。** 否决，因为调用点会把线重选择隐藏在 prop 中；显式组件名便于搜索和审查视觉强调。

**在消费方 CSS 中覆盖描边宽度。** 否决，因为源 SVG 元素可能自带描边宽度，本地覆盖会在图标库外重新产生不一致线重。

## 后果

图标 API 在预稳定阶段有意进行破坏性调整：每个消费方明确选择 `Regular` 或 `Medium`；原 14px 调用点与 16px 导出共享几何时会显式传入尺寸。新增产品图形从同一份几何定义同时提供两种线重。仅填充的图稿也为 API 一致性导出两个名称，即使线重不会改变其外观。上述层级选择继续由对应渲染点显式声明，不会变成全局尺寸或透明度覆盖。
