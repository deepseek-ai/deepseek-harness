# Agent Note: 文档站点自带图片

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-doc-site-carries-its-images.md) | 中文

## 问题

`scripts/project-doc-site.ts` 会把发布 manifest（元数据清单）未收录的仓库相对目标一律改写成 GitHub 地址，对图片而言就是 `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`。站点构建不拷贝任何文件：`srcDir` 是用完即弃的 `.generated` 树，VitePress 没有设置 `publicDir`（其默认值 `<srcDir>/public` 恰好位于投影每次运行时删除的那棵树里），而写进去的只有 Markdown。

这只对公开仓库成立。本仓库是私有的，而 `raw.githubusercontent.com` 对未认证请求一律回 404——github.com 上的登录会话也不能认证它，因为 GitHub 自家界面是用另一套单独签名的地址提供私有 blob 的。于是站点上的每一张图片对每一位读者都是坏的，却没有任何门禁能说出来：`verify-md-links` 与投影校验的是目标文件**在仓库里是否存在**，那与站点读者能否取到它是两个问题。

## 决策

`rewriteMarkdown` 新增可选的 `placeImage(absPath): string`。当页面引用了一张 manifest 未作为页面发布的图片时，投影把该文件复制进生成树中该页面的旁边，并把引用改写为 `./<basename>`；随后 Vite 会像处理其他站点资源一样打包它。仓库可见性再也影响不到已发布页面。

副本落在页面旁边，而不是某个共享资源目录。每个 locale 的路由树各持一份副本，因此同一个相对 URL 在 `guide/` 与 `en/guide/` 下都正确，无需按 locale 计算前缀；manifest 撤下某页时，它的资源也随之消失。一张表登记所有被投影的路径——页面与图片一视同仁——同一路径出现第二个来源就抛错，与既有的重复路由检查同一个立场，而不是让最后写入的那个静默胜出。

只有真实路径位于仓库内的普通文件才会被拷贝，其余一律让投影失败并点名页面与目标。链接改写只需要知道目标**存在**，但发布是把它的字节拷上站点，因此一个逃出仓库的引用——经由 `../..` 或指向树外的符号链接——会把构建机上的文件放到已发布页面上。引用自带的 `?query` 或 `#fragment` 会随安置后的 URL 一同保留，与 GitHub 分支一贯的做法一致；文件名做百分号编码，因为目标位于 Markdown 内联目标的位置。

`docsSourceFiles()` 会连同被安置的图片一起上报，于是替换截图时开发服务器的 watcher 会重新投影，而不是一直服务旧副本直到有人碰一下页面。

`placeImage` 之所以可选，是因为 `rewriteMarkdown` 也被它自己的 spec 直接调用，而那里并不存在生成树。不传它时，GitHub raw 回退会指向公开源主页；这让该 seam 对只改写文本的消费方保持诚实。

正本 Markdown 照旧写普通的仓库相对图片路径，因此同一份文件在 GitHub 上和站点上都能正常显示。没有任何文档为了迁就 VitePress 而写站内绝对 URL。

## 考虑过的替代方案

**把 `publicDir` 设到 `.generated` 之外，并使用站内绝对 URL。** 投影这边的活动部件更少，但同一份 Markdown 在仓库中阅读时，每一处图片引用都会是坏的，而正本文档是两种方式都要读的。

**把图片放到 assets 分支，就像演示 GIF 那样。** 那个分支的存在是为了让大体积二进制不进主线历史，而它的 raw 地址有着完全相同的可见性问题。它仍然是录屏的正确归宿；但它解决不了这件事。

**等仓库转为公开。** 那只是消除症状，不会让站点自给自足，而且每一张图片都会让站点隐式依赖 GitHub 的可用性与限流。

## 后果

已发布文档中的图片，现在无论谁在阅读、无论仓库是否公开都能显示，站点构建也不再为图片依赖 GitHub 的运行时可达性。生成树会为每个 locale 各增加一份被引用图片的副本——模型提供方指南里的四张截图，每个 locale 约 270 KB。

**未发布**文档引用的图片不受影响。纯文本投影会相对于公开源主页解析它们；不在站点上的文档没有站点构建可以承载其资源。

## 测试

`scripts/project-doc-site.spec.ts` 覆盖：placer 收到解析后的绝对路径且其返回的 URL 落进 Markdown、被安置的引用保留其 fragment、存在 placer 时已发布页面的链接仍解析到自己的路由、以及不传 placer 时不变的 GitHub raw 回退。`publishableImage` 另有直接覆盖：仓库内的普通文件被接受，而目标逃出仓库的符号链接、仓库外的路径与目录一律拒绝。`pnpm docs:check` 会带着模型提供方指南的截图构建站点，并在来源缺失时失败；被拷贝的文件及其 `./<basename>` 引用已在 `website/.generated` 与运行中的 `docs:dev` 里核实（两个 locale 均 `naturalWidth > 0`）。
