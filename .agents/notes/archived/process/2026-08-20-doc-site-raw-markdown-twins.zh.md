# Agent Note: 文档站的纯 Markdown 孪生页与 llms.txt

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-doc-site-raw-markdown-twins.md) | 中文

## Problem

文档站只提供渲染后的 HTML，agent 读文档要么抓取 VitePress 标记，要么退回仓库源文件，而后者的链接和图片引用跟随源码布局而非公开路由。Claude 平台文档确立了本特性采纳的约定：任意页面 URL 加 `.md` 后缀即得到该页的原始 Markdown，站根 `llms.txt` 作为面向 agent 的索引。[站点投影](2026-07-13-documentation-site-projection.zh.md)本就为公开站点重写每页链接，缺的只是把这份投影以纯 Markdown 形式对外提供。

## Decision

`vitepress build` 结束时向构建输出发射每个已发布路由的纯 Markdown 孪生页。`emitRawMarkdownPages` 复用填充 `website/.generated/` 的同一趟 manifest 加投影器流程，但以原始页面内容写入 `<outDir>/<route>`：不带 `editSource`/`outline` 投影 frontmatter，不做 locale 首页截断——frontmatter 是 VitePress 的渲染配置，孪生页丢弃它并保留正文——仓库版式（语言切换行、徽章）的剥离与渲染站一致。页面引用的图片复制到孪生页旁边。

一份投影同时服务两棵树，因为站内链接是相对路径。`./sibling.md` 在 HTML 站渲染为 clean URL，在原始树中按文件对文件解析，孪生页不需要第二套链接改写模式。所有路由都被发射，包括仅有 frontmatter 的 locale 首页：已发布页面链接到它们，原始树必须保持链接封闭；一个 spec 遍历发射树中的每条相对链接来钉住这条闭合性。

index 路由在渲染站上呈现为目录 URL，"加 `.md`"在去掉末尾斜杠后落在 `<dir>.md` 上；因此每个 index 路由还发射一个父级别名孪生页。别名不是拷贝——拷贝的 `index.md` 会让相对链接整体上移一层——而是以别名 route 为基准的独立投影，链接解析仍针对 canonical manifest，始终指向 canonical 孪生页。根首页没有可放别名的父级；`/` 在文档中写明用 `/index.md`。

每个生产构建入口都会解析 VitePress 配置，要求 `outDir` 必须是站点根目录的严格子目录，并要求它最近的现有父目录必须解析到站点根目录的真实路径以内。构建会直接解除链接型输出而不遍历其目标，并在打包前删除真实输出目录。由项目负责的这一步覆盖了不会清空最终输出目录的 MPA 构建，并避免被移除的路由或资产在重新构建后残留。随后的原始孪生页发射会把当前 VitePress 构建创建的文件视为已占用：孪生页或图片一律不得覆盖这类文件（例如 `public/` 副本），同名冲突会使发射失败。

`llms.txt` 由发布 manifest 生成于站根：两棵语言树按侧边栏顺序排列，每页一行 `- [label](<base><route>): <section>`，链接为携带部署期 `DOCS_BASE` 的站内绝对路径。locale 首页不列入——这个文件本身就是 agent 的入口。

开发服务器对导航与无头客户端提供同一表面。doc-projector 插件中的 middleware 逐请求从 canonical 源投影 `.md` 请求并按需生成 `llms.txt`，`docs:dev` 无需重建即与线上一致；页面内 `fetch()`（`Sec-Fetch-Dest: empty`）在 dev 下刻意仍交给 Vite，而生产静态托管对它返回原始文件。

构建后门禁 `verify-doc-site-fragments` 在任一路由的孪生页或 `llms.txt` 缺失时判定构建失败，删掉 `buildEnd` 接线无法通过 CI。

## Alternatives considered

**`vitepress-plugin-llms`。** 维护活跃、MIT 协议，Vite、Vue、Vitest 官方站点在用；能生成每页 Markdown、`llms.txt`、`llms-full.txt` 和开发服务器响应。但两个硬编码行为在本站产生破坏。它把 `dir/index.md` 展平为 `dir.md` 且无法关闭，同时不改写页内链接，所有指向栏目落地页的相对链接全部 404——本站每个语言树发布七个 index 路由。它还把图片引用改写为不带站点 base 的根绝对哈希资产路径，在本站的子路径 GitHub Pages 部署下必然 404；其采用者都部署在域名根，两个问题都碰不到。其 `llms.txt` 只认顶层 theme 配置的侧边栏，认不出本站按 locale 存放的侧边栏。修正这些意味着 fork 或一层耦合插件内部行为的后处理——比复用已测投影器的小发射器拥有更多自有面积。

**经 Vite `publicDir` 发射。** Vite 只支持一个 public 目录，本站已将其指向被跟踪的 `website/public/`；生成的孪生页会落入布局门禁禁止的跟踪树。

**孪生页内用绝对链接。** platform.claude.com 用绝对链接是因为其主机固定。本站 base 在本地 `/` 与 Pages 子路径之间变化，而投影器的相对链接在两棵树中原样可解析，绝对化改写只会引入第二套链接语法而不改善解析。

**原始树跳过 locale 首页。** 已发布页面链接到 `docs/user/index.md`，省略首页路由会破坏链接封闭。剥离版式后剩下的正文（即 H1）成本为零，重定向 frontmatter 在 VitePress 之外没有意义。

## Consequences

Agent 把页面 URL 去掉末尾斜杠再加 `.md` 即获取该页纯 Markdown，并在 `/llms.txt` 发现全集；渲染站不变。构建输出为每个路由多带一个 Markdown 文件、每个 index 路由多带一个别名，外加旁置图片副本——相对打包资产只是千字节级。孪生页保留 GitHub 风格的标题文本，而渲染站对含标点的标题使用不同 slug；agent 自行解析标题，因此没有门禁覆盖原始树的 fragment。因孪生页受众不需要而暂缓：`llms-full.txt`，以及每页的"查看 Markdown"控件——后者需要 stock-theme 站点刻意不设的 theme 目录。
