# Agent Note: Sidebar 文本预览与文件树

Status: implemented

[English](2026-09-05-sidebar-text-preview-and-file-tree.md) | 中文

## Problem

右侧 Sidebar 的[停靠基础设施](2026-09-04-right-sidebar-docking-infrastructure.zh.md)与[tab 类型注册表](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)给了插件一个注册 tab 类型的位置，但没有类型的停靠面只是一根空列。三个问题必须先由随包交付的代码答出来，别人才谈得上注册类型：一个新 pane 在承载内容之前显示什么；agent 产出或读过的文件如何不离开产品就能查看；读者如何找到会话从未提到的文件。这些答案还要把类型作者模型完整演示一遍——静态定义、keyed 坑位里的体、类型自有状态用的 Slot store 与 inject face、地址背后活数据用的 `useResource`——让 `ui-sidebar-right` 之外写的类型有一份可照抄的样板，而不只有一份契约。

每个答案都带着代码本身解释不了的产品规则：文本文件为什么按页读而不是整读，文件变了为什么只提示不刷新，文件树为什么是不认领任何地址的页类型，引导页为什么交出自己的 tab 而不是在旁边再开一个。本文为三个随包交付的类型记下这些决定。

## Decision

Sidebar 随包交付三个 tab 类型：**引导页**（`ui-sidebar-right`）、**文档预览**（`ui-sidebar-documentpreview`）与**文件树**（`ui-sidebar-files`）。每个类型都在自己的 `ctx.effect` 里把静态定义注册进 `ctx.sidebarRightTabs`、把体注册进 keyed 坑位 `sidebar.right.pane.tab`（键 = 定义的 `id`），因此类型的寿命恰等于其插件。引导页与文件树是按 kind 打开的页类型；文档预览是以最低档认领 Session 作用域 `file` 资源地址的查看器。类型的控件住在自己的体里；pane 的 tab 条只承载面板自身的动作。文案由各包的命名空间（`sidebarRight`、`sidebarDocumentPreview`、`sidebarFiles`）以 locale 方式持有。

### 引导页

[默认页与关闭保护](2026-09-08-sidebar-default-pages.zh.md)取代本节的默认引导选择；引导页注册、替换和唯一性保持不变。

引导页是 pane 承载内容之前显示的东西。它的注册定义是 `{ id: '@deepseek-ai/dsh-client-ui-sidebar-right/guide', kind: 'guide', priority: 'builtin', title }`，没有 `patterns`：引导页不查看任何东西，所以经 `openTab` 按 kind 打开，并记在页地址 `sidebar://guide` 之下——那是注册表自己的记账，调用方从不拼它。tab 标题是 `开始` / `Start`，在 pane 播种时捕获进布局记录，于是之后切换语言只重标类型，不改已开着的 tab。

正文按 `order` 从每个已注册类型的 `guide[]` 投影入口，并通过注册表可观察的 `guide()` 列表更新，因此后注册的类型无需引导页感知即可出现。[引导起始页与统计 pill 的细化](2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)负责罗盘、可选描述、兜底图标和当前胶囊布局。点选胶囊会调用 `tabActions.openTab(entry.kind, { replaceTab: true })`：被选的类型在引导页自己的 tab 里打开，引导页随之消失。引导页是一扇门，不是留在被打开者旁边的一页。

体同时也是替换接缝。它渲染 `sidebar.right.tab.guide` 链，并以随包交付的引导页作为链的 fallback，于是注册了自己入口的产品接管整个体，而没有入口、或每个入口都拒绝时，随包交付的引导页照常绘制。因为随包交付的引导页是 fallback 而不是链上的一个入口，所以永远恰有一个体，也不可能被意外投掉。

一个 pane 最多持有一个引导页，停靠层把这条作为产品行为强制执行：有引导页时 tab 条的添加控件隐藏，往这样的 pane 打开引导页只是聚焦它，引导页永不复制，被拖拽、落下或回坞进已有引导页的 pane 的引导页并入它（来者关闭）。展开且为空的根 pane 会填入当前默认页。折叠的布局可以保持为空，展开时才选择并创建默认页。

### 文本预览

[Document Preview 决议](../architecture/2026-09-08-document-preview-operations.zh.md)取代本节的渲染器、加载和资源观察细节。兜底 tab 注册、分页源码导航与正文自有控件仍然有效。

`text` 是 Session 作用域文件的兜底查看器。它的注册定义是 `{ id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', kind: 'text', patterns: ['dsh-resource://file/**'], priority: 'fallback', canOpen, title: basenameOf }`。`canOpen` 只接受解析后 scope 为 `session` 的地址。pattern 含 `:`，因此匹配整个地址；`fallback` 是最低档，所以 `extension` 或 `builtin` 档上一个 pattern 更窄的类型（比如 `*.png`）接走那些地址，其余一切落到这里，而 text 类型对任何文件都留在候选列表中。`id` 是包名，兼作体坑位的 `key`，于是一个接管了 `text` kind 的扩展不可能让坑位误拿到这个体。标题是地址解码后的最后一段：整个地址仍是内容身份——不同目录下同名的两个文件、或同一路径在两个会话之下，是两个 tab——只有 chip 上的文字被缩短。

tab 使用 `dsh-resource://file/session/<sessionId>/<path>`，其中路径可以是相对路径或绝对路径（[Workspace Files](../architecture/2026-09-05-workspace-files-service.zh.md)负责该语法与 `fileAddressFor` / `parseFileAddress` 辅助函数）。`hostFileOf` 只接受这种 Session scope，并从地址取得 Session 与路径；不认领不带 Session 的 `absolute` 地址。被认领的地址若格式错误，则作为程序错误抛出。

元数据与内容来自不同的地方。`useResource<'file'>(tab.contentId)`——[client 资源模型](../architecture/2026-09-05-client-resource-model.zh.md)提供的全局标准 hook——产生 `WorkspaceFileStat`；正文把其观察版本与已加载内容版本比较。Preview face 通过 `remote.workspaceFiles.read` 读取文本，通过 `readAll` 读取完整字节。后续文本页若来自更新版本，则从第一页重新开始；被重载或 tab 销毁淘汰的请求不能再写入。[Document Preview 决议](../architecture/2026-09-08-document-preview-operations.zh.md)负责各渲染器的加载方式。

store 是 Slot 标准件：每会话一个独占实例，按 tab id 分桶，持有 `{ version, pages, eof, loading, failure, scrollTop, wrap, revision }`。按 tab 而非按文件分桶是有意的——同一文件的两个 tab 各自滚动。face（`loadPage`、`reloadPages`）是唯一的异步半边：它标记读取进行中，等待 Remote 结果，再经 store 的 action 写入一页或一次失败；若 owner 的 `signal` 已触发则什么也不写。`signal` 同时终结这个桶：face 在 tab 首次读取时挂一个 abort 监听器，由它忘掉桶——不是体，体随 tab 切换反复挂载卸载；从未读过的 tab 没有桶也没有监听器，而 tab 记录可能在其体被另一 tab 挡住而卸载时结束。因此滚动位置、换行与已答过的导航都活得比体久：tab 回来时停在读者离开的地方，而不是重读或再跳一次。刷新页面后什么都不保留。

导航是一个 `line`。`read` 工具行把它 1 起的 `offset` 以 `openResource(address, { params: { line } })` 传来，产物 chip 什么都不传；体把 `navigation.params` 收窄为 `SidebarRightResourceParamsMap['file']`（`{ line?: number }`，由 `file` 类型的拥有者声明），不做运行时校验，因为调用方与体相遇在同进程的类型化边界上。已加载的页够不到该行时，体读下一页，再读，直到覆盖它或文件结束——页按顺序加载，没有 seek——然后把该行滚到体顶部并高亮，每个 `navigation.revision` 一次。store 记下已答过的 revision，于是同一 revision 下重新挂载的体恢复滚动位置而不再跳；对同一文件再次 `openResource`（聚焦而非复制）以新 revision 到来并再跳一次。超出文件末尾的行在 `eof` 处静默停下；补页途中失败的页终止补页并显示失败行。

文件变了只提示，不应用。正文把已加载版本及读取开始时捕获的观察版本与后续 `WorkspaceFileStat.version` 比较；不同则显示变更提示。重新载入只通过 Preview face 重读当前 tab，不修改共享资源元数据或其他 tab。资源失败占用同一个提示位置，已加载内容仍保留在下方。

正文头部为一行：左侧显示完整文件路径，右侧放匹配渲染器菜单、按条件出现的换行开关和重新载入按钮。[Document Preview README](../../../../packages/client/ui-sidebar-documentpreview/README.zh.md)负责当前控件、渲染器行为与滚动方式。预览占满 pane 正文的全部高度。

读取失败时保留已显示的内容，并增加本地化失败说明与重试操作。Preview 为可处理的文件错误提供专用文案，其他代码使用载体消息兜底；`outside-workspace` 属于目录列举，不是 Preview 专用失败。

### 文件树

`files` 是页类型，不是查看器：它不认领任何地址。注册定义是 `{ kind: 'files', id: '@deepseek-ai/dsh-client-ui-sidebar-files', priority: 'builtin', title, guide: [{ order: 10, title, description, icon: FolderSheetGlyph }] }`——没有 `patterns`，因为没有谁按地址导航*到*一棵文件树；引导页的入口框打开的是类型本身。`FolderSheetGlyph` 把共享的彩色文件夹页适配到引导页请求的图标尺寸；[引导页细化记录](2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)负责这项展示选择。`id` 是这个实现在 Tab 系统里的唯一键，同时也是体坑位 `sidebar.right.pane.tab` 的 `key`，于是同一个串既命名类型也命名画它的组件。`register()` 返回 disposer 并经 `ctx.effect` 注册，与所有注册一致。

根是 Host 在会话列表里上报的会话工作目录（`useSessions().byId[sessionId].cwd`），标签由 `dsh-util-workspace-path` 的 `workspaceTitleOf` 给出——路径最后一个非空段——路径只有分隔符时用根串本身作标签。没有工作目录的会话只显示一行（`noWorkspace`），不发请求。没有根选择器，也不能往上浏览：Host 的 `list` 拒绝会话工作区根之外的路径，所以客户端能列的那一个目录就是它显示的目录。

树不是一个资源，这决定了它的状态住在哪。逐层懒加载的目录列表是类型自己拥有的视图状态，所以它住在 Slot 标准的独占 store（每会话一实例）里、按 tab id 分桶：`{ root, levels, expanded }`，`levels` 以绝对路径为键取 `loading | ready | failed`，`expanded` 是当前展开的绝对路径集合，含根。资源有一个地址和一个当前值；一棵为每个展开层钉一个资源的树，会让资源模型背上「读者展开了哪些目录」，而那是类型的事。`useResource` 留给只有一个地址的内容。

face 是树唯一的异步半边。`start(tabId, root, signal)` 以根展开态播种桶并列出根；`toggle(tabId, path, loaded, signal)` 翻转展开集合并只在第一次列出该层；`load(tabId, path, signal)` 标 `loading`，调 `remote.workspaceFiles.list(sessionId, absolutePath, signal)`，写 `ready` 或 `failed`。适配层保留列表的 `entries` 与 `truncated`、丢弃其工作区相对 `path`：树里每个键都是绝对路径，子键 = 父路径以 `/` 拼上条目名。折叠保留该层，再展开直接从内存画不再请求；失败的层同样保留、再展开不重试——重试靠重新读取。owner 的 `signal` 终结一个桶：abort 时忘掉该 tab，其后才结算的列表什么也不写，已挂载的体也不会给 signal 已触发的桶重新播种。

行序是读者的序，不是端点的序：目录在前，文件与其他条目在后，组内按 `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`，于是 `file2` 排在 `file10` 前、大小写不拆开列表。dotfiles 与其他名字一样显示；Host 返回的东西树一个不过滤。三种条目类型画法不同：`directory` 是带 `aria-expanded` 的按钮、开/闭文件夹图标，子层每级缩进 14px；`file` 是带文档图标的按钮，没有大小列；`other`（符号链接、套接字、设备）是灰色、不可聚焦的 span，带 `aria-disabled` 与「不能打开」的提示，这样目录被完整报告，又不提供一个注定失败的点击。被 Host 按 `maxEntries` 上限截断的层在条目末尾以 `truncated` 标记收尾；空层显示 `empty`；进行中的列表在其目录下显示 `loading`。

点文件即 `tabActions.openResource(fileAddressFor(sessionId, root, absolutePath))`：条目在树根之下的绝对路径成为每段百分号编码的 `dsh-resource://file/session/<sessionId>/<相对根的路径>` 地址。树从不指名查看器：由注册表的认领决定谁画这个地址（今天是 `fallback` 档的 `text`），一个在其上认领 `dsh-resource://file/**` 的扩展接走点击而树无需改动。打开落在点击时文件树 tab 所在的那个 pane，同地址已开着的 tab 被聚焦而不复制——两者都是导航控制器的缺省。用户明确拍过：从树里打开的文件不强制分格；它在树所在处开一个新 tab。

重新读取是树唯一的控件，是根标题行右端的图标按钮（`reload`）。它重置所有层，并恰好重新列出 `expanded` 里的那些路径；曾列出后又折叠的层被丢弃，下次展开时重新拉取。控件住在体内，因为类型的控件属于它的体：pane 的 tab 条只承载布局库与面板自身的动作，不存在按类型的工具坑位。树不监听文件系统；一层只在重新读取或首次展开时变化，`changes` 流是文本查看器的事。

文案是 `sidebarFiles` 命名空间，十三个键。行状态：`loading`「正在读取…」/ "Reading…"，`empty`「空目录」/ "Empty directory"，`truncated`「条目太多，只显示了一部分。」/ "Too many entries; showing only some of them."，`noWorkspace`「这个会话没有工作区目录。」/ "This session has no workspace directory."，`entry.other`「这不是文件或目录，没法打开。」/ "Not a file or a directory, so it cannot be opened."，`reload`「重新读取」/ "Reload"。失败行按 Host 错误码一码一句、以目录为主语：`workspace-file/not-found`「这个目录不在了。可能已被移动或删除。」/ "That directory is gone. It may have been moved or deleted."，`workspace-file/outside-workspace`「这个目录在工作区之外，侧栏不会读取它。」/ "That directory is outside the workspace, so the sidebar will not read it."，`workspace-file/not-directory`「这不是一个目录。」/ "That is not a directory."；其余任何失败，无论载体层还是未分类，显示 `error.unavailable`「读取失败：{message}」/ "Read failed: {message}" 并带上失败自身的消息，因为树对传输级错误没有什么有用的可补充。

## Alternatives considered

**给活跃 tab 的控件开一个按 pane 的工具坑位（`sidebar.right.pane.tab.tools`）。** 为文本预览的换行与重新读取、文件树的重新读取交付过一轮评审，随后按用户意见删除：它把类型私有的按钮放到面板 tab 条上、分栏与折叠控件旁边，读起来像面板自身的 chrome。类型的控件属于它自己的体；预览的在其路径行右端，树的在其根行右端。

**保留 `Show in folder`。** 目录在 Sidebar 里没有去处，而产品决定是不给桌面打开器留次级入口。已删除，能力损失如实陈述：`openFile('.')` 命名的是目录，文本预览以 `not-regular-file` 拒绝它，于是该行什么都不提供，而不是给一个注定失败的按钮。

**把内容放进资源流。** 内容可以任意大，所以 `file` 资源只携带元数据（`version`、`bytes`、`changed`），预览经 `workspaceFiles.read` 按页读内容；`changed` 是通知，不是载荷。

**重新载入重取所有已加载过的页。** 相对于已交付规则（丢掉所有页、重读第 1 页）的另一条路。未采纳：重取已加载范围意味着显示任何东西之前要先做多次顺序读取，而 agent 编辑之后的已加载范围也不再描述同样的行；读者保留滚动位置，在已加载文本末尾继续要更多。先前视口在文件深处时读者的位置可能落到空白，这一点在 Consequences 里如实陈述。

**文件变了就在读者眼前刷新文本。** 否决：在读者眼前重载会丢掉他的位置，而 agent 正在写的文件会反复变化。提示条等点击。

**整文件读取，或可 seek 的页。** 整文件读取没有上界；可 seek 的页需要 Host 不维护的行索引。页从第 1 页起按顺序加载，导航到深处某行时逐页补到覆盖为止——代价在 Consequences 里陈述，seek 推迟。

**在运行时校验 `line`。** 第一版接受 `unknown` 参数，非正整数一律视为没有请求。`params` 类型化之后否决：`file` 类型的拥有者在 `SidebarRightResourceParamsMap` 中声明 `{ line?: number }`，调用方与体相遇在同进程的类型化边界上，仓规是那里不加运行时校验。

**每种地址都从坑位取读取的会话。** 第一版在体被挂载的会话下读取。只对不命名会话的 `absolute` 作用域保留：`session` 地址带着自己的会话，正是为了让同一相对路径在两个会话里是两个文件。

**换行默认关。** 第一版。用户评审后反转：预览列很窄，长行横向滚动会把文字藏起来；换行默认开直到读者关掉，按 tab 记。

**靠改布局库的 `.paneBody` 来撑满 pane。** pane 体是高度确定的块级滚动容器，不是 flex 容器，所以预览的 `flex: 1` 不起作用，pane 体滚动着一个 30,000px 高的预览。否决，改为在预览根上取 `height: 100%`：修复属于类型自己，布局库对其体保持无知，文件体成为唯一的滚动者，于是头部不动、跳行滚动的也是正确的元素。

**store 按文件而非按 tab 分键。** 否决：同一文件的两个 tab 是两个阅读位置；页可以共享而视图不能，省下的只是一次页读取。

**包内自造 `file:///` 地址，以及包内自写 basename 作树的根标签。** 否决：文件地址必须带自己的作用域——以其根解析相对路径的会话，或绝对路径本身——因此用共享的 `fileAddressFor`；一个 `workspaceTitleOf` 服务所有工作区标签面。

**把整棵树建模为一个资源。** 否决：资源有一个地址和一个当前值，一棵为每个展开层钉一个资源的树，会让资源模型背上「读者展开了哪些目录」，而那是类型的事。

**引导页作为链上的入口而非链的 fallback。** 否决：随包交付的引导页若是一个入口，产品的替换者与它会同为候选，胜者取决于注册顺序；作为 fallback 则永远恰有一个体，且不可能被意外投掉。

**引导页在自己旁边打开被选的类型。** 否决：引导页是一扇门，一个同时持有引导页与它所打开内容的 pane 会显示一扇不再通向别处的门；`openTab(kind, { replaceTab: true })` 把 tab 交出去。

## Consequences

- `ui-sidebar-right` 之外写的类型有了一份完整样板：`ui-sidebar-documentpreview` 演示一个查看器——由地址推出的读取、按 tab 分桶的独占 Slot store、inject face、类型化的导航参数与体内自有控件；`ui-sidebar-files` 演示一个带引导入口、懒填充 store 的页类型；引导页演示一个链 fallback。
- 按页读取让每次请求都有界（`maxLines` 行、`maxBytes` 字节），代价是一个 **加载更多** 控件、没有总行数，以及到深处某行的顺序补页；导航到一个大文件的第 40,000 行要先读八页。
- 只提示不应用，让读者在 agent 反复写入期间保住位置，代价是点击之前显示的是旧文本；外部编辑永不提示。
- 重新载入只读第 1 页，所以身在文件深处的读者重载后回到文件开头再往后翻；滚动位置保留但可能指向已加载文本之外。
- 按 tab 的视图状态跨 tab 切换与重新挂载存活，随 tab 或页面一起消失；什么都不持久化。
- 文件树渲染 Host 列出的一切，因此大目录最多显示 `maxEntries` 行加一个标记，没有搜索或过滤，读者靠逐层展开找到深处的文件。
- 三个类型面向用户的每条文案都由 locale 持有并列在本文中，文案评审只需读一处。

## Testing

文本预览的 `tests/` 覆盖：注册表认领与让位（经真实的 `SidebarRightTabRegistry`）、地址翻译（`sessionFileOf` 接受 `session` 作用域、其他一律抛错）、store 的页、版本、reset、视图与 forget 各 action、face 的进行中、失败、abort 与重载路径、页算术（`linesOf`、`offsetsOf`、`lastLineLoaded`）、体的首读、加载更多、重试、变更提示条、导航补页、只跳一次、重新挂载、换行默认与切换、头部控件与 abort 即忘、失败行映射，以及插件的各项注册与 dispose 时的撤销。针对已构建应用的 Chromium 探针记录了撑满与滚动的数字（`.artifacts/sidebar-tab-types/app-probe.log`，`ROUND3`）：短文件的预览高度等于 pane 体内容区高度，长文件在预览体内滚动，pane 体从不滚动。文件树的 `tests/` 覆盖排序、懒加载、折叠记忆、重新读取、三种条目类型、截断与失败行，以及 abort 即忘。`apps/web/tests/sidebar-right.e2e.ts` 经真实 Remote 载体把会话里的产物文件打开进预览。`apps/web/tests/document-preview.e2e.ts` 覆盖居中的固有尺寸图片、双轴图片滚动和不可执行的 SVG 脚本。

## Deferred

- 虚拟化或可 seek 的分页加载（页按顺序加载）、恢复已加载范围的重新载入、节流的滚动位置持久化，以及 `ui-primitives` 里的换行图标。
- 搜索、总行数与文件末尾标记。
- 文件树的搜索、产物过滤、拖拽、重命名、右键菜单、高亮当前文件、文件系统监听，以及浏览到工作区根之上。
- 引导页文案的产品评审，以及一个类型贡献多个入口时引导页的行为。

## Related

- [右侧 Sidebar 停靠基础设施](2026-09-04-right-sidebar-docking-infrastructure.zh.md)——面板、pane 与引导页每 pane 一个的规则。
- [Sidebar tab 类型与导航](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)——这些类型消费的注册表、档位、`id`、`openTab` / `openResource` 与 owner props。
- [Client 资源模型](../architecture/2026-09-05-client-resource-model.zh.md)——`useResource` 与 `file` 协议的元数据。
- [Workspace Files 服务](../architecture/2026-09-05-workspace-files-service.zh.md)——地址语法、`stat` / `read` / `list` / `changes`，以及失败行所映射的错误码。
