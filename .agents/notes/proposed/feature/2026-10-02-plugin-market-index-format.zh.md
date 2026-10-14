# Agent Note: 插件市场索引格式

Status: proposed

[English](2026-10-02-plugin-market-index-format.md) | 中文

## 问题

DSH 只能从用户已知的 spec 安装第三方组合包（bundle）：npm 包名、Git URL、tarball 或本地路径。用户无法浏览可安装的组合包。目前没有官方市场，以后可能会增加官方市场，因此市场机制必须支持第三方发布的索引。

最小的索引是一份 npm 包名或 Git 仓库 URL 列表，每行一项。它能标识每个插件，但客户端渲染列表前必须为每个包获取 manifest（元数据清单）、语言文件和图标。列表页面每行发出一个或多个请求时，加载慢、可能部分失败，并且每个客户端都要实现元数据解析。

因此，索引必须包含列表页面显示的全部内容：本地化标题和描述、图标、作者、可用版本、兼容性和发布时间。市场还需要发布自己的数据，例如分类、标签、下载量和评分，而 DSH 不需要理解这些值的含义。

## 提案

将**索引**与**索引生成器**分开。DSH 定义并读取一种 JSON 索引格式。索引如何生成、基于哪份源列表生成，由生成器负责。DSH 的读取器、Discover 页面和参考生成器是使用此格式的独立变更。索引列出[profile 插件组合包](../../implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)，并通过[引导式插件安装](../../implemented/architecture/2026-09-15-guided-plugin-installation.zh.md)安装它们。

市场复用 npm 的包名、版本、范围、发布标签和 person 声明。读取器与生成器使用维护中的 npm 解析器和校验器。新增字段或改变含义需要 npm 无法满足的插件市场需求。

### 示例

```json
{
  "format": 1,
  "title": { "en": "Example Market", "zh": "示例市场" },
  "description": { "en": "Community DSH bundles", "zh": "社区 DSH bundle" },
  "metadata": {
    "categories": {
      "productivity": { "title": { "en": "Productivity", "zh": "效率" } }
    },
    "labels": {
      "official": { "title": { "en": "Official", "zh": "官方" } }
    },
    "sortKeys": {
      "downloads": { "title": { "en": "Downloads", "zh": "下载量" }, "order": "desc" },
      "rating": { "title": { "en": "Rating", "zh": "评分" }, "order": "desc" }
    }
  },
  "plugins": [
    {
      "name": "@example/dsh-auto-review",
      "title": { "en": "Auto Review", "zh": "自动审查" },
      "description": { "en": "Per-tool LLM authorization review", "zh": "逐工具 LLM 授权审查" },
      "icon": "icons/auto-review.svg",
      "author": "Example Labs",
      "homepage": "https://example.com/dsh-auto-review",
      "metadata": {
        "category": "productivity",
        "labels": ["official"],
        "keywords": ["review", "authorization"],
        "sortKeys": { "downloads": 12034, "rating": 4.6 }
      },
      "dist-tags": { "latest": "0.2.0-rc.1", "next": "0.2.0-rc.2" },
      "versions": [
        {
          "version": "0.2.0-rc.2",
          "publishTimestamp": 1790476800,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.0 <0.3.0" }
        },
        {
          "version": "0.2.0-rc.1",
          "publishTimestamp": 1789872000,
          "source": { "type": "npm" },
          "engines": { "dsh": "0.2.0 - 0.2.4 || >=0.3.0 <0.4.0" }
        }
      ]
    },
    {
      "name": "dsh-plugin-foo",
      "title": "Foo",
      "icon": "https://example.com/foo.png",
      "dist-tags": { "latest": "1.0.0" },
      "versions": [
        {
          "version": "1.0.0",
          "publishTimestamp": 1788000000,
          "source": {
            "type": "git",
            "url": "https://github.com/author/dsh-plugins",
            "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
            "path": "packages/foo"
          },
          "engines": { "dsh": "*" }
        }
      ]
    }
  ]
}
```

下文中的 `LocalizedText` 即 [`dsh-package-manifest`](../../../../packages/util/package-manifest/src/types.ts) 中的 `LocalizedText` 类型，即字符串或包含 `en` 的字符串对象，并附加两条规则：对象的键是匹配 `^[a-z]{2,8}(-[a-z0-9]{1,8})*$` 的小写语言 id，每个字符串至少包含一个非空白字符。

### 根字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `format` | 是 | 整数 `1`。 |
| `title` | 是 | 市场名称，类型为 `LocalizedText`。 |
| `description` | 否 | `LocalizedText`。 |
| `metadata` | 否 | 包含下列三个声明映射的对象。 |
| `metadata.categories` | 否 | 对象，将分类 id 映射为 `{ title: LocalizedText }`。 |
| `metadata.labels` | 否 | 对象，将标签 id 映射为 `{ title: LocalizedText }`。 |
| `metadata.sortKeys` | 否 | 对象，将排序键 id 映射为 `{ title: LocalizedText, order: "asc" \| "desc" }`；`order` 是初始排序方向。 |
| `plugins` | 是 | 插件数组，可以为空；数组顺序即索引的默认排序。 |

分类、标签和排序键的 id 均为非空字符串。读取器按自有属性查找 id，因此 `constructor` 等 id 没有特殊含义。

### 插件字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | 是 | npm 维护的包名校验器接受的新包名称；在索引内唯一。 |
| `title` | 否 | `LocalizedText`；缺省时读取器显示 `name`。 |
| `description` | 否 | `LocalizedText`。 |
| `icon` | 否 | 以下两种形式之一：`data:<type>;base64,<payload>`，其中 `<type>` 为 `image/svg+xml`、`image/png`、`image/jpeg` 或 `image/webp`，`<payload>` 是按规范填充的 base64，解码后的载荷不超过 256 KiB；或者 URL 引用，它相对于索引 URL 解析的结果是 `https:` URL，或与索引 URL 同源。 |
| `author` | 否 | 至少包含一个非空白字符的字符串。 |
| `homepage` | 否 | 介绍该插件的页面的绝对 `https:` 或 `http:` URL。 |
| `metadata` | 否 | 包含下列值的对象。 |
| `metadata.category` | 否 | 一个已声明的分类 id。 |
| `metadata.labels` | 否 | 由互不相同的已声明标签 id 组成的数组。 |
| `metadata.keywords` | 否 | 自由字符串数组；无需在根部声明。 |
| `metadata.sortKeys` | 否 | 对象，将已声明的排序键 id 映射为有限数值。 |
| `dist-tags` | 否 | 将 npm 发布标签名称映射为已列出的精确版本字符串的对象；缺省表示未记录发布渠道。 |
| `versions` | 是 | 非空的版本数组；见下文。数组顺序不选择安装版本。 |

`metadata.keywords` 按约定来自 npm `package.json` 的 `keywords`，但生成器可以使用其他来源、添加字符串或调整值。不要求提供此字段，也不要求它与包 manifest 一致。读取器保留字符串及其顺序；允许空数组。

### 版本字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | 是 | npm 的 `node-semver` 解析的精确版本；保留完整字符串，包括 Git 版本编译信息。精确字符串在插件内唯一。 |
| `publishTimestamp` | 是 | 以秒为单位的整数 Unix 时间戳，取值范围为 `[0, 10^11)`。 |
| `source` | 是 | `version` 的安装来源；见下文。 |
| `engines` | 是 | 包含 `dsh` 的对象。 |
| `engines.dsh` | 是 | 源 manifest 声明的非空白、有效 npm SemVer 范围；原样复制。`*` 显式声明支持任意 DSH 版本。 |

相对的 `icon` 引用相对于索引 URL 解析，与 HTML 图片引用相对于所在页面解析的方式相同。对于位于 `https://market.example/dsh/index.json` 的索引，`"icon": "icons/foo.svg"` 指向 `https://market.example/dsh/icons/foo.svg`。因此，生成器可以把索引和图标文件作为一个目录发布到任意静态主机，无需知道最终 URL。指向其他源的绝对图标 URL 必须使用 `https:`；同源规则允许位于 loopback 或内网主机上的 `http:` 索引提供自己的图标。读取器在读取索引时解析该引用，因此客户端收到的是绝对 URL。

`source` 采用以下两种形式之一，读取器拒绝其他任何 `type`：

- `{ "type": "npm", "registry"?: string }`。`registry` 是不含凭据、查询或片段的 `http:` 或 `https:` URL；允许 `http:` 是为了支持内网镜像，与 DSH 的[安装 registry](../../implemented/architecture/2026-09-18-plugin-install-registries.zh.md) 一致。
- `{ "type": "git", "url": string, "commit": string, "path"?: string }`。`url` 是规范的 `https:` URL（等于其 WHATWG URL 序列化结果），至少包含两个非空路径段且不以斜杠结尾，不含凭据、查询或片段，且不以 `.tgz` 或 `.tar.gz` 结尾。`commit` 是 40 位小写十六进制 SHA。`path` 是以 `/` 分隔的相对目录，各段只包含 ASCII 字母、数字和 `._@+-`，且不是 `.` 或 `..`；缺省表示仓库根目录。

### 安装参数

客户端安装某个版本时恰好使用以下 pnpm 参数：

- npm：spec 为 `<name>@<version>`。没有 `registry` 时，客户端像任何安装一样询问它配置的 registry。存在 `registry` 时，客户端遵循 DSH 的 [registry 计划](../../implemented/architecture/2026-09-18-plugin-install-registries.zh.md)：先询问 `registry`，仅当它属于客户端配置的 registry 之一时才回退到其他已配置 registry；其他 `registry` 单独询问，因此私有 registry 不会回退到可能以相同名称和版本发布不同包的公共 registry。
- git：spec 为 `git+<url>.git#<commit>`，`url` 已以 `.git` 结尾时不重复添加；存在 `path` 时在其后追加 `&path:/<path>`。`git+` 前缀使 pnpm 将路径段多于两个的 URL（例如 GitLab 子组）视为 Git 仓库。

### DSH 兼容性

市场列出的每个版本都必须声明有效的 `engines.dsh`。读取器与市场来源的安装使用 npm 的 `node-semver` 和 `includePrerelease: true`，根据当前运行的 DSH 版本求值。不存在对等依赖回退或范围合成。npm 包的对等依赖解析不属于市场宿主兼容性检查。

安装接受市场来源的包前，会重新检查源 manifest。精确的本地 `name@version` 豁免可以允许有效范围拒绝当前运行时的情况，但不能使缺失或无效声明符合列出条件。豁免不发布在索引中。

### 生成器义务

读取器无法验证以下规则；违反这些规则的生成器会发布误导性的索引。

- `name` 和每个 `version` 与所安装来源中的包 manifest 一致。
- 对于 npm 来源，`publishTimestamp` 是 `version` 在 registry 中的发布时间；对于 Git 来源，它是 `commit` 的提交者时间。
- `engines.dsh` 原样复制 manifest 声明的范围。缺失、空白或无效范围的版本会被省略并给出诊断。没有合格版本的插件会被省略。
- `dist-tags` 是 npm [发布标签](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)的快照，只保留指向合格且已列出版本的目标。对于 Git 来源，发布者或市场提供同样的精确标签到版本映射。
- 列出的每个版本都声明了 `dsh.bundle`。安装时也会独立拒绝没有组合包 patch 的包。
- `title`、`description` 和 `icon` 来自所列最高版本的语言元数据、manifest 字段和图标，采用已安装插件的显示规则。使用 npm 的 `node-semver.rsort()` 顺序，相等时保留输入顺序。元数据选择不选择安装版本。`homepage` 复制该版本 manifest 的 `homepage`，manifest 没有该字段时省略。
- `author` 来自同一最高版本的 npm 作者声明。复制对象的 `name`；使用维护中的 npm person 归一化器解析简写字符串。省略缺失或全空白的名称以及联系字段。归一化新建的投影，不修改源 manifest。

### 读取器规则

文档违反根字段、插件字段、版本字段或 `source` 形式中的任何规则时，读取器拒绝整个索引，包括引用了未声明的分类、标签或排序键，发布标签指向未列出的目标，`name` 或精确的 `version` 字符串重复，以及 `format` 不是 `1`。每个此类缺陷都是生成器 bug，静默丢弃条目会掩盖它。读取器可以限制文档大小。

读取器在每一层都忽略本 Agent Note 未定义的成员；未知的 `source.type` 值会被拒绝。这样格式 1 可以增加可选成员而不破坏现有读取器；现有读取器会误解的变更使用新的 `format` 值。

标签名称必须能被 npm 维护的 `npm-package-arg` 解析为 registry 标签 spec；目标是已列出的精确版本字符串。npm 来源使用规范发布标识（`node-semver.valid(version) === version`）；Git 来源保留版本编译信息并用提交固定精确来源。

分类、标签和排序键对读取器不透明：读取器按它们筛选和排序，显示其 `title`，从不解释 id 的含义。读取器按本地化 `title` 对声明排序后显示。对插件排序时，无论排序方向如何，没有所选排序键值的插件都排在所有有值的插件之后，值相同的插件保持索引顺序。按发布时间排序时使用插件最大的 `publishTimestamp`。

读取器按 DSH 兼容性一节的规则求值必填的 `engines.dsh` 范围。版本使用 npm 的 `node-semver.rsort()` 顺序，相等时保留索引顺序。安装版本由精确的标签目标选择，而不是此显示顺序。

初始渠道是 `latest`。它的精确目标是发布者或市场选择的版本。客户端安装记录的版本或提交，绝不安装 `name@latest`。缺失或不兼容的 `latest` 需要显式选择版本或渠道；客户端不会自动切换。安装确认标明版本、所选渠道（如果有）、先行版本状态、索引 URL 和来源。

## 考虑过的替代方案

**纯 npm 包名或仓库 URL 列表。** 它能标识每个插件，但列表渲染前每行需要一个或多个请求，而此格式正是为消除这一开销而设计。

**每个版本使用一个不透明的安装 spec 字符串。** 读取器无法验证自由格式的 spec 是否固定了版本。结构化的 `source` 配合精确的 `version` 或 `commit`，读取器可以验证版本固定，客户端可以构建要安装的 spec。

**安装最新版本而不是固定版本。** 这样安装的构建可能与列表显示的元数据不一致，并且包发布新版本会改变未修改的索引所安装的内容。

**每个版本一个条目。** 每个版本都会重复标题、描述、图标、作者和市场元数据，读取器还要按 `name` 分组才能显示一个插件。

**每个插件一个 `source`，每个版本只记录固定点。** 在两次发布之间换了仓库、目录或 registry 的插件将无法列出旧版本。

**每个版本各有显示字段。** 列表每个插件只显示一行，旧的显示文本、图标、作者和主页会增加索引大小，却没有读取器显示它们。

**只允许内联图标。** 不发额外请求的列表需要内联图标，但 256 KiB 原始字节编码为 base64 后约为 341 KiB，因此 100 个插件的索引可能达到约 35 MB。URL 图标以额外请求和向图片主机暴露用户 IP 地址为代价，换取较小的索引。

**从对等依赖推断宿主兼容性。** 市场定义要求作者声明 `engines.dsh` 的新标准。现有包必须添加此声明才能列出；不需要回退、workspace 映射或范围求交。

**将完整 npm person 对象复制到显示字段。** 列表需要名称。生成器支持 npm 的原始声明，同时省略不用的联系字段。

**用不透明排序值表示时间，包括 ISO 日期字符串。** 发布时间具有固定语义，客户端会对其格式化和排序，因此它是一个有类型的字段。排除时间后，排序值可以只用数值，无需为每个键规定值类型。

**根级 `labels` 和 `sortKeys`，以及名为 `sort` 的插件字段。** 在两个层级都把市场定义的声明和值归入 `metadata`，并使用对应的成员名（单值的 `category` 除外），可以将它们与客户端解释的字段区分开。

**以声明顺序作为显示顺序。** JavaScript 会重排类整数的对象键，因此要保留声明顺序，就需要限定 id 格式或改用数组声明。客户端改为按本地化标题对声明排序。

**选择最高兼容版本。** npm 的 `latest` 可以指向较旧的发布版本。从 SemVer 排名推断目标会丢失记录的渠道选择，而且在构建排名相等时存在歧义。

**自动回退到先行版本。** 渠道目标缺失或不兼容，不表示用户选择了先行版本。

**拒绝未知成员。** 这样每次增加可选成员都需要新的 `format` 值，并会破坏所有已部署的读取器。

## 验收标准

- 校验器接受上面的示例，并对根字段、插件字段、版本字段和 `source` 形式中的每条规则各拒绝一个违例，诊断信息给出对应的 JSON 路径。
- 根据每个示例版本构建的安装参数可被 DSH 的安装 spec 解析器和 pnpm 接受。
- 校验器在每一层都忽略未知成员。
- 生成器和校验器拒绝缺失、空白和无效的 `engines.dsh`；省略版本后不留下悬空的标签目标。索引和市场来源的安装对有效范围结果一致，包括连字符范围、先行版本以及拒绝当前运行时的有效范围。豁免绝不绕过声明要求。
- 排名相等的 Git 构建版本重新排序后，精确标签目标仍选择同一来源。缺失的目标被拒绝；`latest` 缺省或不兼容时不自动切换。
- npm 作者对象与简写字符串产生声明的名称，不包含联系字段，也不修改源身份。

## 风险

- 索引没有签名。标题、作者、标签和评分是市场的声明；`official` 标签不是 DSH 验证。客户端必须显示索引 URL 以及每个版本的 `source`。
- Git 版本的 `name`、`version` 和 `engines.dsh` 是关于仓库的声明。仓库可以声明任意名称，包括 `@deepseek-ai/dsh-` 名称，实际安装的内容由已安装的 manifest 决定。
- npm 版本的 `source.registry` 同样是一种声明：它把任意 `name`（包括 `@deepseek-ai/dsh-` 名称）的安装引向市场选择的 registry，由该 registry 决定实际安装的内容。
- URL 图标会向图片主机暴露用户的 IP 地址。
- 固定版本和发布标签在索引重新生成之前一直保持陈旧。
- 市场文本未经 DSH 审核即到达用户，并通过任何列出插件的客户端工具到达模型。
