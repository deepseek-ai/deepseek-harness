# Agent Note: 基于解析后主题的颜色元数据

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-resolved-theme-color-metadata.md) | 中文

## 问题

Web 客户端可以独立于操作系统偏好解析主题，因此 manifest（元数据清单）中单一的 `theme_color` 值或带媒体条件的静态元数据可能与显式选择的 Light 或 Dark 不一致。此时，无论是已安装页面还是普通页面，其周围的浏览器界面都未必与应用界面一致，尽管布局呈现器已经拥有解析后的 document 调色板。

## 决策

ui-layout 的 `ThemePresenter` 拥有一个 `<meta name="theme-color">`，与根元素上的 `color-scheme`、深色调色板属性和内联 token 写入并列。在应用解析后快照的调色板与 token 覆盖值之后，呈现器读取 body 计算样式中的 `background-color`，写入该元数据元素，再将该节点插入 document head。后续快照会更新同一节点，资源释放时则移除它。

渲染后的 body 背景仍是颜色真源。PWA manifest 不包含静态 `theme_color` 或 `background_color`，`ThemeDefinition` 也不新增可能与 token 调色板偏离的第二个颜色字段。这样一来，注册主题的基础背景 token 也能通过页面界面使用的同一条应用路径作用于浏览器界面。

## 验证

呈现器的单元测试约定覆盖浅色和深色模式下的计算颜色、节点复用及资源释放。ui-layout 组合测试覆盖初始插入、事件驱动的复用和 fiber 清理。Web 浏览器设置场景通过实际交付的组合依次驱动 Light、Dark、System、操作系统偏好变化和重新加载，并断言页面始终只有一个元数据元素，其内容等于计算后的 body 背景且控制台无错误。这项元数据变更不会出现在渲染后的无障碍树输出中，因此场景现有的预期输出保持不变。

## 曾考虑的替代方案

**在 manifest 中设置 `theme_color`。** manifest 只能提供一个适用于整个应用的值，因此任一内置调色板都可能与之不一致；manifest 有意省略该字段。

**用 `prefers-color-scheme` 媒体查询声明浅色和深色元数据。** 媒体查询跟随操作系统，而非应用内显式选择，因此无法表示解析后的偏好。

**为每个 `ThemeDefinition` 添加 `themeColor` 字段。** 单独的值可让自定义主题独立选择浏览器界面配色，但会复制基础背景色，并允许页面与周围的浏览器界面发生偏离。如果受支持的主题需要这种有意差异，可以再引入独立字段。

## 后果

支持该元数据的浏览器会在客户端应用初始解析后快照及之后每次主题变化时更新周围界面；不支持 `theme-color` 的浏览器会忽略这项元数据。由于该值来自计算后的呈现结果，客户端必须确保 body 始终有明确的背景色。呈现器会创建并移除自己的节点，head 中无关的元数据则保持不变。
