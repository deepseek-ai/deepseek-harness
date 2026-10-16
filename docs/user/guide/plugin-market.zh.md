# 插件市场

[English](plugin-market.md) | 中文

## 概述

插件市场是一个 JSON 索引文件，列出可安装的 DSH 组合包（bundle）及其标题、图标、作者和版本。打开实验性的**自定义插件市场**组合包后，可以在插件页的**发现**标签页中浏览市场，并在确认后安装列出的版本。要发布市场，编写或生成一个索引文件，并把它和图标文件一起放到任意静态主机上。

## 目录

- [打开「发现」](#turn-on)
- [浏览和安装](#browse-and-install)
- [发布索引](#publish-an-index)
- [用参考生成器生成索引](#generate-an-index)
- [索引格式参考](#index-format)
- [延伸阅读](#further-exploration)

<a id="turn-on"></a>
## 打开「发现」

打开**插件**，点击**实验性插件**旁的**更多**，找到**自定义插件市场**并打开开关。**已安装**旁边会出现**发现**标签页，Creator 模式也会获得只读的 `plugin_market` 工具。关闭该组合包会再次移除这两者。

DSH 不内置任何索引源。选择**发现**，点击**添加索引源**，输入一个索引文件的 URL。URL 必须使用 `http:` 或 `https:`，并且不能包含用户名、密码或 `#` 片段。网络路径上的任何人都能修改 `http:` 索引，包括其中列出的安装 spec，因此经由不受你控制的网络访问的市场应使用 `https:`。每个索引源属于当前 profile。

<a id="browse-and-install"></a>
## 浏览和安装

工具栏左侧的市场菜单用于切换索引源，并可打开**管理索引源…**，其中每个索引源显示它最近一次的错误。搜索匹配名称、作者、关键词，以及所有语言的标题、描述、分类和标签，并容忍拼写错误；在你选择其他排序之前，结果按最佳匹配排序。**标签**菜单、分类按钮和**排序**菜单使用市场声明的分类、标签和排序键，**发布时间**按每个插件最新版本的时间排序。

每张卡片显示插件的推荐版本：与当前运行的 DSH 兼容、且不是预发布版本的最高版本；插件没有列出任何非预发布版本时，则是兼容的最高预发布版本。**安装**会打开确认框，显示该版本的来源：npm 包和注册表，或 Git 仓库、提交和目录。确认后开始常规的插件安装，包括其中的兼容性检查和注册表检查；未经确认不会安装任何内容。

选择卡片会打开插件页面。**版本**列表显示列出的每个版本及其兼容性，并为 DSH 接受的任何版本提供**安装**，包括旧版本和预发布版本。显示**已安装**、**有新版本**或**随 DSH 提供**的卡片会改为打开已安装的组合包。

市场是第三方内容。每个插件的标题、描述、图标、作者和来源都由市场决定；DSH 检查文件格式，但不验证这些声明。只添加你信任的索引源，并在安装前核对确认框中的来源。

<a id="publish-an-index"></a>
## 发布索引

索引是 UTF-8 编码的 JSON 文件，默认不超过 128 MiB，以 2xx 状态码返回且不经过重定向。把它放到任意静态主机上即可，例如 GitLab Pages、GitHub Pages，或通过 https 访问的对象存储。

图标可以内联，也可以是单独的文件。内联图标是索引中的 base64 `data:` URL；它不需要额外请求，但会使索引变大。单独的图标是一个 URL。相对图标相对于索引 URL 解析，与网页中的图片相对于页面解析的方式相同：对于位于 `https://market.example/dsh/index.json` 的索引，`"icon": "icons/foo.svg"` 会加载 `https://market.example/dsh/icons/foo.svg`。因此把索引和 `icons/` 目录并排发布，在任何主机上都能使用，无需修改文件。指向其他源（协议、主机和端口）的绝对图标 URL 必须使用 `https:`。

下面是一个最小的索引，包含一个 npm 插件和一个来自 Git monorepo 的插件：

```json
{
  "format": 1,
  "title": { "en": "Team plugins", "zh": "团队插件" },
  "plugins": [
    {
      "name": "dsh-plugin-foo",
      "title": "Foo",
      "description": "Adds the foo tool",
      "icon": "icons/foo.svg",
      "author": "Jane Doe",
      "homepage": "https://github.com/jane/dsh-plugin-foo#readme",
      "repository": { "url": "https://github.com/jane/dsh-plugin-foo" },
      "versions": [
        { "version": "1.1.0", "publishTimestamp": 1790476800, "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.0-rc.2" } },
        { "version": "1.0.0", "publishTimestamp": 1788000000, "source": { "type": "npm" } }
      ]
    },
    {
      "name": "@team/dsh-bar",
      "versions": [
        {
          "version": "0.3.0",
          "publishTimestamp": 1789000000,
          "source": {
            "type": "git",
            "url": "https://gitlab.example.com/team/dsh-plugins",
            "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
            "path": "packages/bar"
          }
        }
      ]
    }
  ]
}
```

违反下列任何一条规则时，DSH 会拒绝整个索引，并在**管理索引源…**中该索引源下方显示原因及违规值的 JSON 路径。

<a id="generate-an-index"></a>
## 用参考生成器生成索引

仓库包含一个[参考生成器](../../../apps/plugin-market-generator/README.zh.md)，可以从一份纯文本列表构建索引。每行写一个 npm 包名或 https Git 仓库 URL；空行和以 `#` 开头的行会被忽略：

```text
@team/dsh-foo
https://gitlab.example.com/team/dsh-plugins
```

在 DSH 代码仓库中运行它：

```sh
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start --input plugins.txt --output site/index.json --title "Team plugins"
```

对于 npm 包，索引列出所有未弃用且声明了 `dsh.bundle` 的版本。对于 Git 仓库，生成器在默认分支上查找组合包，列出它们在 `vX.Y.Z`、`X.Y.Z` 和 `<name>@X.Y.Z` 标签处的版本，以及每个包在默认分支上的版本。标题、描述、图标、作者和主页取自每个插件的最高版本。路径相对于你运行 pnpm 的目录。

生成器只下载和读取文件，从不安装包或运行其代码。它在列表旁的 `.plugin-market-cache` 中保存缓存，因此再次运行时只下载新的版本和提交。按上文所述发布输出目录，即 `index.json` 及其 `icons/` 目录。

<a id="index-format"></a>
## 索引格式参考

标为 `LocalizedText` 的文本字段是字符串，或以小写语言 id 为键的字符串对象，例如 `{ "en": "Foo", "zh": "甲" }`；对象必须包含 `en`。DSH 不认识的成员会被忽略。

| 索引字段 | 必填 | 含义 |
|---|---|---|
| `format` | 是 | `1`。 |
| `title`、`description` | 仅 `title` | 市场名称和描述，类型为 `LocalizedText`。 |
| `metadata.categories`、`metadata.labels` | 否 | 将 id 映射为 `{ "title": LocalizedText }` 的对象。 |
| `metadata.sortKeys` | 否 | 将 id 映射为 `{ "title": LocalizedText, "order": "asc" \| "desc" }` 的对象；`order` 是初始方向。 |
| `plugins` | 是 | 按市场默认顺序排列的插件。 |

| 插件字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | npm 包名，在索引内唯一。 |
| `title`、`description` | 否 | `LocalizedText`；没有标题时卡片显示 `name`。 |
| `icon` | 否 | 内联 `data:` URL（SVG、PNG、JPEG 或 WebP，不超过 32 KiB）或 URL，见上文。 |
| `author` | 否 | 显示文本。 |
| `homepage` | 否 | 介绍该插件的页面的绝对 `https:` 或 `http:` URL；插件页面会链接到它。 |
| `repository` | 否 | `{ "url": string, "directory"?: string }`：源代码仓库的网页，以及包在其中的目录。插件页面以**源代码**链接到它。 |
| `metadata.category` | 否 | 一个已声明的分类 id。 |
| `metadata.labels` | 否 | 已声明的标签 id。 |
| `metadata.sortKeys` | 否 | 将已声明的排序键 id 映射为数值的对象，例如下载量或评分。 |
| `versions` | 是 | 至少一个版本，顺序不限。 |

| 版本字段 | 必填 | 含义 |
|---|---|---|
| `version` | 是 | 精确的 SemVer 版本，在插件内唯一。 |
| `publishTimestamp` | 是 | 发布时间，Unix 秒。 |
| `source` | 是 | `{ "type": "npm", "registry"?: url }`，或 `{ "type": "git", "url": https-url, "commit": 40 位十六进制 SHA, "path"?: 目录 }`。 |
| `engines.dsh` | 否 | 该版本可运行的 DSH 版本的 SemVer 范围；缺省表示任意版本。 |

DSH 将 npm 版本安装为 `name@version`，存在 `registry` 时先询问它；将 Git 版本安装为 `git+<url>.git#<commit>`，包位于子目录时追加 `&path:/<path>`。`engines.dsh` 应与包自身的 `engines.dsh` 一致，DSH 会在安装时再次检查；没有该字段的包改为按其 `@deepseek-ai/dsh*` peer 依赖检查。[格式说明](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)定义了全部规则。

<a id="further-exploration"></a>
## 延伸阅读

- [「发现」标签页参考](../../../packages/client/ui-plugin-market/README.zh.md)说明该标签页的控件和状态。
- [插件市场服务](../../../packages/boot/plugin-market/README.zh.md)说明获取限制、缓存和 `plugin_market` 工具。
- [索引校验器](../../../packages/util/plugin-market-index/README.zh.md)是生成器可以用来在发布前检查索引的库。

## 开发备注

无。
