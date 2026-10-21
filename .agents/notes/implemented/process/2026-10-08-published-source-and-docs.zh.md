# Agent Note: 发布源码、映射与文档

Status: implemented

[English](2026-10-08-published-source-and-docs.md) | 中文

## Problem

已发布的 `@deepseek-ai/dsh-*` 包带有声明文件、打包后的运行时和 locale 资源，却没有声明文件所描述的 TypeScript，也没有能解析到它的映射。它的 `exports` 仍然声明了 `./src/*`，于是已安装的消费方把该子路径解析到 tarball 中并不存在的文件。插件作者若想看到某个已记录 API 背后的实现，只能读声明文件、文档网站，或检出匹配的 `dsh-v*` tag：第一种停在声明处，后两者都不是已安装的版本。仓库的 Markdown 文档也只能通过网站到达读者，而网站跟随的是已发布版本。

## Decision

每个发布成员都发布自己的 TypeScript 源码、能解析到该源码的声明映射，以及紧挨所描述 bundle 的 JavaScript map。`@deepseek-ai/dsh` 另发布文档网站的页面集合外加升级指南，构建也会压缩产出的 bundle，但不混淆标识符。

[`expectedDshPackageFiles`](../../../../scripts/check-workspace-constraints.ts) 列出 `lib/types/**/*.d.ts.map`、`lib/**/*.js.map` 与 `src`；带 Typert Remote 导航的包还会列出 `lib/typert.remote-client.d.ts.map`，其生成的声明通过 `sourceMappingURL` 引用该映射。没有任何载荷成员被禁止，发布清单由静态 manifest 检查精确持有。332 个发布成员中已有 315 个声明过 `./src/*`，该导出现在解析到这些文件，服务于编辑器导航与阅读；纯 Node 仍需 TypeScript loader 才能 import 它们。

client 预设会压缩浏览器 bundle 的文本（`minify: { compress: false, mangle: false }`）。标识符保持原名，因此栈帧与已发布的 map 仍然指向原始代码。Node 侧入口不压缩：浏览器 worker 镜像只把 `yield*` 当作整条语句下沉，并按源码版式重写 `for await` 循环，压缩后的输入会同时破坏这两者。

`@deepseek-ai/dsh` 通过 [`scripts/stage-dsh-docs.ts`](../../../../scripts/stage-dsh-docs.ts) 在自己的 `prepack` 生命周期里把这一集合复制到 `apps/cli/docs`，并在 `postpack` 中再次删除这份副本。集合包含：网站清单中的 Markdown、`docs/upgrade-guide/` 下的全部文档，以及这些页面引用的非 Markdown 资产。暂存时还会生成 `docs/upgrade-guide/README.md`：按每个 `v<T>` 目录升级前的版本分组，列出每份指南的标题、中英文描述与两种语言的相对路径；仓库树本身不保留索引。生成的 `docs/persistence-changes/` 记录、`docs/i18n/` 规范与 `*.i18n.yaml` 一致性记录不发布。vendored 族保持上游 payload 不变（[发布序列](2026-08-10-npm-release-sequences.zh.md)）。

桌面版在 `app.asar` 内保留 `src/` 与 `@deepseek-ai/dsh` 的 `docs/` 树，agent 可在其中读取已安装版本的文档与代码；其[运行时文件策略](../../../../apps/desktop/scripts/runtime-file-policy.ts)仍剔除全部声明文件与映射。普通工具打不开归档内条目，因此 [`dsh-shell-env`](../../../../packages/shell/shell-env/README.zh.md) 为每次模型 shell 调用提供 `DSH_INSTALL_DIR`（`@deepseek-ai/dsh` 包目录）与 `DSH_NODE_EXECUTABLE`（运行 Harness 的可执行文件）；桌面版下它是 Electron，其 Node 模式（`ELECTRON_RUN_AS_NODE=1`）能读取归档。Python 单文件可执行体不付出代价：[`PUBLISHED_PAYLOAD_IGNORES`](../../../../scripts/build-exe-for-python-sdk.ts) 排除同样的树，因此其内容不取决于检出中是否残留暂存的 `docs`。

## Alternatives considered

**保持只发声明文件，把读者引向文档网站或匹配的 `dsh-v*` tag。** 否决：两者都不是已安装的版本，而网站提供的是最新已发布版本而非预发布版本。声明的 `./src/*` 导出没有这些文件也毫无意义。

**只发布映射，不发布 `src`。** 否决：`sources` 不存在的映射解析不到任何东西，而这正是 [Typert Remote 设计](../architecture/2026-08-02-typert-remote-method-calls.zh.md)所要求的导航。

**整树发布，或只发布网站页面集合。** 两个极端都否决。整树会把已安装读者并不需要的维护者材料发出去——事故复盘、测试指南、Agent 指令与生成的迁移记录；而只发网站页面集合会漏掉升级指南，也就是已发布改动造成破坏时读者真正要查的文档。

**连标识符一起混淆。** 否决：混淆会破坏已发布 map 本应提供的对应关系，并使未处理栈帧无法阅读。

**连 Node 侧入口一起压缩。** 否决：浏览器 worker 镜像拒绝压缩后的输入——打包器会拒绝被压缩器挪进表达式的 `yield*`，并且对 `dsh-agent-instructions` 产出无法解析的代码。这两条都是下沉变换的限制，不是体积上的理由。

## Consequences

`src` 在整个发布集上增加约 29 MB，声明映射增加约 10 MB，JavaScript map 增加约 49 MB，暂存的文档以 320 个文件给 `@deepseek-ai/dsh` 增加 6.4 MB。压缩让浏览器 bundle 约减少三分之一——`ui-chat` 的 `lib/client.js` 从 591 kB 降到 420 kB——而 Node 侧入口在 worker 镜像接受压缩输入之前保持原体积。macOS arm64 的 `app.asar` 增加约 20 MB `src` 与 5 MB 文档；Python 可执行体保持原有载荷。

消费方编辑器现在可以从声明跳转到已安装的实现，插件作者无需检出即可读到该版本的文档。暂存副本保留仓库的相对链接，因此指向 `../packages/**` 或指向被排除的 `persistence-changes/` 记录的链接只在检出中可解析。`docs/` 只在 `prepack` 与 `postpack` 之间存在于工作树，`pnpm run clean` 会清掉被中断的打包留下的副本。

`pnpm run constraints` 会拒绝 `files` 中缺少 `src` 或任一声明映射的发布成员，因为该清单是精确匹配的。发布族的 tarball 校验要求 `@deepseek-ai/dsh` 必须带上文档、升级指南索引与源码，因此跳过暂存钩子的打包会直接失败，而不是发出一个缺少它们的包。
