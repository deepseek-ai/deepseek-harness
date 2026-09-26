---
description: "右侧 Sidebar 的文档预览：共享文件加载与控件，可选 Markdown、代码、图片、PDF、Office 和 HTML 渲染器，并以纯文本兜底。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-documentpreview

[English](README.md) | 中文

## 概述

在右侧 Sidebar 预览文件，并切换已注册的渲染器。Markdown 和代码支持分页文本；PDF、HTML、常见图片和表格接收完整字节；未知扩展名使用纯文本。Word 与 PowerPoint 文档在本地转换为 PDF；表格在浏览器内打开。tab 提供文件状态、渲染器选择、换行以及自动或手动重新载入。插件可在头部和不支持预览的空态中添加本地打开控件。

## 目录

- [注册了什么](#what-it-registers)
- [地址](#addresses)
- [怎么读](#how-it-reads)
- [Excel 预览](#excel-preview)
- [Office 预览](#office-preview)
- [导航](#navigation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

- **类型** —— `ctx.sidebarRightTabs.register(...)`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（这个实现在 tab 系统中的身份，也是其正文注册所用的键），kind `text`，pattern `dsh-resource://file/**`，档位 `fallback`。`canOpen` 只接受 Session 地址，其中路径可为相对或绝对路径；不认领裸 `absolute` 地址。在 `extension` 或 `builtin` 档以更窄 pattern（比如 `*.png`）注册的类型接走那些地址；其他受支持文件落到这里。整个地址就是内容身份，所以不同目录下同名的两个文件、或同一路径在两个会话之下，是两个 tab；解码后的 basename 是 tab 标题，keyed slot `sidebar.right.pane.tab.title` 会在标题前放置按扩展名选择的 `FileTypeIcon`。
- **正文** —— keyed slot `sidebar.right.pane.tab`，键为类型的 id。固定头部在可用时显示 Host 的绝对路径，否则显示请求路径；共享的 [`PathLabel`](../ui-primitives/README.zh.md#component-catalog) 弱化目录颜色，以左侧渐隐保留被裁剪路径的尾部字符，并在悬停时展示完整值。有多个受支持的渲染器时才显示下拉菜单。仅文本兼容的源文件提供纯文本选项；只有一个渲染器时不显示查看器控件。已知的二进制容器后缀没有注册渲染器时，在路径头部下方显示文件类型图标和不支持预览的说明，并且不会发起读取。两个 Session 作用域的 list 子 slot 在文件元数据报出 Host 路径后把当前文件交给其他插件，owner prop 为 `absolutePath`：`sidebar.right.tab.document.actions` 在每个显示头部的状态里渲染在头部自有控件之后；`sidebar.right.tab.document.unpreviewable` 渲染在不支持预览的空态里，以及可读但本预览无法渲染的文件（`not-text`、`too-large`）的空态里，占据原本放重试的位置；载体或未分类的读取失败仍保留重试，不存在或非普通文件的路径只给说明。两者已发布的占位者都是 [`ui-open-in-app`](../ui-open-in-app/README.zh.md)。仅当所选渲染器声明 `wrap: true` 时显示换行开关；图标表示点击后切换到的模式，该偏好按 tab 保存，初始开启。重新载入仍在此头部，不放入 Sidebar 的 tab 条。自动刷新默认开启；独立开关暂时隐藏，状态、文案、样式与切换逻辑保留。正文贴合格的每条边，各渲染器自行提供内容留白，并可拥有内部滚动区。这与 Files tab 右侧预留 2px 滚动条间距的布局有意不同：Preview 使用格的完整宽度，使贴边 HTML 与代码滚动区终止于格的边缘。
- **共享加载与视图状态**，会话作用域、按 tab id 分桶。store 持有累计页或完整字节、读取与观察版本、待处理 Resource 变化、自动刷新状态、加载/失败状态、渲染器选择、滚动位置、换行和已响应的导航 revision。普通 inject face 调用 Remote 读取，并经声明的 store action 写入。重新载入和加载模式变化会淘汰旧请求；tab 的中止信号清理其状态。

文档实现在 `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })` 注册元数据，并以相同 `id` 向 keyed、Session 作用域的子 slot `sidebar.right.tab.document` 注册正文。`binaryExtensions` 列出 `extensions` 中不可按文本阅读的后缀，这些后缀不提供纯文本选项。两处注册都由 effect 持有，通过 `ctx.slots.inject` 等待子 slot。正文接收 `resourceAddress`、`content`、`wrap`、`scrollportRef`、`addResource`、`setResources` 和标准 `useTabInfo`/`useResource` 钩子。依赖成员由 tab 持有的 `ResourceGroup` 管理；替换依赖始终保留根 Resource。内部滚动元素挂载 `scrollportRef`；卸载时恢复共享正文的滚动职责。注册表保留所有匹配备选：`extension`（默认）优先于 `builtin`，随后按更长的后缀、再按注册顺序排列。所选实现仍可用时，下拉选择保持不变。HTML、SVG 和未匹配的扩展名保留纯文本回退，与加载方式无关。

`loading: 'text-pages'` 和 `'bytes-complete'` 使用共享文件读取器。选择 `'renderer'` 时，所选正文在读取任何字节前挂载，并接收 `content: { kind: 'renderer', revision, loaded, failed, reload }`。其注入 face 负责内容加载、错误、store 更新和取消。`loaded(version)` 记录已展示的源版本并结束加载。`failed()` 结束加载但不记录成功版本，使后续文件变化可以重试；已被替换的 revision 所发出的报告会被忽略。`reload()` 增加 revision，正文据此取消并替换当前请求。正文也在卸载和 tab 关闭时取消请求，将已完成内容保留在自己声明的 tab store 中，并在 tab 结束时释放。[Office 预览](#office-preview) 使用此模式，转换后的字节和字体元数据不会进入共享文件 store。

<a id="addresses"></a>
## 地址

tab 使用 `fileAddressFor` 构造的 Session 地址，携带相对或绝对路径。`hostFileOf(address)` 仅从地址取得 Session，不接收外部 Session 参数，也不借用当前或 Tab Session。Host 通过 Session 文件系统解析文件及关联路径，由该后端控制读取权限。任何 UI（包括 Global 组件）都共享同一完整地址的元数据。[Workspace Files README](../../api/workspace-files/README.zh.md) 定义这些规则；渲染器选择不改变导航地址。

全部文本分页加载完成后，Markdown 图片通过已鉴权的 `/api/file` 路由读取绝对文件路径，以及相对于源文档所在目录的路径。相对图片等待 Host 返回文档绝对路径。URL 转义只解码一次；查询参数与片段后缀不计入文件名。HTTP(S) 图片保留原始 URL，加载失败的图片显示 alt 文本。本地图片要求应用基址为 HTTP(S) URL；图片文件不加入自动刷新依赖。

<a id="how-it-reads"></a>
## 怎么读

Web 和桌面端均通过代码工作工具选择 HTML 预览策略。渲染器从插件组装层接收 `interactivePreview`。关闭时，将经 DOMPurify 清理的完整静态文档放入不授予沙箱权限的 iframe：CSP 禁止脚本、外部资源、连接、表单和嵌套框架；所有 `href` 和 `xlink:href` 属性、刷新指令及声明式 Shadow DOM 均在重新解析前被移除。行内样式和 data 图片仍可显示，不读取关联文件。开启时使用下述支持脚本的 Blob 预览。切换模式会卸载之前的框架并中止其待处理关联文件读取。静态预览释放 CSS/JS 的 Resource 订阅，根文件继续监听。其他文档格式保持各自策略。

两种 HTML 模式均将 iframe 初始名称设为 `dsh-sidebar-html-<tab-id>`，供 Desktop 快捷键路由关联目标。这种关联不授予预览访问父文档的权限。

正文通过 `useTabInfo().tab` 读取记录、导航和生命周期。`useResource<'file'>(tab.contentId)` 提供元数据，普通 inject 回调提供内容读取：

- 资源快照仅包含 `status`、`value` 和 `failure`；`value` 是 `WorkspaceFileStat` 元数据。提供方可用后，内容读取无需等待首个元数据帧。观察失败优先于 Preview 的变更提示显示；元数据不可用时保留已加载内容。
- **文本页** —— 纯文本、Markdown 和代码通过 inject 回调调用 `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`。首次挂载读取第一页；滚动到正文末尾或点击 **加载更多** 会读取下一页，直到 `eof`。owner 以 `{ kind: 'text', text, pages, eof }` 提供累计前缀，包含源码偏移和行数。Markdown 和代码增量渲染此前缀，不把每页当成独立文档。第一页之后到达的更新版本页会使读取从头开始，避免混合版本。尚无内容时，失败会以文件类型图标、说明和该失败对应的出路（重试、unpreviewable 子 slot，或什么都不给）填满正文；较晚的失败保留已有内容并在其下提供重试。
- **完整字节** —— PDF、HTML、常见图片和表格调用 `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)`。二进制 Remote 直接返回 `data: Uint8Array<ArrayBuffer>`，供 `{ kind: 'bytes', data }` 使用。Host 的 `maxFileBytes` 上限拒绝超大文件，不截断。PDF 和表格渲染器在传给 Worker 前复制保留的字节，使 Preview 缓冲区仍可使用。字节仅保存在临时视图状态中，绝不进入持久布局或 Session JSONL。加载模式变化会淘汰先前结果。
- **重新载入** —— 手动重新载入仅让当前 Preview tab 通过自己的 Remote 回调重读，保留滚动偏好并淘汰旧请求。`ResourceGroup` 成员变化后，自动刷新使用相同回调。各成员首次元数据仅建立基线，不触发重新载入或首读版本对账；后续在读取期间收到的变化仍会留待下一次刷新。读取既不刷新共享元数据，也不清除其它 tab 的提示。

开启代码工作工具时，HTML 以贴合正文四边的 Blob iframe 运行，沙箱属性严格为 `sandbox="allow-scripts"`，不含 `allow-same-origin`；脚本无法访问父应用的源或文件读取接口。渲染器通过注入的 Remote 回调，加载直接声明的相对 `.js` 经典脚本和 `.css` 样式表；固定安全上限为单个资源 4 MiB、总计 32 MiB、64 个不同资源。Host 代码解析关联路径，带 `baseFile` 的 `readBytes` 返回原生字节。依赖 Resource 在读取返回后加入，使用返回的 `absolutePath`，失败时则使用字符串类型的 `error.details.path`；没有 Host 路径时，Client 不自行猜测。在渲染器内部，base64 仅用于把 iframe 引导载荷嵌入脚本文本。`<base href>` 将依赖解析交给浏览器，HTTPS 资源也由浏览器处理。本地模块 import、CSS `url()`/`@import` 和动态 `fetch` 不使用 Host 文件访问。读取失败、无效 UTF-8 或超出上限都使预览失败，不发布部分资源包。替换或卸载文档会释放其 Blob URL。

PNG、JPEG、GIF、WebP、BMP、ICO 和 SVG 通过 Blob URL 在 `<img>` 静态图片上下文中渲染，带 12px 内边距和圆角。图片默认适应宽度，但不会放大小于面板的内容；100% 使用图片的固有 CSS 像素宽度。共享缩放控件可产生横向和纵向滚动，但不提供拖拽平移。缩放不会替换 `<img>` 或 Blob URL，因此动画图片会继续播放。位图超过固有尺寸后可能变虚，SVG 则继续使用浏览器的矢量渲染路径。SVG 标记绝不进入应用 DOM 或 iframe，因此其中的脚本无法执行，也无法访问父页面。替换或卸载图片会撤销其 Blob URL。

共享文案来自 `sidebarDocumentPreview`；各内置渲染器拥有自己的本地化标签。PDF 与转换后的 Office 预览在浅色模式下使用冷调浅灰底色，在深色模式下使用哑黑底色，页面带有轻微阴影并保留文档原色。PDF 与图片预览共用浮动控件，提供**适应宽度**、25%、50%、100%、150% 和 200% 选项，并在 25%–400% 固定范围内按 25% 逐级缩放。适应宽度是默认模式并跟随面板尺寸；100% 表示 PDF 的 96 DPI 页面尺寸或图片的固有 CSS 像素尺寸。在精细指针设备上，控件初始隐藏；指针进入底部 72 个 CSS 像素时向上滑入，离开 420 ms 后向下退出；控件悬停、键盘焦点、菜单展开和手势进行期间保持显示，无 hover 的设备则始终显示。Chromium 将 macOS 触控板捏合映射到与 Ctrl+滚轮相同的实时指针锚定路径；控件同步显示手势比例，静止后的值在正文重新挂载后继续保留，直至 tab 关闭。HTML 预览不显示缩放控件。缩放稳定或适应宽度发生变化后，视口附近的 PDF 页面按最终缩放比例乘以设备像素比重绘。新位图完成前保留原有画面和可选文字层；屏幕外的页面在接近视口时更新。

首次读取及渲染器准备（包括 Office 转换）共用居中的 28px ongoing `StateDot`，下方显示本地化状态文字“文档渲染中...”。状态向辅助技术提供相同的名称，并遵循减少动态效果偏好。追加文本页时使用紧凑的行内转圈，同时保留已显示的内容。PDF 正文仅在 PDF 预览挂载时加载包内 `client.pdf.js` chunk；PDF.js、Worker 源码和内嵌支持数据不会进入启动 `client.js`。PDF 与转换后的 Word/PowerPoint 页面组成纵向序列，页间距与四周留白均为 12px，露出当前主题的文档背景色；适应宽度会预留此留白，页面在接近视口时惰性渲染；未渲染的页以安静的 3:4 占位块保持位置。PDF.js 官方 TextLayerBuilder 在与画面重合的文字层上管理选区边界和复制文本规范化。配套样式不高亮空白换行；对齐同时考虑 PDF 页面单位、页面旋转与视口宽度变化，页面释放时取消两层渲染。纯图片 PDF 不包含可选取的文字。代码预览使用 tertiary 色的语言名称和带提示的复制图标；换行仍由文档工具栏控制。默认显示源码行号，但复制文本不包含行号；纯文本与代码使用相同字号和行高。代码直接坐在分栏自身的背景上，而不是会话卡片的填充色；复制条与占满剩余高度的内部滚动区相邻，因此横纵滚动条都从复制控件下方开始。

<a id="excel-preview"></a>
## Excel 预览

直接在浏览器中打开 `.xlsx`、`.xls`、`.csv` 和 `.tsv`，支持工作表标签、单元格选择、复制和只读公式栏。XLSX 保留字体、纯色填充、边框、数字格式、富文本、合并单元格、行列尺寸、隐藏行列及工作表，以及冻结标题。XLS 保留已保存的值、公式、数字格式、合并及可用的行列元数据；不支持字体、边框和冻结窗格。工作簿显示已保存的公式结果而不重新计算；缺少的结果保持为空，公式栏旁的紧凑提示会标记显示结果可能不完整或不准确的工作簿。工作簿视图填满预览面板，并随面板尺寸变化自动调整，无需重新加载工作表或选择状态。工作表标签从左侧边缘开始排列；标签溢出时可用触控板横向手势或左右按钮滚动，缩放控件独立占位。表格控件在应用的明暗两种主题下均保持浅色背景和深色文字。触控板的像素位移可同时平移表格的横纵两个方向，包括斜向平移，移动距离跟随手势；冻结标题保持固定。到达工作表边缘后反向移动，仍会保留下一次手势的位移。隐藏选区统计栏及无效的工作表菜单箭头。冻结标题在滚动时保持固定，不显示冻结分隔线和拖拽条。表格预览不调用 Office 转换服务。

XLSX 预览在解析前从内存副本中移除 DrawingML 部件，并忽略工作表的绘图引用。原文件和工作表 XML 保持不变。表格上方的提示列出实际检测到但未展示的图表、图片、形状和条件格式，并建议使用系统应用打开工作簿。未检测到这些内容的文件不显示此提示；公式提示保持独立。

CSV 和 TSV 默认使用表格查看器，也可选择纯文本；CSV 还提供带语法高亮的 Code 预览。两者分别以逗号和制表符分隔字段，支持引号内分隔符、转义引号、多行字段、空字段和不等长行。首行仍作为数据。值保持为字面字符串，包括前导零、日期、布尔值和类似公式的文本。文本文件支持 UTF-8 或带 BOM 的 UTF-16；无效编码会显示转换提示。引号字段格式错误会使表格预览失败，不会静默丢弃数据。

在同一个 `ui-sidebar-documentpreview` 条目上配置 `excel`。这些限制补充 Host 的完整文件读取限制，但不限制浏览器进程内存或解压分配量。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `excel.maxBytes` | `16777216`（16 MiB） | 最大源文件字节数 |
| `excel.maxCells` | `250000` | 所有工作表矩形区域的最大合计单元格数，包含空单元格 |
| `excel.timeoutMs` | `15000` | 解析 Worker 的最长存活时间，单位毫秒 |

惰性 Excel chunk 打包 FortuneSheet、用于 XLSX 的 ExcelJS、用于 XLS 的 SheetJS CE，以及用于 CSV/TSV 的 PapaParse。包内独立于 React 的适配层将解析结果直接映射为 FortuneSheet 单元格，并复用单元格格式化和初始选区。第三方许可证文本保留在发布的 chunk 中；SheetJS CE 保留其 Apache-2.0 条款。每次解析拥有一个独立可释放的 Worker，并传输所保留文件字节的副本；内容替换、卸载、失败或超时都会终止该 Worker。样式表仅作用于 Excel 预览区域。暂不支持图表、绘图/图片、数据透视表、条件格式、编辑、重新计算和导出；字体可用性、Excel 列宽近似和主题色明暗近似会影响保真度。超链接显示为文本，不加载目标地址。ExcelJS 会再次解码 XLSX 字符串公式缓存结果中的实体写法；保存的字面文本 `&lt;` 会显示为 `<`。

只读公式栏以单行按字面显示公式和单元格文本，长内容可横向滚动。复制时保留 HTML 表格，并转义单元格内容，包括已保存的公式结果。[FortuneSheet 补丁决策](../../../.agents/notes/implemented/feature/2026-09-16-browser-excel-preview.zh.md)说明升级依赖时保留这些行为与工作表选区的要求。

固定版本的 [ExcelJS 补丁](../../../patches/exceljs@4.4.0.patch)通过包内关系解析工作簿、样式、共享字符串、工作表、批注、Table 和 VML，支持绝对及相对目标，以及 ASCII 大小写等价的部件名，并按命名空间 URI 识别 SpreadsheetML 和 VML 名称。Strict OOXML 的 SpreadsheetML 和关系 URI 映射到相同的已支持预览功能；这不代表完整支持 Strict 标准。XML 部件支持 UTF-8 及两种字节序的 UTF-16；CDATA 按字面文本读取。绘图和条件格式提示按关系查找内容，不依赖部件目录。未被引用的 `xl/drawings/*.xml` 部件及其关系文件也会被移除，但不会产生提示；批注 VML 保持不变。缺失引用部件或存在大小写等价的歧义 ZIP 条目会使预览失败。解析保留批注和 Table 元数据，但预览器没有专门展示它们的控件。补丁同时覆盖 Node 源码和 `dist/exceljs.js`，浏览器入口选择已修补的 bundle。升级依赖时必须保留两个入口的行为，并通过[独立写入器回归测试和 fuzz 诊断](tests/fuzz/README.zh.md)。

<a id="office-preview"></a>
## Office 预览

将 `.doc`、`.docx`、`.ppt` 和 `.pptx` 打开为 PDF 预览，使用与 PDF 文件相同的加载状态、缩放控件、取消和文本选择能力。[Host 提供方](../../document/office-to-pdf/README.zh.md)负责本地转换，并为其他消费者保留电子表格转换 API。受支持的无效文件、转换失败和超时会显示本地化消息。缺少 Host 服务时显示配置引导。

[Web bundle](../../bundle/web-app/README.zh.md) 以 `ui-sidebar-documentpreview` 挂载本包。通过该条目的 `office` 设置配置临时 Office 缓存；[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-ui-sidebar-documentpreview)定义可接受的值。设置注入到每个页面；修改 YAML 后重新加载浏览器页面。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `office.maxCachedEntries` | `8` | 最多保留的已完成 PDF 数量 |
| `office.maxCachedBytes` | `67108864`（64 MiB） | 最多保留的二进制 PDF 字节数，按缓冲区 `byteLength` 计算 |
| `office.maxPending` / `office.maxReaders` | `8` / `32` | 未完成转换 RPC 数量 / 含元数据查询的读取方数量 |

打开 Office 文件时按需请求转换。每次读取都先检查渲染 generation 和已授权的源文件元数据，再共享进行中的转换或复用成功的 PDF。缓存以渲染 generation、Session、源文件绝对路径和源版本作为身份；通过淘汰最久未使用的 PDF，使保留量符合两项限制。失败和超过字节限制的 PDF 不会被保留。转换后 PDF 的返回渲染 generation 与缓存身份一致时，才会保留该 PDF。取消一个读取方后，共享转换会继续运行，直到最后一个读取方离开。连接重置会清空缓存字节并取消待完成读取；插件卸载还会等待未结束的请求完成。PDF 从不持久化；传输字符串、解码存储和 PDF.js 渲染内存不计入缓存限制。

后台请求为前台工作保留最后一个在途请求槽和读者槽；将任一限额设为一会拒绝后台读取。渲染器替换后会重新执行一次代次查询与授权检查。重试期间再次替换会显示本地化的繁忙提示。

当前 Office 预览缺失字体时，文档工具栏的刷新按钮前显示黄色圆角三角形警告。悬停或键盘聚焦时显示缺失字体数量；点击后打开锚定字体列表。按 Escape、点击关闭或点击外部会关闭列表，警告图标和文档位置保持不变。重新加载会关闭旧详情；没有缺失字体的预览不显示警告。不保留已读或关闭提示的状态。

<details>
<summary>Office 实现——点击展开</summary>

Office 注册、加载、缓存和字体提示位于 `src/client/office/`。注入的 Office face 通过已声明的 store action 写入转换后的 PDF 字节、字体元数据和失败。Office 正文触发加载，将取消绑定到自身生命周期，并声明嵌套 PDF slot，复用惰性 PDF 正文及其 tab 阅读状态。keyed slot `sidebar.right.tab.document.action` 将渲染器操作放在刷新按钮前。Office 操作与正文共享 store，仅读取当前 revision 的字体元数据。Host 渲染器缺失时，注册仍然可用；可选的 `remote.officeToPdf` 和 `remote.workspaceFiles` 注入提供转换与版本检查回调，移除后恢复不可用提示。注册和 tab 状态保留都遵循 effect 生命周期。[转换服务](../../document/office-to-pdf/README.zh.md)拥有 Host Remote 方法，由 `api/remotes` 挂载。

Office Remote 通过 Connection 的 multipart 二进制传输返回原生 `Uint8Array` PDF。渲染器以只读方式借用保留的字节，并在传给 Worker 前复制。

页面刷新快捷键复用所选预览的重载操作，包括旧请求失效与滚动位置保留。头部重载 Tooltip 和 ARIA 组合随有效快捷键绑定更新。

</details>

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
- **Office 转换限制。** 预览不启动原生 Office 编辑器，也不下载引擎。二进制 `.doc` 和 `.ppt` 文件不返回缺失字体诊断。转换保真度与资源限制由 [LibreOffice 提供方](../../document/office-to-pdf/README.zh.md)负责。
- **文本顺序分页，完整文件受限。** 定位到较深处的源码行需要先加载此前各页；PDF、HTML 和图片必须取得 Host `maxFileBytes` 上限内的完整结果。
- **PDF 栅格分配有上限。** 每页位图最多为 16,777,216 像素；超大页面或高像素密度屏幕上的高比例缩放仍可能低于设备分辨率。
- **字节视图不恢复滚动位置。** PDF、HTML 与图片的渲染器重新挂载或重新载入时可能回到顶部；固定 PDF 与图片缩放可产生横向滚动，HTML iframe 的滚动属于其不透明浏览上下文。
- **本地 HTML 依赖集合有限。** 只打包直接引用的经典 `.js` 脚本和 `.css` 样式表。浏览器解析的资源仍受浏览器源与网络规则限制；iframe 不获得运行时文件读取桥接。
- **滚动写入未节流。** 每次滚动事件都把偏移记进 store；行块已 memo 化，于是由此引发的重渲染交还给 React 的是同一批元素。
- **PDF chunk 加载失败后需要刷新页面。** React 会在页面生命周期内缓存被拒绝的 lazy import；已加载正文中的普通 PDF 打开或渲染失败仍可重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。渲染器元数据、文档加载和视图状态归本地注册表与声明的 Slot store 所有，没有可比对的独立运行时来源；注册释放和 tab 生命周期由行为测试覆盖。
