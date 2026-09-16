---
description: "右侧 Sidebar 的文档预览：共享文件加载与控件，可选 Markdown、代码、图片、PDF 和 HTML 渲染器，并以纯文本兜底。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-documentpreview

[English](README.md) | 中文

## 概述

在右侧 Sidebar 预览可读文件，无需另开 tab 即可切换已注册的渲染器。Markdown 和代码接收累计文本页；PDF、HTML 和常见图片接收完整字节；未知文件扩展名使用纯文本。tab 负责加载、文件状态、渲染器选择、换行和重新载入，文档正文通过同一元数据注册表与子 slot 注册。Sidebar tab 的 kind 为 `text`。

## 目录

- [注册了什么](#what-it-registers)
- [地址](#addresses)
- [怎么读](#how-it-reads)
- [导航](#navigation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型** —— `ctx.sidebarRightTabs.register(...)`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（这个实现在 tab 系统中的身份，也是其正文注册所用的键），kind `text`，pattern `dsh-resource://file/**`，档位 `fallback`。`canOpen` 只接受 Session 地址，其中路径可为相对或绝对路径；不认领裸 `absolute` 地址。在 `extension` 或 `builtin` 档以更窄 pattern（比如 `*.png`）注册的类型接走那些地址；其他受支持文件落到这里。整个地址就是内容身份，所以不同目录下同名的两个文件、或同一路径在两个会话之下，是两个 tab；解码后的 basename 是 tab 标题，keyed slot `sidebar.right.pane.tab.title` 会在标题前放置按扩展名选择的 `FileTypeIcon`。
- **正文** —— keyed slot `sidebar.right.pane.tab`，键为类型的 id。固定头部在可用时显示 Host 的绝对路径，否则显示请求路径；目录使用三级标签色，文件名使用一级标签色，路径过长时保留末段并向开头淡出，提示中仍提供完整值。下拉菜单可在匹配的渲染器与纯文本间切换；声明为二进制的后缀（位图图片、PDF）不提供纯文本兜底，只剩一个候选时完全不渲染查看器控件。已知的二进制容器后缀（音频、视频、压缩包、office 文档）没有注册渲染器时，在路径头部下方显示不支持预览的空态——文件类型图标加一行说明——并且不会发起读取。仅当所选渲染器声明 `wrap: true` 时显示换行开关；图标表示点击后切换到的模式，该偏好按 tab 保存，初始开启。重新载入仍在此头部，不放入 Sidebar 的 tab 条。正文贴合格的每条边，各渲染器自行提供内容留白，并可拥有内部滚动区。这与 Files tab 右侧预留 2px 滚动条间距的布局有意不同：Preview 使用格的完整宽度，使贴边 HTML 与代码滚动区终止于格的边缘。
- **共享加载与视图状态**，会话作用域、按 tab id 分桶。store 持有累计页或完整字节、读取与观察版本、加载/失败状态、渲染器选择、滚动位置、换行和已响应的导航 revision。普通 inject face 调用 Remote 读取，并经声明的 store action 写入。重新载入和加载模式变化会淘汰旧请求；tab 的中止信号清理其状态。

文档实现在 `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })` 注册元数据，并以相同 `id` 向 keyed、Session 作用域的子 slot `sidebar.right.tab.document` 注册正文。`binaryExtensions` 列出 `extensions` 中字节不可按文本阅读的后缀；匹配这类后缀的文件在其查看器选项中不再提供纯文本兜底。两处注册都由 effect 持有，通过 `ctx.slots.inject` 等待子 slot。正文接收 `resourceAddress`、准备好的 `content`、`wrap`、`scrollportRef` 和标准 `useTabInfo`/`useResource` 钩子，不接收自定义资源加载器。拥有内部滚动元素的渲染器把 `scrollportRef` 挂到该元素上；该元素卸载后，owner 恢复使用共享正文。元数据声明 `loading: 'text-pages'` 或 `'bytes-complete'`。注册表保留所有匹配备选：`extension`（默认）优先于 `builtin`，随后按更长的后缀、再按注册顺序排列。所选实现仍可用时，下拉选择保持不变；移除后选择下一个候选。内置正文也使用相同注册方式。

<a id="addresses"></a>
## 地址

tab 使用 `fileAddressFor` 构造的 Session 地址，携带相对或绝对路径。`hostFileOf(address)` 仅从地址取得 Session，不接收外部 Session 参数，也不借用当前或 Tab Session。Host 通过 Session 文件系统解析文件及关联路径，由该后端控制读取权限。任何 UI（包括 Global 组件）都共享同一完整地址的元数据。[Workspace Files README](../../api/workspace-files/README.zh.md) 定义这些规则；渲染器选择不改变导航地址。

<a id="how-it-reads"></a>
## 怎么读

正文通过 `useTabInfo().tab` 读取记录、导航和生命周期。`useResource<'file'>(tab.contentId)` 提供元数据，普通 inject 回调提供内容读取：

- 资源快照仅包含 `status`、`value` 和 `failure`；`value` 是 `WorkspaceFileStat` 元数据。提供方可用后，内容读取无需等待首个元数据帧。观察失败优先于 Preview 的变更提示显示；两者都不会自动替换已加载内容。
- **文本页** —— 纯文本、Markdown 和代码通过 inject 回调调用 `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`。首次挂载读取第一页；滚动到正文末尾或点击 **加载更多** 会读取下一页，直到 `eof`。owner 以 `{ kind: 'text', text, pages, eof }` 提供累计前缀，包含源码偏移和行数。Markdown 和代码增量渲染此前缀，不把每页当成独立文档。第一页之后到达的更新版本页会使读取从头开始，避免混合版本。尚无内容时，失败会以文件类型图标、说明与重试按钮填满正文；较晚的失败保留已有内容并在其下提供重试。
- **完整字节** —— PDF、HTML 和常见图片通过 inject 回调调用 `remote.workspaceFiles.readAll(sessionId, path, signal)`。`rpc.ts` 将线路上的 base64 解码为 `data: Uint8Array<ArrayBuffer>`，供 `{ kind: 'bytes', data }` 使用。Host 的 `maxFileBytes` 上限拒绝超大文件，不截断。PDF 在传给 worker 前复制保留的字节，使 Preview 缓冲区仍可使用。字节仅保存在临时视图状态中，绝不进入持久布局或 Session JSONL。加载模式变化会淘汰先前结果。
- **重新载入** —— 仅当前 Preview tab 通过自己的 Remote 回调重读，保留滚动偏好并淘汰旧请求。变更提示将读取版本及起读时的观察版本与后续 `resource.value.version` 比较；刷新前已观察到的版本不会被当成新变化。读取既不刷新共享元数据，也不清除其它 tab 的提示。

HTML 以贴合正文四边的 Blob iframe 运行，沙箱属性严格为 `sandbox="allow-scripts"`，不含 `allow-same-origin`；脚本无法访问父应用的源或文件读取接口。渲染器通过普通 inject 回调调用 `remote.workspaceFiles.readRelated`，加载直接声明的相对 `.js` 经典脚本和 `.css` 样式表；固定安全上限为单个资源 4 MiB、总计 32 MiB、64 个不同资源。Host 代码解析关联路径，`rpc.ts` 解码返回的字节。在渲染器内部，base64 仅用于把 iframe 引导载荷嵌入脚本文本。`<base href>` 将依赖解析交给浏览器，HTTPS 资源也由浏览器处理。本地模块 import、CSS `url()`/`@import` 和动态 `fetch` 不使用 Host 文件访问。读取失败、无效 UTF-8 或超出上限都使预览失败，不发布部分资源包。替换或卸载文档会释放其 Blob URL。

PNG、JPEG、GIF、WebP、BMP、ICO 和 SVG 通过 Blob URL 在 `<img>` 静态图片上下文中渲染，带 12px 内边距和圆角。宽图按固有纵横比缩小到面板宽度，小图按固有 CSS 像素尺寸居中，超高图纵向滚动。渲染器既不提供缩放，也不提供拖拽平移。SVG 标记绝不进入应用 DOM 或 iframe，因此其中的脚本无法执行，也无法访问父页面。替换或卸载图片会撤销其 Blob URL。

共享文案来自 `sidebarDocumentPreview`；各内置渲染器拥有自己的本地化标签。

首次读取、追加页及 HTML/PDF/图片准备共用仅图标的加载 spinner，其标签暴露给辅助技术，并遵循减少动态效果偏好；内容出现前的每个等待都把 spinner 居中在面板中，打开文件到正文出现始终是同一位置的一个 spinner。下一页加载期间保留已显示的内容。PDF 正文仅在 PDF 预览挂载时加载包内 `client.pdf.js` chunk；PDF.js、Worker 源码和内嵌支持数据不会进入启动 `client.js`。PDF 页面贴边占满面板宽度，组成一个纵向连续序列并在接近视口时惰性渲染；未渲染的页以安静的 3:4 占位块保持位置。代码预览默认显示源码行号，但复制文本不包含行号；纯文本与代码使用相同字号和行高。代码直接坐在分栏自身的背景上，而不是会话卡片的填充色；复制条与占满剩余高度的内部滚动区相邻，因此横纵滚动条都从复制控件下方开始。

<a id="navigation"></a>
## 导航

`ctx.sidebarRight.openResource(address, { params: { line } })` 通过 `file` 参数携带 1 起算的源码行号。在 `text-pages` 模式下，owner 顺序加载到该行或 EOF。纯文本与代码渲染器提供源码行锚点；Markdown 不提供。所选渲染器没有锚点时，导航保持待处理；用户切换到纯文本或代码后执行。代码导航直接滚动内部源码视口。字节模式渲染器不消费源码行导航。每个完成的导航 revision 只响应一次。不带 `revealIfOpened: false` 打开同一文件时聚焦已有 tab，并送达新 revision。

<a id="model-experience"></a>
## 模型体验

无，因为预览是纯浏览器侧的查看器，不注册工具、提示词段或会话事件。

#### KV Cache 影响

无直接影响；用户在这里读到的东西永不进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>
- **预览而非编辑。** 查看器不提供文件编辑或共享搜索接口；目录地址以 `not-regular-file` 失败。未知扩展名使用纯文本读取，仍受其 UTF-8/NUL 检查限制。
- **文本顺序分页，完整文件受限。** 定位到较深处的源码行需要先加载此前各页；PDF、HTML 和图片必须取得 Host `maxFileBytes` 上限内的完整结果。
- **字节视图不恢复滚动位置。** PDF、HTML 与图片的渲染器重新挂载或重新载入时可能回到顶部；图片适配面板宽度、不产生横向滚动，HTML iframe 的滚动属于其不透明浏览上下文。
- **本地 HTML 依赖集合有限。** 只打包直接引用的经典 `.js` 脚本和 `.css` 样式表。浏览器解析的资源仍受浏览器源与网络规则限制；iframe 不获得运行时文件读取桥接。
- **换行图标为包内自绘。** `IconWrapFill16` 与 `IconNowrapFill16` 住在 `src/client/icons.tsx`，直到共享图标集提供为止；它们的 props 已与共享图标契约一致。
- **滚动写入未节流。** 每次滚动事件都把偏移记进 store；行块已 memo 化，于是由此引发的重渲染交还给 React 的是同一批元素。
- **PDF chunk 加载失败后需要刷新页面。** React 会在页面生命周期内缓存被拒绝的 lazy import；已加载正文中的普通 PDF 打开或渲染失败仍可重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。渲染器元数据、文档加载和视图状态归本地注册表与声明的 Slot store 所有，没有可比对的独立运行时来源；注册释放和 tab 生命周期由行为测试覆盖。
