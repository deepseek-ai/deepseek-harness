---
description: "读取用户配置的插件索引的 Host 服务，提供安装状态、兼容性以及只读的 plugin_market 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-market

[English](README.md) | 中文

## 概述

`pluginMarket` 读取用户配置的插件索引，用 [`dsh-plugin-market-index`](../../util/plugin-market-index/README.zh.md) 校验，并为每个条目标注 profile 中的安装状态、DSH 兼容性以及安装它所需的精确参数。它还为发现区的条目页面读取每个索引条目的详细介绍，即一份带图片的 Markdown 文档。Web 的[发现标签页](../../client/ui-plugin-market/README.zh.md)和 `plugin_market` agent 工具通过它读取；安装本身经由 [`pluginManager.installBundle`](../plugin-manager/README.zh.md) 进行。格式及其理由见[索引格式 Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)；Host 与 Web 的设计见[发现 Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

可选的[自定义插件索引组合包](../../experimental/plugin-market-bundle/README.zh.md)把该服务挂载为 `plugin-market` 行；随附的 profile 默认不启用该组合包。与 `plugin-manager` 一样，该行在没有 profile 时被禁用，并等待 `pluginManager`。默认不配置任何索引源，因此在用户添加索引源之前，Host 不发送任何索引请求。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `indexes` | `[]` | 按显示顺序排列的索引 URL。可用的 URL 采用规范形式，使用 `http:` 或 `https:`，不含凭据或片段。该字段是 volatile 字段：发现区、设置和 `setIndexes` 修改它时，不会重新挂载本服务或 `plugin-manager`。 |
| `fetchTimeoutMs` | `15000` | 单次索引获取（包括响应体）的时限。 |
| `maxBytes` | `134217728` | 接受的最大索引响应体。 |
| `cacheTtlMs` | `600000` | 成功读取的索引文档、详细介绍的读取结果以及仓库默认分支提交的缓存时长。 |
| `detailMaxBytes` | `1048576` | 详细介绍文档的最大大小，以及为读取它而读取的 locale 文件的最大大小。 |
| `detailImageMaxBytes` | `5242880` | 与详细介绍文档一同提供的图片的最大大小。 |
| `detailRepositoryMaxBytes` | `52428800` | 单条 Git 命令向一个部分克隆增加的最大数据量；获取时增加的数据量超过该值的仓库不被读取。 |
| `detailCacheMaxBytes` | `524288000` | 所有部分克隆的最大总大小；每次获取后，超出时删除最近最少使用的部分克隆。 |
| `detailCacheDir` | `.plugin-market/repositories` | 部分克隆所在的目录，相对于 profile 目录；服务在 dsh profile 之外运行时必须以绝对路径配置。 |
| `detailGitTimeoutMs` | `60000` | 克隆回退方式中单条 Git 命令的时限。 |
| `detailNpmFileSources` | `['jsdelivr', 'unpkg', 'npmmirror']` | 按顺序读取的 npm 文件 CDN；一次读取的 `npmFileSources` 把其中列出的 CDN 移到最前，本列表未列出的 CDN 不会被请求。 |
| `detailGitlabHosts` | `['gitlab.com']` | 通过 GitLab 仓库文件 API 提供公开仓库的主机，比较时不区分大小写。 |

设置和 profile 文件可以存储任意 http(s) 字符串，因此服务在列出或读取每个 URL 时校验它。`listIndexes` 报告不可用的 URL 及其拒绝原因，`search` 和 `entry` 拒绝该 URL，且不会向它发送请求；重复的 URL 只列出一次。

Remote 方法如下：

- `listIndexes()` 返回每个已配置 URL，以及其最近一次成功读取得到的标题和描述；最近一次读取失败时，还返回其错误。它从不发起获取。
- `setIndexes(urls)` 规范化并校验每个尚未配置的 URL，已配置的 URL 保持原样，拒绝重复的 URL，并通过 `settings.update` 把列表写入本服务的 profile 条目。没有 Settings 或 profile 条目时，以 `plugin-market/settings-unavailable` 失败。提交后的列表通过 `plugin-market/changed` 通告。
- `search(url, query)` 只接受已配置的 URL，因此服务从不获取任意地址。它返回匹配 `query` 的一页插件，并附带索引的标题、描述和声明、该文档的 `fetchedAt`、匹配总数 `total` 和 `nextOffset`；每个插件携带 `defaultVersion` 和 `installation`，每个版本携带 `install` 和 `compatibility`。
- `readEntryDetail(url, name, version, language, { refresh?, npmFileSources? })` 从已配置索引中某个条目的一个已列出版本的来源读取该版本的详细介绍：没有 `registry` 或使用 npm 或 npmmirror 注册表的版本从 npm 文件 CDN 读取，Git 版本从其固定的 Git 提交和 `path` 读取。来自其他注册表的 npm 版本没有可读取的包文件。

服务方法 `entry(url, name)` 不是 Remote 方法，它以相同形式返回已配置索引中的一个插件；索引未列出该插件时返回 `undefined`。

查询选出同时满足其全部条件的插件：

| 字段 | 含义 |
|---|---|
| `text` | 模糊匹配的词，见下文。不含字母或数字的文本选出所有插件。 |
| `category` | 插件的分类 id。 |
| `labels` | 插件必须全部具备的标签 id。未声明的分类或标签 id 不匹配任何插件。 |
| `sort` | `index` 为索引顺序；`relevance` 为文本匹配最好的在前，没有文本时为索引顺序；`published` 为最新发布时间；`key` 为已声明的排序键，缺少该值的插件排在最后。有方向的排序取 `asc` 或 `desc`，相同时保持索引顺序。未声明的排序键保持索引顺序。 |
| `offset`、`limit` | 页：`offset` 是非负整数，`limit` 是 1 到 100 的整数；其他值以 `plugin-market/invalid-query` 失败。 |
| `refresh` | 重新获取，而不使用缓存的文档。 |
| `fetchedAt` | 先前某页的 `fetchedAt`：只要该文档仍在缓存中，即使超过 `cacheTtlMs` 也用它回答，使后续页延续同一份结果。 |

文本匹配包名、作者、关键词，以及标题、描述、分类标题和标签标题的所有语言。文本被拆分为由字母、组合符号和数字构成的连续片段；由中文、日文或韩文字符构成的片段变为相邻的两字组合及其最后一个字符，因此不带空格书写的文本无需词典也能匹配。词在 NFKC 规范化后不区分大小写地比较。查询中的每个词都必须匹配某个已索引的词，可以是前缀，或者在词长至少四个字符时，编辑距离不超过其长度的五分之一（四舍五入），且最多为 2。名称和标题匹配的权重是其他位置的三倍，关键词匹配是两倍。

<a id="plugin-detail-documents"></a>
### 插件详细介绍文档

`readEntryDetail` 读取[文档顺序](../../util/plugin-detail/README.zh.md#document-order)的全部三步：先从条目版本的来源读取 locale `meta.detail` 文件和 README，再读取所声明仓库的 README。对 npm 版本，README 即 npm 为该版本显示的 README。`repository` 就是自身来源目录的 Git 条目跳过仓库这一步。locale 文件或 `meta.detail` 格式错误，或指定的文件不存在时，读取失败，而不是进入下一步。

三者都没有时，结果为 `{ status: 'none' }`。找到的文档携带其 `origin`（`locale`、`readme` 或 `repository`）、去掉开头 YAML front matter 块后的 Markdown 内容和 `document` id。结果，以及再次读取也会重复出现的 `too-large`、`denied` 和 `invalid` 失败，缓存 `cacheTtlMs`；传入 `refresh` 时改为重新读取；并发读取共享一次读取。只要每个 `cacheTtlMs` 内至少有一次读取返回某个 `document` id 或有一次图片请求引用它，该 id 就保持有效；未使用的 id 会被遗忘，在再次读取该文档之前，其图片请求返回 404。

`github.com` 上的仓库文件通过 GitHub 的原始文件主机读取，`detailGitlabHosts` 中主机上的仓库文件通过 GitLab 仓库文件 API 读取。API 请求跟随同一 origin 内的重定向。API 返回 401、403 或 404 时，由一次不带任何凭据、发往该仓库 smart HTTP 端点的请求判断仓库是否公开；公开仓库中未找到文件即表示该文件不存在。需要凭据的仓库，以及所在主机没有此类 API 的仓库，通过 https、http 或 ssh 从部分克隆中读取。Git 使用用户的配置、凭据助手和 `url.<base>.insteadOf` 规则，且不提示输入，因此 https URL 可能被改为通过 ssh 访问；除非设置了 `GIT_SSH` 或 `GIT_SSH_COMMAND`，ssh 以批处理模式运行。

`GET /api/plugin-market/detail-file?document=<id>&path=<destination>` 向已通过认证的 owner 连接提供已读取文档旁的图片。目标路径相对于该文档；以 `/` 开头时相对于包或仓库的根目录；路径中的查询和片段被忽略。只提供该根目录内的 PNG、JPEG、GIF、WebP、AVIF 和 SVG 文件，响应带有 `Content-Security-Policy: sandbox`、`X-Content-Type-Options: nosniff` 和时长为 `cacheTtlMs` 的私有缓存。文件不存在、文档未知或其他路径返回 404；下文所列的失败依次返回 413、502、403、503 和 400；失败响应不被缓存。

存在但无法读取的来源以 `plugin-market/detail-unavailable` 失败，并携带一个 `reason`：文档、图片或仓库超过其大小限制时为 `too-large`；来源无法访问或超时时为 `network`；Git 使用用户的凭据仍被仓库拒绝时为 `denied`；仓库必须克隆而 Git 无法运行时为 `git-unavailable`；locale 文件或 `meta.detail` 格式错误，或指定的文件不存在时为 `invalid`。未列出的条目或版本以 `plugin-market/unknown-plugin` 失败；无效的语言以 `plugin-market/invalid-query` 失败。Git 无法启动，以及本地 Git 命令失败（例如磁盘已满）时，读取失败且不带详细介绍的失败原因，也不被缓存。

失败使用 `plugin-market/invalid-query`、`plugin-market/invalid-index-url`、`plugin-market/unknown-index`、`plugin-market/fetch-failed` 和 `plugin-market/invalid-index`；最后一种携带违规值的 JSON 路径。

`plugin_market` 工具列出已配置的索引，按索引顺序分页列出某个索引的插件，或在给出 `query` 时按最佳匹配分页列出，或分页列出某个插件的版本。它不需要批准，因为它只读取用户配置的源且不做任何改动；它返回的每个版本都携带要传给 `plugin_manager` 的 `install_bundle` 的 `target` 和 `registry`，`install_bundle` 仍保留自己的批准要求。该工具不能修改索引源。Creator 模式在 `plugin_manager` 旁边保留它的行，该行只在 `pluginMarket` 已挂载时注册工具；其他预设保持禁用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

Host 使用进程的 `fetch` 获取，因此配置的出站代理生效，并拒绝重定向。响应体最多读取 `maxBytes`，随后由一个新的 Worker Thread 按严格 UTF-8 解码、解析为 JSON 并校验；相对图标引用基于配置的 URL 解析。响应体的缓冲区转移给 Worker，校验后的索引通过 structured clone 返回 Host。Worker 是自包含的 `lib/worker.cjs` bundle；销毁时终止它，Worker 失败报告为 `plugin-market/fetch-failed`。

对同一 URL 的并发读取共享一次获取。成功的文档缓存 `cacheTtlMs`；`refresh` 绕过缓存。每份获取到的文档都有新的 `fetchedAt`，缓存的文档在被之后的获取替换前，都可以按其 `fetchedAt` 回答。失败的读取为 `listIndexes` 记录错误消息，不保留文档。读取完成时其 URL 已不在配置中的，既不更新缓存也不更新错误。收到 `loader/volatile-update` 时，服务丢弃已移除 URL 的状态并发出 `plugin-market/changed`。销毁时中止进行中的获取。

过滤和排序只读取文档；安装状态和兼容性在每次调用时只为返回的页计算。一份文档上第一次带文本的查询使用 [MiniSearch](https://github.com/lucaong/minisearch) 构建其文本索引，每轮事件循环处理 500 个插件，之后的查询复用该索引，直到文档被替换。

兼容性按版本计算：使用 `evaluatePluginCompatibility`，传入该版本的 `engines.dsh` 和 profile 的版本豁免，与安装时执行的检查相同。插件的默认版本是其不带先行版本号的最高兼容版本；插件完全没有此类版本时，使用其最高兼容的先行版本；没有兼容版本的插件没有默认版本。安装状态按包名根据 `pluginManager.listBundles()` 计算，以默认版本为准，没有默认版本时以最高版本为准：`not-installed`（包括当前 profile 尚未安装的按需目录条目）；版本相同时为 `installed`；该版本更高时为 `update-available`；已安装版本未知、不是有效的 SemVer 或更高时为 `different-version`；DSH 安装随附的组合包（bundle）为 `provided`。

条目详细介绍的读取共用服务拥有的一个读取器；文档选择和 npm 文件 CDN 来自 [`dsh-plugin-detail`](../../util/plugin-detail/README.zh.md)。每个部分克隆是 `detailCacheDir` 下的一个裸仓库，以其 URL 的哈希命名，先在暂存目录中初始化，再重命名到目标位置，并使用 `--depth 1 --filter=blob:none` 获取，因此只下载提交和树对象；读取文件时 Git 才下载其内容。命令运行时不继承除 ssh 程序之外的 `GIT_*` 变量，禁用 hook、文件系统监视器、子模块递归，以及 https、http 和 ssh 之外的所有传输协议，且不创建工作树。Git 下载期间每 200 毫秒检查一次目录大小；单条命令执行期间增长超过 `detailRepositoryMaxBytes` 时停止 Git，且输出保留文件末尾的换行字节。文件内容超过本次读取的限制时，读取即停止；浏览器放弃请求时，图片读取仍会完成，因此离开页面不会中断克隆。`refs/dsh/` 下的 ref 记录每个已获取的提交，因此不会在没有大小检查的情况下延迟获取提交。对同一仓库的操作逐个执行，共享 `detailCacheDir` 的多个进程（例如同一 profile 上的 Web 和 Desktop）之间也是如此，由仓库旁的一个锁文件实现；淘汰只在这些操作结束后删除该仓库，并在每次获取和每次文件读取后执行 `detailCacheMaxBytes` 总量限制；正在使用的仓库单独超过该总量时，淘汰最后删除它，并等到其操作结束后再删除；除文件超过本次读取的限制外，任何原因导致操作失败或被取消时，都删除该仓库，使下一次读取从新的克隆开始。淘汰时还会删除存在时间超过 `detailGitTimeoutMs` 的暂存目录。销毁时停止 Git 并等待其退出。

`marketInstallTarget` 构建安装参数：npm 为 `name@version` 加该版本的 registry，Git 为 `git+<url>.git#<commit>`，包位于子目录时追加 `&path:/<path>`。

-----

<a id="model-experience"></a>
## 模型体验

### 市场列表工具

#### 模型看到什么

[`plugin_market` 工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plugin-market)返回 JSON：已配置的索引 URL 及其英文标题和最近错误，一页插件（按索引顺序，或给出 `query` 时按最佳匹配），包含名称、英文标题、描述和作者（各截断为 300 个字符）、主页、仓库、分类、标签 id、排序键值、安装状态、默认版本和版本数量，或者某个插件的一页版本。返回的每个版本都携带 ISO 发布时间、兼容性和安装参数。其描述声明市场文本是第三方内容，不是指令。

#### Token 影响

预设挂载该工具时提供工具声明；每次调用追加其 JSON 结果，大小受 `limit` 限制（最多 100 个插件或版本）。

#### KV Cache 影响

仅追加：结果作为普通工具结果进入对话，不改变先前的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持升级**——索引版本更新的已安装组合包报告为 `update-available`；升级仍需先卸载再安装。
- **索引没有签名**——索引内容（包括 Git 条目的名称和版本）是索引的声明；实际安装什么由已安装的 manifest（元数据清单）决定。
- **后写入者覆盖**——`setIndexes` 会替换整个列表，因此两个窗口同时编辑索引源时，可能互相覆盖对方的修改。
- **拒绝重定向**——只能经重定向访问的索引必须以其最终 URL 配置。
- **读取整份文档**——Host 下载并保留每个不超过 `maxBytes` 的索引，并在内存中构建其文本索引；一个包含 20,000 个插件的合成索引构建用时约 0.8 秒，占用约 130 MiB 堆内存。解析在 Worker 中运行，但接收校验后的索引时，反序列化 clone 仍会阻塞 Host 事件循环：包含 20,000 个插件的 7.6 MiB 合成索引约 35 毫秒，包含 100,000 个插件的 38 MiB 索引约 190 毫秒。更大的索引需要服务端查询协议。
- **默认分支的 README**——仓库 README 读取的是默认分支上的文件，可能与列出的版本不一致；CDN 公开的 npm 数据不记录提交。
- **私有 npm 注册表**——公共 CDN 不提供其他注册表的包，因此此类版本的文档只能来自条目的仓库。
- **获取未公布的提交**——固定版本的 Git 条目按提交 id 获取，这需要服务器允许（`uploadpack.allowReachableSHA1InWant` 或 `allowAnySHA1InWant`）；GitHub 和 GitLab 允许这样做，拒绝的服务器报告 `denied`。
- **API 只查询精确的 README 文件名**——公开仓库的单文件 API 只查询 `README.md`、`readme.md`、`Readme.md`、`README.markdown` 和 `README`；其他大小写形式（例如 `README.MD`）只能在克隆中找到。
- **API 不使用凭据**——GitHub 和 GitLab API 以匿名方式读取；私有仓库总是使用克隆回退方式，这要求用户拥有该主机的 Git 凭据。
- **分页可能变化**——`fetchedAt` 只在文档仍被缓存时固定分页；另一次读取替换文档后，读取方必须从第一页重新开始。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
