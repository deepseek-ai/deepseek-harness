# Agent Note: 插件详细介绍文档

Status: implemented

[English](2026-10-15-plugin-detail-documents.md) | 中文

## 问题

插件卡片和页面只显示一行描述。用户从市场中选择插件，或查看某个已安装组合包（bundle）的用途时，需要包作者已经以 README 形式写好的、带截图的较长描述，与代码编辑器的扩展市场显示的内容相同。[市场索引](2026-10-02-plugin-market-index-format.zh.md)只携带列表字段，一份索引文档也无法为每个插件携带一份 Markdown 文档及其图片。

DSH 自身各包的 README 是面向维护者的参考，而不是面向用户的介绍，因此作者需要一种方式，为每种语言指定一份单独的用户文档。包可能来自本地安装、公共 npm、其他注册表、公共 Git 主机，以及只有用户的 Git 凭据才能读取的私有仓库。

## 决策

详细介绍文档按固定顺序读取。对每个包，顺序首先是其 `locale/<language>.json` 中 `meta.detail` 为显示语言指定的 Markdown 文件，该语言没有时依次回退到更短的语言前缀，最后回退到英文；然后是包的 README。市场条目页面在此之后继续读取条目或其包所声明仓库目录中的 README，读取默认分支上的文件。[文档顺序](../../../../packages/util/plugin-detail/README.zh.md#document-order)属于无状态库 [`dsh-plugin-detail`](../../../../packages/util/plugin-detail/README.zh.md)，是包内各步骤的唯一定义；[`plugin-manager`](../../../../packages/boot/plugin-manager/README.zh.md#bundle-detail-documents) 和 [`plugin-market`](../../../../packages/boot/plugin-market/README.zh.md#plugin-detail-documents) 说明它们如何应用该顺序。

`meta.detail` 位于[插件展示元信息](../../../../docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)已经使用的 `locale/<language>.json` 文件中，没有包字段回退，并且只在读取详细介绍文档时读取，因此格式错误的值只让详细介绍的读取失败，插件的标题、描述和图标不受影响。包的 README 代替 npm 显示的 README，因为 npm 显示的就是已发布版本中的 README 文件。存在但读取失败的来源会带着原因终止读取，而不是继续尝试下一个来源，因此缺失的 `meta.detail` 文件或过大的仓库会被报告，而不是被另一份文档替代。

**插件**页的组合包页面由 `plugin-manager` 负责，不需要市场：`readBundleDetail` 从已安装组合包的目录读取文档，不访问网络，也不缓存；当前安装提供、尚未安装的官方组合包按其提供的版本从 npm 文件 CDN 读取。其图片路由在每次请求时解析组合包和文档，因此 Host 不保留状态。组合包页面在其各部分中首先显示该文档。

由 Client 选择一次读取先请求哪些 npm 文件 CDN：它询问插件页现有的注册表比较，并传入 `npmFileSources`，例如 npmmirror 响应最快时传入 `['npmmirror']`。Host 按该列表排列其已配置的 CDN，且不请求配置未列出的 CDN，因此 Host 服务不依赖负责该比较的 Client 包。

市场条目页面由 `plugin-market` 负责，它读取条目版本的来源：公共 npm 版本从 npm 文件 CDN 读取，Git 版本从其固定的提交读取。仓库文件通过 GitHub 的原始文件主机和 GitLab 仓库文件 API 读取；一次不带任何凭据、发往该仓库 smart HTTP 端点的请求区分文件不存在与仓库需要凭据这两种情况，需要凭据的仓库以及所在主机没有 API 的仓库，从使用用户 Git 配置创建并缓存的部分克隆中读取。克隆是深度为 1 的裸仓库，在读取文件前不包含文件内容，按单条命令和总量限制大小，对其执行的操作失败或被取消时即被删除。http(s) 仓库 URL 的任何主机都可以克隆，可通过 https、http，或在 `url.<base>.insteadOf` 改写该 URL 时通过 ssh：Git 的凭据助手按主机给出凭据，因此克隆只向一个主机发送用户为该主机保存的凭据。条目页面先显示文档，然后是版本，然后是来源信息。两个页面都不为文档提供单独的标题；文档由其自身的标题命名。

Host 只读取它从已安装的包、已配置的索引、包 manifest 以及固定的 CDN 和 API 主机推导出的地址；客户端只指定一个组合包或一个索引条目，从不指定 URL。文档旁的图片由需要认证的 Host 路由提供，这些路由只接受文档根目录内的图片类型，并带有 sandbox CSP，使直接打开的 SVG 无法在 API origin 上运行。Markdown 通过共享的 `DetailDocument` 原语渲染，该原语省略原始 HTML，而不是将其显示为原样文本，因为 README 中的 HTML 是供 HTML 渲染器使用的排版，以文本形式显示时只会干扰阅读；绝对 HTTP(S) 地址的图片由浏览器不带 referrer 加载，相对链接保持为文本。

## 考虑过的替代方案

**通过插件市场提供组合包详细介绍。** 早先的设计在 `plugin-market` 中读取组合包文档，并通过 `plugins.detail.section` 提供它们，因此关闭市场组合包时组合包页面不显示任何内容，且每次组合包读取都经过市场的缓存。已安装的包是不需要缓存的本地文件，因此由 `plugin-manager` 使用共享库直接读取。

**克隆主机允许列表和只允许 https 克隆。** 凭据助手、钥匙串和 `.netrc` 已经按主机限定凭据，因此指定未知主机的市场不会得到其他主机的凭据；允许列表只会阻止合法的内网仓库。

**在索引格式中加入详细介绍字段。** 生成器可以发布文档 URL，但这样 Host 就会获取市场选择的地址，而且索引仍然无法携带图片或私有文档。

**下载 npm tarball。** tarball 适用于所有注册表，但为了读取一个文件要下载整个包；CDN 按精确版本提供单个文件。其他注册表的包改为从条目的仓库读取。

**通过 Host 代理绝对地址的图片。** Host 会从用户的机器获取文档作者选择的 URL，包括内网和回环地址。由浏览器加载可以让 Host 避开这一风险，代价是向图片主机暴露用户的 IP 地址。

**渲染原始 HTML，以及可点击的相对链接。** 许多 README 使用 HTML 排版，但渲染它需要清理不可信的标记，因此省略它；相对链接需要为每种来源提供跳转目标。两者都已延后。

**完整克隆或按 blob 大小限制的克隆。** 完整克隆会下载大型仓库的每个文件，按 blob 大小限制仍会下载每个小文件。深度为 1 的部分克隆只下载提交和树对象，并只获取文档读取的文件。

## 后果

- 作者在 `meta.detail` 下为每种语言编写一份用户文档；其他包显示其 README。
- 没有 `meta.detail` 也没有 README 的已安装组合包不显示文档；其声明的仓库只在市场条目页面上读取。
- 仓库 README 读取的是默认分支上的文件，可能与列出的版本不一致。
- 公开 GitHub 或 GitLab 仓库中第一次遇到缺失的文件时，需要发送一次匿名的 smart HTTP 请求，其结果缓存 `cacheTtlMs`。
- 用户的 Git 凭据能访问该主机时，即可读取私有仓库。
- 单元测试使用真实的本地仓库，覆盖文档顺序、CDN 回退、API 与克隆读取、大小限制、淘汰和图片路径；真实组合测试通过 `plugin-manager` 读取已安装组合包的本地化文档，通过 `plugin-market` 读取市场条目的文档，并通过组合后的 profile 提供其图片。
