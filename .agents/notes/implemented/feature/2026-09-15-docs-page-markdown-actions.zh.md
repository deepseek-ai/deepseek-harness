# Agent Note: 文档站页面 Markdown 操作

Status: implemented

[English](2026-09-15-docs-page-markdown-actions.md) | 中文

## 问题

读者需要可见的入口来获取单页文档的 Markdown。发布的文本必须保留当前语言和投影后的链接。浏览器请求在开发环境中还与 Vite 页面模块导入共用 URL，因此将所有 Markdown 请求都作为原文处理会破坏导航。

## 决策

[投影器](../../../../scripts/project-doc-site.ts) 根据发布 manifest（元数据清单）为普通内容页提供 `rawMarkdownPath`。[主题](../../../../website/.vitepress/theme/index.ts) 将该路径与站点 base 组合，在正文上方提供复制和查看操作。目录页使用完整的 `index.md` 路由，使相对链接在开发环境和静态构建中保持相同的位置。首页重定向和缺失页面不显示操作。原文输出不包含投影元数据。

服务端渲染的页面提供原文链接。客户端挂载后将其替换为复制按钮和菜单，使 MPA 构建及未运行 JavaScript 的页面保留可用操作。主按钮直接复制页面，并通过 `aria-disabled` 和 `aria-busy` 在复制期间保留键盘焦点。旁边的展开按钮打开带图标、操作标题和说明文字的菜单，使常用操作保持可见，并将 Markdown 选项放在一起。菜单项支持方向键、Home、End 和激活操作；Escape 将焦点恢复到展开按钮，外部指针操作和焦点离开会关闭菜单。菜单按下时保留焦点直至点击执行，也适用于按下控件时不转移焦点的浏览器。菜单状态及其外部指针监听器归属于页面实例。

[开发中间件](../../../../website/raw-markdown.ts) 接受带有显式 `?dsh-raw=1` 标记的浏览器请求，对未发布的原文路由返回 404。脚本导入始终交给 Vite。查看链接在新标签页打开普通原文 URL；复制按需读取相同的投影正文。生成的 Markdown 文件携带 UTF-8 BOM，因为静态托管可能省略响应字符集，导致浏览器直接访问时错误解码中文等非 ASCII 字符。Fetch 解码会在复制前移除 BOM。两种操作都不从渲染后的 DOM 重建 Markdown。

[复制组件](../../../../website/.vitepress/theme/page-markdown-actions.ts) 在点击手势内调用 `clipboard.write`，并提供由 Promise 承载数据的 `text/plain` ClipboardItem。先等待网络会在要求用户激活的浏览器中丢失该激活状态。每个路由和语言组合都有独立的、带 key 的组件实例，因此旧写入无法改变新页面的反馈。释放时取消未完成的数据读取。已经消费数据的系统剪贴板写入无法撤回。请求失败和剪贴板失败提供本地化的手动复制指引，成功提示在写入完成后显示。被拒绝的写入可能完全不消费数据 Promise，因此该 Promise 有独立的拒绝处理器。

## 考虑过的替代方案

**根据浏览器地址推导原文 URL。** 简洁 URL、目录索引、语言前缀和部署 base 使这种方式不如投影器已知的路由可靠。

**将所有 Markdown 请求都作为原文处理。** Vite 将相同的 URL 导入为 JavaScript 模块。显式请求标记区分原文获取，同时静态托管仍可直接返回已生成的文件。

**先获取正文，再调用 `writeText`。** 这种方式可能在 Chromium 中有效，但其他浏览器会在网络等待后丢失最初的手势。由 Promise 承载剪贴板数据可保留该手势，无需预取页面。

## 影响

自动复制接受 `text/markdown` 或 `text/plain` 响应。托管方必须为 `.md` 文件指定其中一种内容类型；缺失类型和 `application/octet-stream` 会触发失败及手动复制指引。白名单还会拒绝 HTML 回退页面和 JavaScript 页面模块。自动复制需要浏览器在安全上下文中提供异步 ClipboardItem 写入 API。写入不受支持或被拒绝时，查看链接仍可用于手动复制。页面复制状态是临时状态，归属于单一路由；它不创建 Session 数据或模型请求。

[组件测试](../../../../website/tests/page-markdown-actions.spec.ts) 在所属目录中固定本地化的可访问输出，并验证延迟读取、写入拒绝和导航时的资源清理。[中间件测试](../../../../website/tests/raw-markdown.spec.ts) 覆盖请求分发。两者都通过单元测试、`docs:check` 和 `doc-sync` 执行。[Mermaid 查看器决策](2026-09-14-docs-mermaid-viewer.zh.md) 保留独立的渲染与资源生命周期规则。

**CI 覆盖缺口。** DOM 测试模拟剪贴板，不执行原生用户激活规则、实际粘贴或响应式布局。因此仍需在开发服务和静态预览中进行浏览器验证，覆盖两种语言和站点 base。此静态文档功能不涉及真实模型轮次。
