# Agent Note: 按内容定高的图表预览

Status: implemented
Archived: 2026-09-10

[English](2026-09-09-content-sized-diagram-previews.md) | 中文

## Problem

较矮的 Graphviz 与 SVG 图片显示在 400px iframe 中时，会留下大块空白。浏览器已经知道图片的渲染尺寸，但一张 59px 高的 Graphviz 图表仍占据 400px 的预览区域。

## Decision

Mermaid、Graphviz 与 SVG 共享 `SourcePreview` 的不可执行图片画布。浏览器根据图片决定高度，在可用宽度不足时按比例缩小，并添加 16px 内边距。源码切换保留图片，复制读取原始代码。主题变化重新生成 Graphviz 配色，无需单独的尺寸观察器。

这替代了[静态 Markdown fence 预览](../feature/2026-09-09-markdown-static-previews.zh.md)中的图表 iframe 选择；该记录继续维护 HTML 隔离、渲染生命周期与许可证义务。HTML 保留不透明来源、禁用脚本的 400px iframe。SVG 图片模式禁用脚本、链接交互与外部资源加载，无需把源码控制的标记插入应用文档。

## Alternatives considered

**把 iframe 高度设为 auto。** iframe 不会根据内部文档决定外部高度，仍然会保留与内容无关的视口。

**添加 iframe 测量脚本或同源访问。** 图表已经具备图片尺寸，不需要额外执行权限、来源权限或尺寸消息协议。

## Consequences

较矮图表只占据渲染高度与画布内边距。浏览器几何回归用例在浅色和深色下比较图片与容器高度，再验证窄视口中的等比例缩放。浏览器安全检查包含 SVG 脚本、事件处理器、嵌套 HTML 与外部图片，并保留复制和源码切换覆盖。HTML 自动高度不属于本次改动，因为任意文档布局具有不同的测量与隔离要求。
