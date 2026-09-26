# Agent Note: 紧凑半透明菜单表面

Status: implemented

[English](2026-09-17-compact-translucent-menu-surfaces.md) | 中文

## Problem

共享下拉菜单与功能包自有菜单面板使用同一个高层级颜色 token，却保留了不同的内边距、行高、圆角和滚动条几何。不透明菜单填充也让嵌套与 portal 表面像彼此独立的实色卡片；如果只在各功能菜单中局部收紧尺寸，这些差异仍会分散在多个包中。

## Decision

`ui-theme` 将 `--dsw-specific-menu` 定义为明暗主题各自的半透明填充，并将 `--dsw-menu-backdrop-filter` 定义为 `blur(40px) saturate(150%)`。每个绘制菜单填充的包级高层级表面同时应用该 backdrop filter、设置 `border: 0`，并使用带可重绑发丝描边的 elevation 投影。包含 fixed 定位浮层的表面把填充与滤镜绘制在隔离的背景伪元素上，因为带滤镜的祖先会改变这些浮层的包含块。后代 sticky 行可以再次绘制继承的填充，无需重复 filter。不支持 backdrop filtering 的浏览器仍渲染主题持有的半透明填充。

共享 `Menu` 与 composer 输入触发菜单使用同一套紧凑基准：16px 外圆角、3px 边框内距、34px 普通行、13px 主文字配 20px 行高、6px 图文间距，以及 8px 行圆角。dense 与 compact 变体在该基准上继续缩小，不再保留旧的普通几何。composer 菜单保留其功能包持有的分组与 400px 高度上限；别名和说明使用 12px 字号与 18px 行高。

WebKit 系全局滚动条宽度为 5px。composer 菜单通过既有滚动条几何变量覆盖为 6px 可拖动轨道与 2px 可见滑块；Firefox 继续走标准 thin scrollbar 路径。轨道内缩与高层级 l2 滑块颜色仍由表面自行重绑。

## Alternatives considered

**保留不透明的共享菜单填充。** 否决，因为每个消费方都需要单独覆盖成半透明，导致同一种材质再次在 `ui-theme` 之外分叉。

**只收紧 composer 指令菜单。** 否决，因为共享 `Menu` 渲染的是同一套操作、设置与导航词汇；保留原 40px 行会让同一个控件家族继续存在两种密度。

**所有滚动条都使用 6px 带内边距轨道。** 否决，因为普通滚动区域需要直接的 5px 滑块，而指令菜单需要在更安静的可见滑块外保留更宽点击区域。现有几何变量可以表达该差异，无需第二套滚动条实现。

## Consequences

高层级菜单填充消费方必须在同一规则中同时使用填充与 backdrop-filter token，规则可以属于表面本身，也可以属于其隔离的背景伪元素；样式表门禁会拒绝漏掉 filter 的材质层。共享菜单几何影响每个 `Menu` 渲染点，composer 菜单仍保留自身内容与交互规则。浏览器与组件快照覆盖装配结构，主题测试固定 token、紧凑尺寸、滚动条几何与完整的菜单 filter 配对。
