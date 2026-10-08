# Agent Note: 发布源码与文档

Status: implemented

[English](2026-10-08-published-source-and-docs.md) | 中文

## Problem

已发布的 `@deepseek-ai/dsh-*` 包带有声明文件、打包后的运行时和 locale 资源，却没有声明文件所描述的 TypeScript 源码。它的 `exports` 仍然声明了 `./src/*`，于是已安装的消费方把该子路径解析到 tarball 中并不存在的文件。插件作者若想看到某个已记录 API 背后的实现，只能读声明文件、文档网站，或检出匹配的 `dsh-v*` tag：第一种停在声明处，后两者都不是已安装的版本。仓库的 Markdown 文档也只能通过网站到达读者，而网站跟随的是已发布版本。

## Decision

每个发布成员都发布自己的 TypeScript 源码，以及能解析到该源码的声明映射；`@deepseek-ai/dsh` 另发布仓库的 Markdown 文档。

[`expectedDshPackageFiles`](../../../../scripts/check-workspace-constraints.ts) 在声明之后列出 `lib/types/**/*.d.ts.map`，并把 `src` 列在最后；带 Typert Remote 导航的包还会列出 `lib/typert.remote-client.d.ts.map`，其生成的声明通过 `sourceMappingURL` 引用该映射。[`isForbiddenPublicationFile`](../../../../scripts/publication-payload.ts) 只拒绝打包后的 JavaScript map，因此这两项新增内容都能通过静态 manifest 检查与发布族的 tarball 打包检查。332 个发布成员中已有 315 个声明过 `./src/*`，该导出对已安装的消费方开始真正解析。

`@deepseek-ai/dsh` 通过 [`scripts/stage-dsh-docs.ts`](../../../../scripts/stage-dsh-docs.ts) 在自己的 `prepack` 生命周期里把仓库的 `docs` 树暂存到 `apps/cli/docs`。暂存副本不包含 `docs/persistence-changes/`（其中的逐版本迁移记录已被当前契约取代），也不包含由文档门禁拥有的 `*.i18n.yaml` 一致性记录。图片以及其他面向读者的资产都会一并发布。

vendored 族保持上游 payload 不变；那些 manifest 由上游拥有，且它们导出 `./src/*`（[发布序列](2026-08-10-npm-release-sequences.zh.md)）。

桌面打包保留自己的[运行时文件策略](../../../../apps/desktop/scripts/runtime-file-policy.ts)，因此打包后的应用不含声明与声明映射，并携带它同样不会加载的 `src` 与暂存 `docs` 树。

## Alternatives considered

**保持只发声明文件，把读者引向文档网站或匹配的 `dsh-v*` tag。** 否决：两者都不是已安装的版本，而网站提供的是最新已发布版本而非预发布版本。声明的 `./src/*` 导出没有这些文件也毫无意义。

**只发布声明映射，不发布 `src`。** 否决：`sources` 不存在的映射解析不到任何东西，而这正是 [Typert Remote 设计](../architecture/2026-08-02-typert-remote-method-calls.zh.md)所要求的导航。

**随运行时 bundle 一起发布打包后的 JavaScript map。** 否决：那些是单产物构建，其 map 描述的构建树并未发布。

**把文档做成独立的 `@deepseek-ai/dsh-docs` 包。** 否决：这些内容本来就该待在每个人都会安装的命令旁边，独立成包会多出一个公开包和一个发布成员。

**把 `docs/persistence-changes` 与其余文档一起发布。** 否决：那些记录回答的是版本对比问题，其 16 MB 会主导整个 payload。

## Consequences

`src` 在整个发布集上增加约 29 MB，声明映射增加约 10 MB，暂存的 `docs` 树给 `@deepseek-ai/dsh` 增加约 6.7 MB。包 tarball 相应变大，桌面应用则携带它永不加载的 `src` 与 `docs`。

消费方编辑器现在可以从声明跳转到已安装的实现，插件作者无需检出即可读到该版本的源码与文档。暂存副本保留仓库的相对链接，因此从随包页面指向未随包目录的链接——`../packages/**`，或被排除的 `docs/persistence-changes/` 记录——只在检出中可解析。文档 payload 只对它随包发布的那个版本消除网站的版本偏差；当差异确实重要时，消费方仍应核对 `dsh --version`。

`pnpm run constraints` 会拒绝 `files` 中缺少 `src` 或任一声明映射的发布成员，因为该清单是精确匹配的。发布族的 tarball 校验会拒绝打包后的 JavaScript map，并要求 `@deepseek-ai/dsh` 必须带上文档与源码，因此跳过暂存钩子的打包会直接失败，而不是发出一个缺少它们的包。
