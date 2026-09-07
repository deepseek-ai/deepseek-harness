# Agent Note: Web 安装 manifest 元数据

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-web-install-manifest.md) | 中文

## 问题

Web 构建产物已有文档标题和 favicon，却没有可供浏览器发现稳定安装身份、启动边界或安装后呈现方式的 manifest（元数据清单）。添加这类元数据也可能暗示应用并不具备的能力：service worker 会让人以为应用提供离线约定，而单一语言或调色板取值会错误描述这个能够解析浅色与深色主题的双语 UI。

## 决策

Web 入口链接 `/manifest.webmanifest`，Vite 会将其从 `apps/web/public/` 复制到生产构建产物。manifest 将产品命名为 `DeepSeek Harness`，为安装后的浏览器界面提供简称 `DSH`，并把 `id`、`start_url` 和 `scope` 固定为 `/`。它请求 `display: "fullscreen"`，使支持这一模式的浏览器能够把可用显示区域交给安装后的编辑器式界面，同时不改变普通标签页；浏览器可以应用用户覆盖设置，或回退到其他显示模式。其图标条目复用 `/favicon.svg`，将它作为尺寸为 `any`、用途为 `any` 的 SVG。

这一选择沿用了 code-server 的全屏方案，但没有照搬其 `window-controls-overlay` 显示覆盖项。DSH 没有自定义标题栏，也没有围绕原生窗口控件安排布局，因此使用这类覆盖项会在未落实所需安全布局的情况下取代全屏模式。

manifest 有意不包含 `lang`、`theme_color` 或 `background_color`。产品界面支持双语，并不由 manifest 中的单一语言定义；任一静态颜色值都可能与应用解析后的一套调色板不一致。因此，主题元数据仍放在安装 manifest 之外。

该功能不添加 service worker、缓存策略或离线回退。manifest 只提供安装元数据；是否具备安装资格、是否提供安装入口仍由浏览器策略决定。实际交付的 [`dsh-host-frontend-static`](../../../../packages/host/frontend-static/README.zh.md) 回退将 `.webmanifest` 识别为 `application/manifest+json`，因此同一资产经实际交付的 HTTP 组合提供时同样有效，而不只在 Vite 输出目录中有效。

## 验证

Web 构建产物测试解析输出的 manifest，并固定完整的元数据对象，包括面向用户显示的名称、简称、图标、根路径身份、启动边界和显示模式，同时验证生产构建的 `index.html` 仍保留该链接。`dsh-host-frontend-static` 的真实 Loader 组合测试提供一个 `.webmanifest` fixture（测试前置数据），并固定其 `application/manifest+json` 媒体类型。

## 曾考虑的替代方案

**添加 service worker，并宣称应用支持离线。** 不予采纳，因为只缓存应用外壳，却不定义会话传输、失效策略、失败行为和升级语义，会形成具有误导性的不完整离线约定。

**声明单一的 `lang`。** 不予采纳，因为没有任何一种语言足以描述双语产品界面；省略该字段可避免声称安装后的体验由某一种区域设置独占。

**选择一组静态背景色和主题色。** 不予采纳，因为应用会在运行时解析浅色和深色调色板，因此选择任一固定值，都是明知它与其中一种受支持状态不符。

**立即交付光栅和可遮罩图标变体。** 在某个受支持的安装目标证明现有可缩放 favicon 无法满足其要求之前，不予采纳。新变体只是对 manifest 的增量扩展，并非公开当前身份的前提。

**只断言构建产物中的根路径字段和显示字段。** 不予采纳，因为产品名称、简称或图标被删除或更改，同样属于已交付安装体验的回归。任何 manifest 元数据发生变化时，测试都有意要求显式改动。

## 后果

支持这一机制的浏览器可以发现以根路径为作用域的稳定安装身份和全屏偏好，而应用无需承诺离线行为。在路径前缀下部署该构建产物时，必须同时重新审视绝对路径的 manifest 链接，以及身份、启动、作用域和图标 URL。日后可能因浏览器特有的图标要求而新增变体；每一项有意的元数据变更都会同步更新精确的构建产物约定。
