# Agent Note: 将权威文档投影到网站

Status: implemented
Archived: 2026-09-04

[English](2026-07-13-documentation-site-projection.md) | 中文

## 问题

仓库需要一个可导航的文档网站，但不能让网站目录成为第二个文档源。把包指南、架构页面或生成目录复制到网站专用目录树，会使两份副本发生漂移；让 VitePress 直接指向仓库根目录，又会把公开 URL 和导航与内部文件布局耦合。仓库相对链接在网站上也需要指向不同位置：已发布页面应留在站内，源文件和未发布的贡献者文档则应指向 GitHub。

## 决策

权威 Markdown 保留在其所属的仓库层级中。面向产品的指南位于 `docs/user/`，生成的参考资料保留在现有生成目录中，架构页面和实操手册（cookbook）页面也保留在现有的 `docs/` 路径。

`website/docs.ts` 是一份显式的发布 manifest（元数据清单）。每个条目将一个权威源文件映射到稳定的公开路由、侧边栏、分区和顺序。因此，新增或移除已发布页面是一项可评审的 manifest 变更，而不是隐式目录扫描的结果。

在 VitePress 启动或构建之前，`scripts/project-doc-site.ts` 会把 manifest 投影到被忽略的 `website/.generated/` 目录。生成目录树遵循公开路由，使 VitePress 导航、locale 检测和本地搜索使用同一套路由命名。每个页面都会获得一个指向其权威仓库文件的 `editSource` frontmatter 字段；编辑链接回调只读取该页面的数据，因此公开 URL 与源文件布局彼此独立。

各 locale 的首页投影只保留权威 YAML frontmatter。面向仓库的正文保留其 H1 和双语源文件链接；frontmatter 实现[保持 locale 不变的快速开始重定向](../../../../docs/user/index.zh.md)，网站导航负责切换 locale。

投影器解析 Markdown 链接，但不会重新序列化文档。指向另一个已发布源文件的链接会变成站内相对路由；指向未发布仓库文件的链接会变成 `deepseek-ai/deepseek-harness` 仓库主页下的源文件链接；仓库图片会被拷贝进生成树并从那里引用（[原因](2026-08-06-doc-site-carries-its-images.zh.md)）。相对目标不存在时，投影会失败。单元测试会锁定这些转换行为，`docs:check` 则运行投影器测试和 VitePress 生产构建，并将二者纳入 `doc-sync` 和并行文档门禁。

`verify-public-repository-links` 会拒绝已跟踪文件中指向不可用旧仓库的引用。源文件链接和编辑链接使用当前仓库主页。

`website/AGENTS.md` 是网站子树中唯一维护的 Markdown 文件。投影器测试会枚举所有已跟踪文件和未被忽略的未跟踪文件，并拒绝网站中的任何其他 Markdown，因此网站专用的 locale、路由、API 或生成源文件副本无法绕过发布 manifest。

Mermaid 渲染权威图表。网站工作区显式声明 `vitepress-plugin-mermaid` 要求 Vite 预打包的 5 个包，因为 pnpm 的严格依赖隔离会使本地开发服务器无法使用这些传递依赖。

配置后的 Markdown 渲染器会在单次构建期间缓存非 Mermaid、非 snippet 代码围栏，缓存键包含确切正文、info string、分隔符和 token 属性。双语投影中约半数代码围栏是重复内容，因此 Shiki 只渲染一次每种不同表示。Mermaid 围栏不会进入缓存，因为插件输出包含 token 位置 id；VitePress snippet 则在渲染期间解析源文件。缓存仅在生产构建中启用，每次构建后会随渲染器一同丢弃，并且不会改变生成的围栏 HTML。

网站发布与网站构建保持分离。专用 GitHub Actions 工作流运行现有文档门禁，将 `website/.dist` 作为 Pages 产物上传，并只在构建成功后部署。`actions/configure-pages` 在构建时向 VitePress 提供目标位置的 base path，因此私有 Pages 源站、未来的公开项目路径和自定义域名不需要各自的检入配置。Pages 可见性仍是仓库托管设置，而不是工作流权限。

## 考虑过的替代方案

**在 `website/` 下提交复制的 Markdown。** 这种方式让 VitePress 设置更直接，但每份复制的指南或 API 表格都会多出一个归属方，并且需要一套无法识别权威副本的同步约定。

**让 `website/` 成为每个已发布页面的权威归属。** 这种方式仍只有一份副本，却只是为了满足渲染器，就把架构、生成的参考资料和面向贡献者的材料移出了各自的仓库归属层级。

**自动发现所有 Markdown 文件。** 这种方式最大限度减少 manifest 维护，却会意外发布内部文档、把源文件移动暴露为 URL 变更，并根据偶然的目录顺序生成导航。

**使用文件系统符号链接。** 符号链接保留单一来源，却无法解决公开路由或仓库相对链接问题，而且在本地开发、包工具和托管 CI 环境中的行为不够可预测。

**只在部署工作流中构建。** 部署作业可以在合并后发现渲染故障。把生产构建纳入 `doc-sync`，则无论是否存在公开部署，同一个故障都能在本地和常规 CI 中暴露。

**硬编码公开项目路径。** 固定的 `/deepseek-harness/` base 适用于公开项目 URL，却不适用于私有 Pages 站点分配的唯一源站，也不适用于未来的自定义域名。使用 Pages 元数据可让这些目标位置共享同一份构建约定。

## 后果

文档事实只有一个可编辑归属，公开路由在源文件移动后仍保持稳定，网站也能纳入生成的参考资料而无需提交另一份生成副本。本地开发会监视权威输入并重新生成一次性投影。布局门禁会把陈旧的网站专用 Markdown 目录树变成合并失败，而不是被忽略的构建输入。向 Pages 的发布以从发布 tag 手动 dispatch 的方式运行，因此站点呈现的是已发布快照而非当前的 master（[原因](2026-08-21-documentation-site-tag-release.zh.md)）。

发布 manifest 是一份需要维护的 allowlist，链接投影也引入了一层仓库专用的构建适配器。新增一种 Markdown 链接行为时，需要增加投影器测试。Mermaid 支持也会增大客户端 bundle，但能保留权威文档中已经使用的图表。
