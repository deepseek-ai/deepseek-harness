---
description: "无状态的插件详细介绍文档选择：meta.detail 或 README 的顺序、语言回退、图片路径，以及本地和 npm CDN 文件来源。"
kind: "package-library"
---

# dsh-plugin-detail

[English](README.md) | 中文

## 概述

用于插件详细介绍文档的无状态库。详细介绍是插件页面显示的较长 Markdown 描述。本包负责选择包文档的顺序、语言回退、文档旁图片的目标路径，以及两种只读文件来源：本地包目录，以及公共文件 CDN 上已发布的 npm 版本。[`plugin-manager`](../../boot/plugin-manager/README.zh.md#bundle-detail-documents) 用它读取 profile 中的组合包，[`plugin-market`](../../boot/plugin-market/README.zh.md#plugin-detail-documents) 用它读取市场条目，并额外提供仓库来源。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是库，不是服务或插件：没有 `ctx`、没有注册，也没有状态。所有读取都经由调用方传入的文件来源进行。

<a id="document-order"></a>
### 文档顺序

插件的详细介绍文档是按以下顺序第一个存在的文档：

1. **locale 中的 `meta.detail`。** 对语言链中的每种语言，读取包的 `locale/<language>.json`；该文件不存在时，读取地区部分为大写两字母的同名文件，例如 `locale/zh-CN.json`。读取到的文件声明 `meta.detail` 时，该 Markdown 文件即为文档；否则尝试下一种语言。
2. **包 README。** `README.md`、`readme.md`、`Readme.md`、`README.markdown` 或 `README`。能列出目录内容的来源接受任意大小写的 `README`、`README.md` 和 `README.markdown`。
3. **仓库 README，仅限市场条目。** 市场条目的 `repository` 所指仓库目录中的 README；条目没有 `repository` 时，使用包 `package.json` 的 `repository` 所指仓库目录中的 README；均读取默认分支上的文件。[`plugin-market`](../../boot/plugin-market/README.zh.md#plugin-detail-documents) 读取此步；**插件**中的组合包页面从不读取仓库。

`readPackageDocument(files, dir, languages, maxBytes, signal)` 实现第 1 步和第 2 步，两者都不适用时返回 `undefined`。`meta.detail` 必须是相对于包根目录、以 `/` 分隔、以 `.md` 或 `.markdown` 结尾的路径，且不含空段、`.` 或 `..` 段、反斜杠或 URL scheme。locale 文件格式错误、`meta.detail` 格式错误，或指定的文件不存在时，以 `DetailFailure` `invalid` 失败；不会改为读取 README。

`languageChain(language)` 构建语言链：先是小写形式的该语言，然后是每个更短的前缀，最后是英文，因此 `zh-Hans-CN` 依次读取 `zh-hans-cn`、`zh-hans`、`zh` 和 `en`。

返回的 Markdown 不含字节顺序标记（BOM），也不含开头的 YAML front matter 块。

### 图片

`detailImage(document, destination)` 解析文档中引用的图片：相对于该文档；以 `/` 开头时相对于其文件的根目录；查询和片段被忽略。它返回图片的路径和媒体类型；目标路径超出根目录、格式错误，或指定 PNG、JPEG、GIF、WebP、AVIF 和 SVG 之外的类型时，返回 `undefined`。

### 文件来源

- `localFiles(root, revision)` 读取一个包目录。实际位置超出该目录的路径按不存在处理。`revision`（例如已安装的版本）成为该来源 `key` 的一部分。
- `npmFiles(name, version, sources, options)` 按给定顺序从 jsDelivr、unpkg 和 npmmirror 读取一个已发布版本。404 表示该包没有此文件；网络失败或其他状态码时改为请求下一个 CDN。`npmFileSourceOrder(configured, preferred)` 把已配置的优先 CDN 按优先顺序排在最前，其后是其他已配置的 CDN。
- `fetchBody(url, maxBytes, signal, options)` 读取一个 HTTP 响应体，最多 `maxBytes`，并跟随该 URL 的 origin 内的重定向。

每次读取都受调用方 `maxBytes` 的限制，超过时以 `DetailFailure` `too-large` 失败；来源无法访问时以 `network` 失败。

### 图片响应

`detailImageResponse(outcome, cacheControl)` 生成图片路由的响应：有图片时返回该图片并带 `cacheControl`；没有图片时返回 404；失败时返回该失败的状态码（`too-large` 为 413、`network` 为 502、`denied` 为 403、`git-unavailable` 为 503、`invalid` 为 400），以失败原因作为响应体，并带 `Cache-Control: no-store`。每个响应都带有 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`，因为否则直接打开的 SVG 会在已通过认证的 API origin 上运行脚本。

-----

<a id="api"></a>
## API

```ts
import {
  DetailFailure, detailImage, detailImageResponse, languageChain, localFiles, NPM_FILE_SOURCES, npmFiles, npmFileSourceOrder,
  readPackageDocument,
} from '@deepseek-ai/dsh-plugin-detail'
```

`DetailFailureReason` 和 `NpmFileSource` 供其他包的 Remote 方法使用，也从 `@deepseek-ai/dsh-plugin-detail/types` 以仅类型方式导出。

`DetailFiles` 是来源接口：`read(path, maxBytes, signal)` 返回文件的字节或 `undefined`，`readme(dir, maxBytes, signal)` 返回目录的 README。仓库来源在 `plugin-market` 中实现该接口。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本库为插件页面选择文档，不向模型请求添加任何内容。

#### KV Cache 影响

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只支持公共 npm**——文件 CDN 提供公共 npm 注册表中的包；其他注册表中的包没有 npm 文件来源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
