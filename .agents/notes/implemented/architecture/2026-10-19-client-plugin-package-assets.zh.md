# Agent Note: Client 插件包资源经 URL 提供

Status: implemented

[English](2026-10-19-client-plugin-package-assets.md) | 中文

## Problem

动态 Client 插件的浏览器半侧由 [client 打包预设](../../../../packages/client/tsdown.client.ts) 打成 lazy-CJS factory，经 [Client 模块系统](../../../../packages/client/modules/README.zh.md) 的 `/plugins` 路由加载。这条路由过去只提供 `client.js` 和包内分片，所以插件代码引用的图片只能以 base64 data URL 打进 bundle，样式里用到的图片则要靠包级构建插件替换成内联样式。

不管图片显不显示，这些字节都随 JavaScript 一起下载和解析，base64 还会让体积大三分之一：引导插图使 ui-settings-account 的 `client.js` 达到约 3.4 MB。ui-chat 还为一张遮罩图维护了自己的 [tsdown 插件](../../../../packages/client/ui-chat/tsdown.config.ts)。

## Decision

Client 插件包把原始图片放在 `src/client/assets/`。共享预设把每个被引用的图片产出到 `lib/assets/`，并把引用改成对 bundle 模块加载器的同步调用 `require.asset(<文档相对 URL>)`；包通过 `"exports": { "./assets/*": "./lib/assets/*" }` 和 `files` 里的 `lib/assets` 发布这些产物；client-modules 的 Host 在 `/plugins/<包名>/assets/<产出路径>` 提供它们。

### 引用与文件名

Client 代码用 import 引用图片（`import art from './assets/a.webp'`），包自己的样式表用相对 `url()` 引用，两者都编译成参数为同一个引用的 `require.asset(reference)` 调用；样式表变成字符串字面量与这些调用的拼接，在构建注入文本时执行。模块系统通过 `resolveAsset` 选项回答每次调用；除非载体提供了自己的实现，否则原样返回引用。产出文件名在扩展名前插入内容 revision，即文件字节 SHA-1 摘要的前 12 位十六进制，因此一个 URL 永远只对应一份内容：

```text
src/client/assets/running-whale@2x.png
lib/assets/running-whale@2x-06738fa29b2f.png
plugins/@deepseek-ai/dsh-client-ui-chat/assets/running-whale%402x-06738fa29b2f.png
```

路径逐段先用 `encodeURIComponent` 编码，再编码 `!`、`'`、`(`、`)` 和 `*`，因此引用本身也是合法的无引号 CSS `url()`；包名原样输出。URL 和其他应用自有路由一样相对外壳文档，在任意挂载下、以及在注入的 `<style>` 文本中都能正确解析。组件不需要 hook、注入值或 service：URL 就是模块首次运行时算出的常量。

支持的扩展名是 `.svg`、`.png`、`.webp`、`.jpg` 和 `.jpeg`。client-modules 的 [`src/assets.ts`](../../../../packages/client/modules/src/assets.ts) 统一定义类型表、导出键与目标、revision、产出文件名和 URL，预设、路由和门禁都从这里读取。共享的 Client 类型根 [`scripts/types/client-assets`](../../../../scripts/types/client-assets/index.d.ts) 在 [`tsconfig.base.client.json`](../../../../tsconfig.base.client.json) 中登记，把每个扩展名声明为默认导出字符串的模块；有测试保证它与类型表一致。

### 构建

动态浏览器 face 的 `dsh-package-asset` 插件按源码位置解析 import。以下情况构建失败：文件真实路径不在本包 `src/client/assets/` 内（他包或依赖里的图片也因此被拒绝）；`exports["./assets/*"]` 不是恰好 `./lib/assets/*`；扩展名不受支持；路径段为 `node_modules` 或含 Host 路由无法提供的 `%`、`#`、`?`、`\` 或 NUL；扩展名不是小写（导入类型只声明小写扩展名）。每个文件每次构建只产出一次，并登记为监听输入。三条 CSS 管线（CSS Modules、全局样式、`?inline`）对本包 `src/` 内的样式表，经 lightningcss visitor 改写相对 `url()`；`data:`、片段、带协议、以 `/` 开头和空的 URL 保持不变，带片段或查询串的相对文件引用会让构建失败，依赖包的样式表不改写。lightningcss 不会在 `image-set()` 内部调用 `Url` visitor，因此由 `Image` visitor 按同样的规则改写这些选项。改写时先写入 lightningcss 从不转义的标识符占位，因此含括号或引号的文件名仍会变成对应的解析调用。双 face 包的 Node Client face 拒绝资源 import。浏览器 face 是 `lib/assets/` 的唯一写入方：一次性构建会删除本次没有产出的文件，watch 重建则保留它们，因为 Host 仍在提供上一代 bundle，运行它的页面会请求那些文件名。

### Host 路由

`bundleResource` 先于 bundle 表匹配 `/plugins/<包名>/assets/<路径>`，这类路径只由资源路由回答。对启用中的 client 行，路径解码一次后，`createRequire(<包的 manifest>).resolve('<包名>/assets/<路径>')` 套用包自己的 exports，未导出路径、`.` 和 `..` 段、不存在的文件和目录都解析不出来。媒体类型按解析出的文件扩展名判断，因为 Node 会把子路径中的 `#` 和 `?` 当作 URL 语法。任何解析失败、未启用的包和不支持的类型都返回 404；查询串不参与选择。

被提供的资源每次请求都从磁盘流式读取，Host 既不保存字节也不保存 hash；浏览器中途取消的请求直接结束，不记 warning。响应带媒体类型、与 bundle 相同的 `cache-control: public, max-age=31536000, immutable`、等于请求路径的 `etag`、`x-content-type-options: nosniff`；SVG 另带 `content-security-policy: script-src 'none'`。`If-None-Match` 等于该 tag 时返回 304，且不打开文件；`HEAD` 不带 body。`fetchBundle()` 返回同样的响应，body 为流，取消时关闭文件。

### WebWorker 预览

预览页的 Host 运行在 Worker 中，页面对引用发出的请求到达不了它。在任何 Client bundle 运行之前，页面向 Worker 请求 `GET /__assets__`，它和 `GET /__boot__` 一样由隧道胶水层回答：镜像中每个声明了 `"./assets/*": "./lib/assets/*"` 的包，其 `lib/assets/` 下的所有文件打成一个未压缩的 tar，条目以未编码的 `plugins/<包名>/assets/<路径>` 命名，基础镜像已满足同样的 ustar 名称限制。页面把每个条目名编码为引用，并按扩展名的媒体类型转成 Blob URL，它的 `resolveAsset` 返回这个 URL；镜像里没有对应文件时返回引用本身。基础镜像本来就带着这些文件，所以不增加网络请求；但每次启动仍会遍历镜像中的包、打包全部资源，并把每个条目复制成 Blob，不论包是否启用。

### 变化与包 manifest

图片重建后，重建的 `client.js` 带着新文件名，经现有的 bundle HMR 到达浏览器；资源没有单独的通道。client-modules 每次对账（即每次 Loader 条目构造和销毁）都读取包 manifest 和 bundle 元数据，不再把 manifest 缓存到重启，所以重装、升级或移动后重启的条目会发布当前的声明、client 导出和 manifest 路径；读到相同 manifest 和 bundle 元数据的对账不改动已发布的启动图，也不读取 bundle 字节。

### 门禁与迁移

[`check-workspace-constraints`](../../../../scripts/check-workspace-constraints.ts) 要求声明导出时 `files` 含 `lib/assets`。[`verify-client-packages`](../../../../scripts/verify-client-packages.ts) 要求导出目标精确匹配，只允许动态 Web Client 包声明该导出，并要求导出与包内引用（import，以及其 Client 源码所 import 的样式表中的 `url()`）双向一致。[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 把 `./assets/*` 视为非代码导出。ui-settings-account 和 ui-chat 已迁移到包资源，ui-chat 的 tsdown 插件已删除。

三方库自己加载的资源（PDF.js 的字体、cmap、wasm 和 worker）、插件元数据图标、详情文档图片，以及 static-linked 包，保留各自的交付方式。

## Alternatives considered

**保留 data URL。** 不需要路由，但字节随 JavaScript 一起传输和解析，每个在样式里用图片的包都要自写构建插件。

**不带运行时 helper 的纯 URL 字符串。** 普通 Web 应用不需要更多，但 WebWorker 预览页无法请求这个 URL，事后改写只能把文件复制到静态部署，或在 bundle 文本里查找字符串替换。静态复制是构建时的快照，绕过了 Host 的规则，也覆盖不到运行时安装的包；在 bundle 文本里找字符串是在猜代码。同步调用让构建产物保持显式，并由各个载体决定 URL。

**Client Cordis service，例如 `ctx.assets.url(path)`。** 当前使用方都引用固定文件；运行时查找也拿不到内容 revision，除非另外发布每个包的资源清单。

**原始文件直接放在包根 `assets/`，不经构建。** 作者无法做预处理，命名和格式转换只能手工维护。

**revision 放在 `?rev=` 查询串，由 Host 校验。** Host 必须读完整个文件才能决定回 200 还是 404，首次请求要读两遍，还要按文件元数据缓存 hash；revision 写进文件名后，Host 只需解析路径并流式发送。

**用 `client.js` 的 revision 作为资源 revision。** 这个 revision 在构建写出 bundle 后才由文件元数据得出，来不及写进 bundle。

**CSS 只能经 JavaScript style 对象引用图片。** 遮罩、背景和 `@supports` 降级会被挪进组件，而 URL 在构建时就能确定，同一套规则也能改写 `url()`。

**与详情文档共用一套插件文件协议。** 详情图片要从本地、npm 或 Git 读取任意包版本，会触发 Host 网络访问因而需要鉴权，缓存方式也随来源而定。合并会把鉴权、来源提供方和缓存策略搬进 client-modules；在出现需要读取其他包文件的新使用方之前，Plugin Manager 和 Plugin Market 的详情路由保持独立。

**从 Plugin Manager 获取 manifest，或给 manifest 缓存加变化检查。** Plugin Manager 只列出 bundle，不覆盖所有 client 行，而且从 profile 安装目录解析，而不是用运行中条目的 Loader 解析。问题出在时机：缓存活得比条目重启更久。每次对账重新读取并跳过未变化的结果，是删掉缓存，而不是给缓存加校验。

## Consequences

- ui-settings-account 的 `client.js` 为 214 KB，账户和 ui-chat 的 bundle 都不再含图片 data URL；图片显示时多一次同源请求，可能晚于布局出现。
- `require.asset` 和 `require.async` 一样属于 bundle factory 契约；仓库外构建的包必须输出这个调用。WebWorker 预览在启动时为镜像里所有包资源创建 Blob URL，不论包是否启用，并在页面生命周期内保留。
- Desktop 转发层把 `/plugins/` 的缓存头改写为 `no-store`，Desktop 每次显示都会重新读取资源。
- Host 不比对文件内容与文件名中的 revision：原地修改 `lib/assets/` 下的文件会保留它的 immutable 缓存。这个目录只由构建写入。
- `require.resolve` 在每次请求时同步执行；本机实测文件存在约 43 µs，不存在约 170 µs。它经 Node 的包配置缓存读取 exports，因此原地修改的 `./assets/*` 导出要等 boot HMR 让该包失效或 Host 重启后才生效。路由不检查解析结果的真实路径，所以 `lib/assets/` 下指向包外的符号链接会被提供。
- 仓库外的包必须复刻产出文件名规则和 `require.asset` 调用；Client 模块系统 README 记录了它们。
- 开发期间 `lib/assets/` 会留下旧的资源文件，直到下一次一次性构建把它们清掉；这种清理的前提是浏览器 face 是该目录的唯一写入方。
- 条目重启时会读取它的 manifest 并 stat 它的 bundle；只有结果变化时才读取 bundle 并广播启动图帧（69 行时约 30 KB）。只改 `package.json` 而条目没有重启时，仍要到下次条目重启或 Host 重启才生效。

## Testing

- [package-assets.client.spec.ts](../../../../packages/client/modules/tests/package-assets.client.spec.ts) 组合真实 Web server，并将每个响应与 `fetchBundle()` 比对：包括 SVG 策略在内的响应头、不打开文件的 304、`HEAD`、405、多分片流式发送、取消时关闭流、浏览器取消请求时不记日志，以及以下情况的 404：被排除的子路径、缺少导出或文件、`..`、`%2e%2e`、编码后的 `..`、空路径、错误的转义、解码后的 `%` 和 `#`、不支持的类型、目录和未启用的包。
- [assets.client.spec.ts](../../../../packages/client/modules/tests/assets.client.spec.ts) 覆盖媒体类型、revision、产出文件名和引用；[client-asset-types.spec.ts](../../../../scripts/client-asset-types.spec.ts) 保证类型根与类型表一致。
- [client-bundle-css.spec.ts](../../../../scripts/client-bundle-css.spec.ts) 覆盖产出文件名、脚本和样式表文本中的解析调用、完整构建中它们的 CommonJS 渲染、保留的 `url()` 形式、每种构建拒绝、Node face 守卫、一次性构建的清理，以及 watch 重建保留旧文件；[loader.client.spec.ts](../../../../packages/client/modules/tests/loader.client.spec.ts) 覆盖默认解析和载体解析。
- 各门禁的 spec 拒绝每种无效的 manifest 或引用形式；[node-half.client.spec.ts](../../../../packages/client/modules/tests/node-half.client.spec.ts) 覆盖条目重启后的声明更新、导出移动、client 声明的增减、未变化的重启既不发布也不读取 bundle，以及名为 `@scope/assets` 的包的分片。
- [desktop-onboarding.e2e.ts](../../../../apps/web/tests/desktop-onboarding.e2e.ts) 和 [reasoning-preview.e2e.ts](../../../../apps/web/tests/reasoning-preview.e2e.ts) 断言包资源 URL，并在浏览器中解码这些图片；[preview-boot.e2e.ts](../../../../apps/web/tests/preview-boot.e2e.ts) 解码 WebWorker 预览解析为 Blob URL 的 ui-chat 遮罩图，运行时的 [package-assets.spec.ts](../../../../packages/experimental/webworker-runtime/tests/package-assets.spec.ts) 覆盖归档和解析。
