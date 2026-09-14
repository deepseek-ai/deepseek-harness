# Agent Note: 文档预览与文件地址

Status: implemented

[English](2026-09-08-document-preview-operations.md) | 中文

## 问题

文件预览器需要不同的加载策略，同一扩展名也可能对应多种实现。变更流无法同时表达按需读取而又不把实时数据与可调用能力混在一起。HTML 依赖还需要 Host 的文件系统授权和路径解析，而非浏览器的当前目录。

## 决策

Document Preview 将资源观察与内容读取分开。[资源模型](2026-09-05-client-resource-model.zh.md)只按地址共享观察：`source(address)`、`pin(address, signal)` 和提供方的 `open(address, { signal })` 均不携带消费 Session。提供方返回 `AsyncIterable<RemoteResult<ResourceProtocolMap[P]>>`；`useResource` 只暴露 `{ status, value, failure }`。持有只控制观察的启停，不控制底层文件或 Session 的生灭。内容通过普通注入的 Preview 回调读取。

[Workspace Files](../../../../packages/api/workspace-files/README.zh.md) 保留 Host 的行读取、字节窗口、有上限的全文读取和相对另一文件目录的有界读取。Client `file` 提供方只观察 `stat` 与 `changes`，`ResourceProtocolMap.file` 直接为 `WorkspaceFileStat`。Host 通过 Session 文件系统解析每条路径；文件读取继承该后端的读取权限，目录列举与变更观察仍限定于工作区。

可读取的文件使用 `dsh-resource://file/session/<sessionId>/<path>`。路径可以相对工作区，也可以是绝对路径；编码后的绝对路径保留前导斜杠。`fileAddressFor` 始终生成这种 Session 地址。提供方与 Preview RPC 只从该地址取 Session，不取当前选择、首个持有者或 tab 所属 Session。不带 Session 的 `absolute` URI 无法读取；提供方报告 `workspace-file/unknown-workspace`。Session 授权是文件协议规则，不是额外的 Resource 身份。

[Document Preview](../../../../packages/client/ui-sidebar-documentpreview/README.zh.md) 负责格式选择和加载策略。元数据通过 `ctx.documentPreviews` 注册；组件单独注册到 keyed `sidebar.right.tab.document` Slot。扩展注册优先于内置注册，其次比较后缀长度和注册顺序。工具栏仅在候选不少于两个时列出匹配候选，按 tab 记住手动选择；纯文本是兜底，但注册声明为二进制的后缀和 owner 的 unviewable 清单所列后缀除外（[侧边栏预览打磨](../feature/2026-09-11-sidebar-document-preview-polish.zh.md)）。子组件收到累积文本或完整原生字节、原始资源地址，以及标准 `useResource` 和 `useTabInfo` 钩子。Preview 经普通注入调用既有 `read`、`readAll` 与 `readRelated`，在自己的 `rpc.ts` 解码字节。刷新仍按 tab 独立进行，不引入资源 reload、共享 `changed` 确认、额外资源包装层或内容 Session。

Markdown 和代码通过累积的分页文本复用增量渲染原语。HTML、PDF 和图片读取完整 `Uint8Array<ArrayBuffer>` 数据；Host 传输保持 base64。发布后的缓冲区只读借用，绝不持久化进布局或 Session JSON。PDF.js 在自有 Worker 中运行，字体和解码数据以相同版本随包发布，转移输入前先复制，以保留 Preview 的缓冲区。HTML 在 Blob iframe 中运行，设置 `sandbox="allow-scripts"`，不授予同源、弹窗、表单、下载或顶层导航权限。浏览器保持正常的外部网络规则。有上限的静态本地 JS/CSS 读取由父页面负责；不透明源 iframe 创建自己的资源 Blob，因为它不能加载父源创建的 Blob。PNG、JPEG、GIF、WebP、BMP、ICO 和 SVG 使用图片专用 Blob URL，在 `<img>` 静态图片上下文中渲染。比面板宽的图片按纵横比缩小到面板宽度；较小的图片保留固有 CSS 像素尺寸并由 auto margin 居中，较高的图片扩展共享滚动区的纵向范围（[侧边栏预览打磨](../feature/2026-09-11-sidebar-document-preview-polish.zh.md)）。渲染器不提供缩放或拖拽平移。SVG 标记绝不进入应用 DOM 或 iframe，因此脚本保持不可执行，也无法访问父页面。替换 HTML 或图片时会撤销其根 Blob URL。

## 考虑过的替代方案

**把方法挂到 Iterator 或其值上。** 这会混淆观察与命令，并在数据帧中重复能力身份。帧携带数据和失败；显式 Preview RPC 回调负责读取。

**核心公开投影工厂，或在 `open` 内做同样的组装。** 分开的流值、operations 组合与公开接口增加了组装步骤，没有另一个当前消费方需要它。Preview 的共享 RPC 适配已让渲染器无需解码 Session 和 base64。Resource 不提供与提供方无关的命令接口，也不提供绑定于打开实例的命令生命周期；增加任一种都需要文件预览之外的消费方证据。

**把 UI Session 作为额外 Resource 身份，或由首个持有者、当前选择决定授权。** 保留的 tab 可以属于不同于当前选择的 Session，UI 所在位置也不能标识地址指向的文件。将所需 Session 编入文件地址，既保留 Host 授权，也让同地址的所有读者共享观察。

**让所有资源提供文件读取方法。** Chat 与终端资源的数据和操作语义各自独立，只有观察的注册和生命周期是共用机制。

**预览资源包装层、内容 Session 或第二个资源 Hook。** 这些方案重复了 Resource 和 Workspace Files 已提供的寻址、取消、订阅和归属。加载策略属于预览所有者。

**本地服务器、虚拟主机或 `file:` iframe。** 这些方案需要额外托管或文件系统权限。预览面向静态生成页面，而非完整应用运行时；模块、动态文件系统请求和任意嵌套资源图不在支持范围内。

**清理 SVG 后放入应用 DOM 或 iframe。** sanitizer 会增加第二套 SVG parser 和一套持续演进的主动内容策略，之后仍要把不可信标记放进可交互文档。`<img>` 静态图片上下文保留浏览器原生 SVG 渲染与固有尺寸，同时不给标记一个能运行脚本的 DOM。

## 影响

替换渲染器不需要改变 Tab 或文件协议。全文格式承担有上限的整文件内存成本，PDF 增加随包发布的 Worker、字体和解码器字节。格式选择和查看状态仅属于当前页面，不是持久 Session 数据。Preview 独立于元数据观察，拥有 RPC 取消和原生缓冲区。tab 保留读取版本及读取开始时捕获的观察版本；刷新它既不丢弃其他 tab 的内容，也不清除其变更提示。文件读取仍非事务，不透明版本只比较相等性、不排序。[录制的浏览器场景](../../../../apps/web/tests/document-preview.e2e.ts) 覆盖共用工具栏、增量文本、隔离的 HTML 依赖、按宽度适配的位图与 SVG 渲染、不可执行的 SVG 脚本，以及惰性连续 PDF Worker 渲染。
