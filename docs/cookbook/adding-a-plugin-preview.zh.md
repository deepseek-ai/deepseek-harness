# Cookbook: 添加内置插件功能配图

[English](adding-a-plugin-preview.md) | 中文

插件管理拥有内置组合包的可选功能配图。编辑其内部 `BUNDLE_PREVIEWS` 映射时遵循本指引。包不能通过 manifest 或 exports 声明配图；第三方插件没有配图接口。

## 1. 判断是否需要配图

展示一个具体结果或容易辨认的能力。文字说明足够时不添加映射项：配图不是必需的，省略时不占空间。必要操作说明仍放在图外的本地化文字或配置中。

## 2. 绘制一张固定尺寸 SVG

| 项目 | 要求 |
|---|---|
| 数量 | 每个组合包零张或一张逻辑配图。英文和中文文件是同一张图的替代版本，不是图库或轮播。 |
| 格式 | 仅 SVG：`width="640" height="300" viewBox="0 0 640 300"`（32:15）。不支持位图配图文件或其他尺寸。 |
| 语言 | 同时提供 `en` 和 `zh`。翻译标题、标注和示例内容，保留官方品牌素材和名称。不使用单个字符串、数组或额外语言。 |
| 构图 | 一个主体示例，可选一个局部特写。重要内容距边缘约 32 个画布单位；按页面实际显示尺寸检查文字。 |
| 字体 | 选择合适字体并把文字转成路径，匹配功能及相邻界面，不依赖浏览器字体替换。 |
| 主题 | 对比浅色和深色主题。同一张图服务两种主题，避免透明底深色文字在深色背景中消失。 |

SVG 必须自包含：不使用字体、远程资源、脚本、事件处理器、动画、样式表、`text` 或 `foreignObject`。`image` 元素可以通过 base64 data URL 嵌入未改动的官方 PNG/JPEG/WebP 品牌素材。小插件图标仍仅使用几何图形。此例外用于保留品牌素材，不允许直接使用位图配图文件。校验检查 data URL 结构，不解码像素；页面通过 `<img>` 渲染 SVG。两种语言的原始文件合计不超过 1 MiB。图片会以 base64 data URL 嵌入插件管理 client bundle，因此应控制大小。

## 3. 注册内部双语配图

将 `<feature>-preview.svg` 和 `<feature>-preview.zh.svg` 放在[插件管理素材目录](../../packages/client/ui-plugin-manager/src/client/assets/)下。在 [PluginManagerPage.tsx](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) 中导入两者，再向 `BUNDLE_PREVIEWS` 添加一个精确的内置包名：

```ts ignore-check
import examplePreview from './assets/example-preview.svg'
import examplePreviewZh from './assets/example-preview.zh.svg'

// One entry in the existing Map<string, Readonly<Record<'en' | 'zh', string>>>.
['@deepseek-ai/dsh-example-bundle', { en: examplePreview, zh: examplePreviewZh }]
```

保留映射中必需的 `en` 和 `zh` 类型。不添加包元数据、Host 读取方法、导出的配图资源或第三方声明入口。可参考[徽章技能](../../packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.svg)和[语音输入](../../packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.svg)配图。语音图中的转写文字是说明性示例，不是录音结果。

## 4. 保持页面契约

| 项目 | 当前行为 |
|---|---|
| 位置 | 在描述和状态提示下方、组件与来源信息上方，与说明左边缘对齐。 |
| 间距 | 图片上方 24 px，后续详情区前 32 px。 |
| 显示 | 一个 `<img>`，原始画布 640×300，最大宽度为可用宽度，最大高度 320 px，等比缩放；页面提供边框及 16 px 圆角。 |
| 语言 | 当前 UI 语言选择必需的两份文件之一；替代文字使用本地化插件名。 |
| 可用性 | 启用前可见；解码失败显示本地化提示，不阻塞操作；列表和组件行保留小图标。 |

## 5. 校验与验收

运行 `pnpm exec vitest run scripts/builtin-plugin-preview.spec.ts packages/client/ui-plugin-manager/tests/components.client.spec.tsx scripts/client-bundle-css.spec.ts`，再运行 `pnpm run build`。素材测试检查每个注册条目的双语文件、固定 SVG 尺寸、自包含内容和合计大小；类型检查要求同时提供两种语言。这些检查约束格式；视觉质量及双语含义一致仍需人工审阅。

在真实插件详情页分别使用英文和中文，启用前解码图片，确认原始尺寸 640×300、插入位置、浅色及深色主题的可读性，以及 390 px 宽度下没有横向溢出。同时检查一个无配图的内置插件和一个第三方插件。按 [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md) 制作 PR 证据，从最终干净提交录制，并准确说明演示范围。
