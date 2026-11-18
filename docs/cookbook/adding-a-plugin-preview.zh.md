# Cookbook: 添加插件功能配图

[English](adding-a-plugin-preview.md) | 中文

功能配图是组合包详细介绍文档中的可选插图；详细介绍文档是该组合包在**插件**中的页面显示在描述下方的文档。为官方组合包绘制配图时遵循本指引。详细介绍文档本身通过 [`meta.detail`](adding-a-package.zh.md#plugin-display-metadata) 声明。

## 1. 判断是否需要配图

展示一个具体结果或容易辨认的能力。文字说明足够时省略配图：配图不是必需的。必要操作说明仍放在组合包描述或图外的配置中。

## 2. 绘制一张固定尺寸 SVG

| 项目 | 要求 |
|---|---|
| 数量 | 每个组合包零张或一张配图。英文和中文文件是同一张图的替代版本，不是图库或轮播。 |
| 格式 | SVG：`width="640" height="300" viewBox="0 0 640 300"`（32:15）。 |
| 语言 | 同时提供英文和中文文件。翻译标题、标注和示例内容，保留官方品牌素材和名称。 |
| 构图 | 一个主体示例，可选一个局部特写。重要内容距边缘约 32 个画布单位；按页面实际显示尺寸检查文字。 |
| 字体 | 选择合适字体并把文字转成路径，匹配功能及相邻界面，不依赖浏览器字体替换。 |
| 主题 | 对比浅色和深色主题。同一张图服务两种主题，避免透明底深色文字在深色背景中消失。 |

SVG 必须自包含：不使用字体、远程资源、脚本、事件处理器、动画、样式表、`text` 或 `foreignObject`。`image` 元素可以通过 base64 data URL 嵌入未改动的官方 PNG/JPEG/WebP 品牌素材。小插件图标仍仅使用几何图形。页面通过 `<img>` 渲染 SVG。每个文件都应控制大小；Host 会拒绝超过 plugin-manager 的 `detailImageMaxBytes`（默认 5 MiB）的图片。

## 3. 用它作为详细介绍文档

将这对文件保存为组合包中的 `docs/preview.svg` 和 `docs/preview.zh.svg`，与 `docs/DETAIL.md` 和 `docs/DETAIL.zh.md` 放在一起，并把图片作为每份文档唯一的一行：

```markdown
![Example feature preview](preview.svg)
```

中文文档引用 `preview.zh.svg`，并使用中文替代文字。可参考[徽章技能](../../packages/experimental/badge-skill-bundle/docs/DETAIL.md)和[语音输入](../../packages/experimental/voice-input-bundle/docs/DETAIL.md)文档。语音图中的转写文字是说明性示例，不是录音结果。组合包做什么、怎么用，按行为层面写在 `meta.description` 中，页面将其显示在配图上方。

## 4. 页面行为

| 项目 | 当前行为 |
|---|---|
| 位置 | 位于详细介绍文档开头；该文档是组合包页面的第一个区域，在描述和状态提示下方。 |
| 显示 | 详细介绍文档以不超过文档自身宽度的尺寸渲染图片，图片位于有高度上限的滚动区域内。 |
| 语言 | 当前 UI 语言对应的文档引用其自己的文件。 |
| 可用性 | 启用前可见；列表和组件行保留小图标。 |

## 5. 校验与验收

`scripts/plugin-preview-assets.spec.ts` 检查组合包 `docs` 目录中的每一对配图：固定画布；不使用脚本、样式表、`text` 元素或外部引用；每对文件合计不超过 1 MiB；英文和中文文件不相同。然后在真实插件详情页分别使用英文和中文，启用前确认图片能加载，并检查插入位置、浅色及深色主题的可读性，以及 390 px 宽度下没有横向溢出；审阅负责检查视觉质量及双语含义是否一致。按 [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md) 制作 PR 证据，从最终干净提交录制，并准确说明演示范围。
