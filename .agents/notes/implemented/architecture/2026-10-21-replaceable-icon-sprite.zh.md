# Agent Note: 通过 SVG sprite 实现可替换的产品图标

Status: implemented

[English](2026-10-21-replaceable-icon-sprite.md) | 中文

## 问题

长期的皮肤定制需要主题能替换图标，而不只是颜色。产品图标原先是绘制内联 SVG 路径的 React 组件，因此通过 `ctx.theme` 注册的主题可以借助 `currentColor` 给它们换色，却无法更换图形。约 150 个 Client 文件导入了这些组件。

## 决策

每个产品图形的每种线重对应一个 sprite symbol `dsw-icon-<glyph>-<weight>`。ui-primitives 以 `ICON_SYMBOLS` 保存默认 SVG 文档；图标组件保留导出名、`size` 与 `className`，渲染一个 `<svg>` 框，其中包含一个引用自身 symbol 的 `<use>`。ui-theme 在文档中保留一个隐藏的 sprite，其 `<symbol>` 子元素来自活动主题的 `ThemeDefinition.icons` 替换项或默认值。通过 `<use>` 引用的图形会从使用处继承 `currentColor` 与 CSS 自定义属性，因此替换图形可以是多色的，可以用 `--dsw-*` 颜色 token 绘制，并且无需单独的值就能跟随浅色与深色调色板。

## 考虑过的替代方案

- **把图标作为通过 `mask-image` 绘制的 CSS 图像 token。** 经设计评审后否决：遮罩只保留图像的 alpha，因此每个图标都只能是单色；`url()` 图像无法读取 CSS 变量，因此多色图形无法跟随颜色 token。该方案本可复用 token 覆盖层，而无需新增主题字段。
- **以 React 组件为值的运行时图标注册服务。** 否决：组件无法读取服务或 React context，因此每个图标导入处都需要新的 prop 或 slot。
- **每个图标一个 slot。** 因同样的调用方成本而否决；slot 承载的是组合，而不是图形。

## 后果

- 图标 DOM 包含 `<use>` 引用而不是路径；测试通过 `data-icon` 识别图形，通过 `ICON_SYMBOLS` 检查图形。
- 没有 ui-theme 时，sprite 不存在，图标不渲染任何内容。
- 所有 symbol 共享文档的 id 空间，因此 `register` 要求替换图形内的元素 id 以 `<symbol id>-` 开头；另一个文档（例如 iframe）中的 `<use>` 无法引用该 sprite。
- 替换标记与注册它的插件代码同等受信任；`register` 仅拒绝 `<style>` 与 `<script>`，因为它们会作用于整个文档。
- 渐变及其他绘制服务器在 sprite 所在位置解析其色标，因此它们跟随调色板 token，但不跟随使用处的颜色覆盖。
- 默认 symbol 与使用 token 着色的替换 symbol 在 Chromium、WebKit 与 Firefox 中通过 `<use>` 渲染与内联渲染的结果逐像素一致。
- 文件类型、插件、站点与品牌图形仍以内联方式渲染，暂不可替换。
