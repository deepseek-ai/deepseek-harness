# 插件市场索引生成器

[English](README.md) | 中文

[插件市场索引](../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)文件的参考生成器。它读取一份由 npm 包名和 Git 仓库 URL 组成的纯文本列表，写出一个 `index.json`，DSH 的 **发现** 页面无需额外请求即可展示该文件。它是独立的 Node 程序，不是 Cordis 应用，也从不安装或运行其所描述包的代码。

## 用法

编写来源列表，每行一个条目。生成器忽略空行和以 `#` 开头的行。

```text
# npm packages: every bundle version that is neither deprecated nor private is listed
@scope/dsh-example
dsh-another-plugin
# Git repositories: release tags and the default branch are listed
https://github.com/author/dsh-plugin
https://gitlab.example.com/group/dsh-plugins
```

在仓库中运行生成器：

```sh
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "Example Market"
```

`--input` 和 `--output` 相对于你运行 pnpm 的目录。通过 https 发布输出目录，然后在「发现」中把该 `index.json` 的 URL 添加为索引来源。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `--input <file>` | 必填 | 来源列表。 |
| `--output <file>` | 必填 | 索引文件。过大而无法内联的图标写入其旁边的 `icons/`；索引不再使用的已生成图标文件会从该目录删除。 |
| `--title <text>` | 必填 | 市场标题。 |
| `--description <text>` | 无 | 市场描述。 |
| `--cache <dir>` | 输入列表旁的 `.plugin-market-cache` | 结果缓存。它不在会被发布的输出目录中。 |
| `--registry <url>` | `https://registry.npmjs.org/` | npm 注册表。使用其他注册表时，该注册表会记录在每个 npm 版本中。 |
| `--inline-icon-bytes <n>` | `16384` | 以 `data:` URL 内嵌的图标的最大字节数，不超过格式的内联图标上限 32768。 |
| `--concurrency <n>` | `4` | 同时读取的来源数。 |
| `--timeout-ms <n>` | `60000` | 单个请求或 Git 命令的时限。 |
| `-h`、`--help` | | 打印这些选项和退出状态。 |

所有来源都读取成功时退出状态为 0，有来源无法读取时为 1，参数无效或列表无效时为 2。索引格式会拒绝的列表行属于无效列表，例如 `http:` URL、带凭据、查询或片段的 URL、路径段少于两个的 URL，以及 tarball URL。无法读取的来源保留其上一次成功的结果，因此临时故障不会把插件从索引中移除；生成器仍会报告该失败。

## 列出的内容

每个包成为一个插件，带有一个或多个版本。只有 `package.json` 声明了 `dsh.bundle`、其 `patch` 是一个文件路径或文件路径列表、且没有设置 `"private": true` 的版本才会列出。默认分支上的 `package.json` 设置了 `"private": true` 的 Git 包不会列出，它在各个标签上的版本也不列出。

- **npm 包**：注册表文档中未弃用、未设为私有、声明了组合包（bundle）且有发布时间的每个版本。版本只取自注册表文档；生成器只下载最高列出版本的 tarball，用于读取展示字段。该 tarball 的 `package.json` 必须与所请求的包名和版本一致。
- **Git 仓库**：生成器按以下顺序在默认分支上查找组合包：
  1. 根 `package.json` 声明了 `dsh.bundle`：仅使用根包；
  2. `package.json` 的 `workspaces` 或 `pnpm-workspace.yaml` 的 `packages` 匹配到声明了 `dsh.bundle` 的包：使用这些包。每个 glob 段可以是字面名称、含 `*` 的名称或 `**`；生成器忽略否定 glob，并报告未匹配任何内容的 glob；
  3. 否则，使用三层目录以内、位于 `node_modules`、`test`、`tests`、`fixtures`、`example` 和 `examples` 之外的所有声明了 `dsh.bundle` 的包。

  每个包的版本来自发布标签（tag）和默认分支。`vX.Y.Z` 或 `X.Y.Z` 标签适用于所有包，`<name>@X.Y.Z` 标签（例如 `@scope/dsh-a@1.2.0`）适用于同名的包；标签中的版本必须是确切的 SemVer 版本。当包目录在打标签的提交中有一个组合包 manifest（元数据清单），且其名称相同、版本等于标签版本时，该标签列出这个包。默认分支的提交列出每个包的当前版本，除非某个标签已经列出该版本。多个标签列出同一版本时，`<name>@` 标签优先于统一标签，其次是较早的提交。发布时间是该提交的提交者时间。

`engines.dsh` 取 manifest 的 `engines.dsh` 并去掉首尾空白。没有该字段时，它是 manifest 中 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的 `peerDependencies` 范围的合取；恰为 `workspace:*`、`workspace:^` 或 `workspace:~` 的 peer 表示当前运行的 DSH 版本，不增加限制；相同的范围只出现一次。`*` 范围接受所有版本，因此范围全为 `*` 的版本不列出 `engines.dsh`。如果安装时在所有 DSH 版本上都会拒绝某个版本，该版本会被跳过并发出警告：范围为空、`engines.dsh` 中出现 `workspace:` 值或 peer 中出现其他 `workspace:` 范围、范围无效，或者没有任何版本能同时满足这些范围。

展示字段来自最高的列出版本，并遵循 DSH 读取已安装插件时的规则。`./locale/en.json` 和 `./locale/<language>.json` 通过包的 `exports` 映射以 `import`、`node` 和 `default` 条件解析，没有该映射时按字面路径读取，并且每个 locale 文件都必须与英文文件位于同一目录；其 `meta.title` 和 `meta.description` 缺失时回退到 manifest 的 `name` 和 `description`。图标是 manifest 的 `icon`（相对路径），否则是导出的 `./icon`：格式为 SVG、PNG、JPEG 或 WebP，不超过 256 KiB，并位于包内。`author` 是 manifest `author` 字符串中去掉 `<email>` 和 `(url)` 后的名字部分，或 author 对象的 `name`。`homepage` 在 manifest 的 `homepage` 是绝对 http(s) URL 时按原样复制；缺少时不会用 `repository` 等其他字段代替。`repository` 是 manifest `repository`（如 `github:o/r` 这样的简写或 URL）对应的网页：已知主机通过 [hosted-git-info](https://github.com/npm/hosted-git-info) 转换，并去掉 `#` 后的 committish；其他 http(s) URL 去掉 `git+` 前缀、凭据、查询、片段和 `.git` 后缀。格式接受时复制其 `directory`。没有 http(s) 网页的仓库或不可用的 `directory` 会被报告并省略。格式错误的 locale 文件、无效的 locale 名称和被拒绝的图标会作为警告报告。由于该格式要求英文，没有英文文本也没有 manifest 回退值的翻译会被丢弃。每个条目在写出前都经过 [`dsh-plugin-market-index`](../../packages/util/plugin-market-index/README.zh.md) 校验。

`metadata.keywords` 是用于发现插件的可选字符串数组。按约定使用 npm `package.json` 的 `keywords`；索引生成器可以补充或调整它。本参考生成器原样复制最高列出版本 manifest 的 `keywords`，包括空字符串、重复值和空数组。字段缺省时省略；如果值不是数组，或数组包含任何非字符串成员，则发出警告并省略整个字段，但保留该包。

多个来源产生相同包名时，列表中靠前的来源生效。

## 缓存与重复运行

每次运行时，生成器读取每个 npm 来源的注册表文档和每个 Git 仓库的引用（ref）。结果按不可变的输入缓存：npm 插件按注册表、图标阈值、包和列出版本的集合缓存；Git 仓库按默认分支提交和发布标签缓存；每个 Git 包按提交和目录缓存。因此 Git 运行只拉取其包尚未缓存的提交。生成器以原子方式写入缓存文件，并重建损坏的或索引格式会拒绝的缓存文件。输出是确定性的：条目按列表顺序排列，索引文件和图标文件只在内容变化时才重写，因此上游没有变化时再次运行生成器不会改动输出。

## 安全

生成器只下载和读取文件。npm tarball 在内存中读取：tarball 及其解包后的文件各自不能超过 64 MiB，字节必须与注册表的完整性哈希一致，并且只保留 `node_modules` 之外的普通文件，不接受离开包目录的路径。Git 对象以深度 1 拉取到一个私有的临时裸仓库，并作为 blob 读取，因此不存在工作树，检出过滤器、LFS 下载和符号链接都不会生效；符号链接和子模块视为不存在。Git 运行时禁用钩子和文件系统监视器、不处理子模块、只允许 https 和 ssh 传输协议，并且不继承除 `GIT_SSH` 和 `GIT_SSH_COMMAND` 之外的 `GIT_*` 变量。你配置的 ssh 程序和 `GIT_SSH_COMMAND` 优先；两者都没有时，ssh 以批处理模式运行，因此不会等待输入。超过 1 MiB 的 manifest、语言文件和工作区文件会被拒绝。私有仓库使用你的 Git 凭据配置；可以用 `url.<base>.insteadOf` 把 https URL 改为通过 ssh 访问。

索引内容是各个包对自身的声明。请审查你发布的列表：列出的仓库可以使用任意包名。

## 限制

- Git 服务器必须允许按 SHA 拉取提交，GitHub、GitLab 和 Gitea 都允许。服务器拒绝时，生成器按名称拉取标签和默认分支；如果某个引用在列出之后移动了，这一步会失败。
- 生成器不使用 `.npmrc` 中的注册表令牌；只支持公开或无需认证的注册表。
- Git 从不提示输入凭据。需要凭据的仓库必须能通过凭据助手或 ssh agent 读取。
