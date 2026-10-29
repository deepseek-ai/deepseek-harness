---
description: "dsh Web 客户端右侧 Sidebar 的工作区文件浏览器：文件页，以及停靠与浮动文件预览旁每个分栏一棵的工作区目录树，通过网络逐层列出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

[English](README.md) | 中文

## 概述

在预览文件的同时浏览 Session 的工作区目录树。每个分栏（停靠或浮动）保留一棵树，分栏内的每个文件 tab 都显示它：切换、打开或关闭文件时保留其宽度、展开状态与滚动位置，并标出当前文件。预览旁的目录树在该预览的位置打开文件；`files` 页则在右侧 Sidebar 默认落位的新 tab 中打开文件。根目录与已展开目录通过直接子项监听自动刷新，手动重新读取仍可用。`files` 页从引导页进入，不认领资源地址。

## 目录

- [注册了什么](#what-it-registers)
- [导航栏](#the-navigator)
- [树](#the-tree)
- [复用目录树 Factory](#tree-factory)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

命令 `workspace.files` 在焦点分栏内显示画在停靠 tab 内容旁的导航栏，并把键盘焦点移到目录树，保留该 tab；从聊天区触发时使用当前会话的活动停靠分栏。其他情况下（文件页本身、不带导航栏的 tab、没有工作目录的会话、浮动 tab）打开或聚焦文件页，文件页的目录树始终显示。文件页替换开始页，同一分栏内重复打开仍保留一个文件页。桌面默认键为 Mod+P。开始页入口显示有效快捷键；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 默认不绑定此命令。

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `files`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-files`，档位 `builtin`，没有 patterns，另有一个打开该类型的引导页入口（order 10，标题与描述取自 `sidebarFiles` 命名空间，图标为黄色文件夹）。
- **文件页正文**：以该 id 为键的 `sidebar.right.pane.tab` slot。其标题行横跨页面，通过共享的 [`PathLabel`](../ui-primitives/README.zh.md#component-catalog) 显示根路径，目录使用弱化颜色，最后一段使用主色；路径过长时保留尾部字符并在左侧渐隐，悬停显示完整路径。末端依次是目录树的重新读取控件、由文件页注册声明的 Session 作用域 `sidebar.right.tab.files.actions` 列表（通过 `absolutePath` 传入当前显示的根目录），顺序与预览标题行末端的重新读取与文件操作一致；[`ui-open-in-app`](../ui-open-in-app/README.zh.md) 在此提供工作区目录打开按钮。标题行下方由该分栏的导航栏铺满整页，停靠与浮动时都一样，这里没有开关。
- **各行**：root 作用域的 Component Factory `sidebar.files.tree`，接收调用方的条目和局部 `accessory` slot；见[复用目录树 Factory](#tree-factory)。
- **导航栏**：Session 作用域的 Component Factory `sidebar.files.navigator`。文件页正文和 [`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.zh.md) 直接渲染它，显示在每个预览旁，无论停靠还是浮动。它只绘制目录树及其调整宽度的边缘，没有自己的标题行：预览旁只有预览自己的标题行，目录树的重新读取与目录操作留在 `files` 页上。
- **开关**：Session 作用域的 Factory `sidebar.files.navigator.toggle`，在预览头部末端直接渲染，传入 `useTabInfo`。两个 Factory 共用文件页的 store handle 和 inject face，每个分栏保留一份开关状态；文件页正文没有开关。
- **标签页标题**：以该 id 为键的 `sidebar.right.pane.tab.title` slot：类型标签前的一枚 16px 共享 `FileTypeIcon` 文件夹图标。树本身的行不画这枚图标。

[注册入口](src/client/index.ts) 在共享 [files face](src/client/face.ts) 与[分栏 store](src/client/store.ts) 上组装文件页、导航栏、开关和目录树 Factory。

<a id="the-navigator"></a>
## 导航栏

用 `FileNavigatorInput` 渲染 `sidebar.files.navigator`：`{ useTabInfo, page, onOpen }`。必填的 `onOpen: (address: string) => void` 回调由容纳它的插件提供；导航栏构造文件地址，不决定落位。`page` 只控制呈现：`true` 时始终铺满文件页，`false` 时遵循预览所在分栏的偏好与可用宽度。

导航栏画在横跨分栏的预览标题行下方，位于它与正文共用的那一行的右侧。在预览旁，是否显示由其分栏的记录决定：分栏默认隐藏，这一选择对分栏内的每个文件 tab 都有效，直到开关、Escape、工作区命令，或导航到被目录树遮住的预览改变它。自身没有记录的分栏（例如 tab 拖出后所在的浮窗）从隐藏、默认宽度开始。点击目录树以外的地方不会隐藏它；在另一分栏打开内容也不会隐藏它。在文件页上，目录树铺满标题行下方的整页，停靠与浮动时都一样，不显示分隔条，且始终显示：文件页不画开关，Escape 也不关闭它。文件页打开的文件沿用落定分栏自己的选择，尚未做过选择的分栏为隐藏。

其宽度是分栏的偏好，在读者用主键拖动左缘分隔条，或用方向键、Home（最窄）、End（最宽）调整之前为 260px，并限制在这一行内：行宽允许时至少 180px；与正文并排时至多为行宽减去 336px，悬浮时至多为行宽减去 120px。在预览旁、视口至少 768px 时，face 测得的行宽决定三种布局之一。行宽至少 560px 时，导航栏是正文旁的浮起面板，距行的上、右、下边缘各 8px，与正文相隔 8px；正文让出面板及其外边距的宽度而变窄，但至少保留 320px。行宽在 400px 到 560px 之间时，同样的面板悬浮在正文右侧之上，因此正文保持完整宽度，面板未覆盖的部分仍可滚动、可交互；正文的滚动条和渲染器的吸顶工具栏在面板下方的部分会被它遮住。两种面板都带圆角：浅色模式采用浮动停靠面板的背景与阴影，深色模式采用与紧凑目录树一致的深背景和柔和白色阴影。560px 这一界限只取决于行宽，因此调整目录树宽度不会让它在两种布局之间切换。在窄于 400px 的行中，或窄于 768px、右侧 Sidebar 以全屏呈现面板的视口中，导航栏铺满标题行下方的整行，不显示分隔条，导航到该预览后会隐藏目录树，让文件显示出来。铺满时，被覆盖的正文及其内嵌框架会隐藏，不能通过键盘进入。若行宽或视口进入此布局时正文持有焦点（包括目录树首次绘制时），焦点移到目录树内，不改变分栏的开关选择。浏览器可能在新宽度报告之前就让被隐藏的正文失焦；除非读者在报告之前移动了键盘焦点或指针，或窗口失去焦点，这一焦点同样移到目录树内。停靠与浮动分栏遵循相同规则；目录树开启时，在每种布局下浮窗的缩放手柄都仍可操作。在预览旁，从这一行内的正文或目录树传到页面 document 的不带修饰键的 Escape，在任何行宽下都会关闭导航栏，并把键盘焦点移到开关上；内嵌框架的 document 持有焦点时，按键不会冒泡到页面 document，因此导航栏保持打开。Escape 在 document 上接收，晚于这一行自己的处理器，因此行内处理器若阻止了默认行为，这次按键就留给它。

预览的 `onOpen` 传入 [`replaceTab: true`](../ui-sidebar-right/README.zh.md#ctxsidebarright)；文件页在停靠时传入 `{ paneId: panel.id }`，浮动时省略落位。右侧 Sidebar 负责原位替换、默认停靠落位与揭示。原位替换保留分栏的目录树。目录树持有键盘焦点时，若打开操作在同一分栏内替换或切换 tab，下次绘制会聚焦当前文件所在行；揭示其他分栏时，发起侧的目录树与焦点保持不变。

新的 `tab.navigation.revision` 只关闭目标预览的目录树，而且仅在它按目标当前宽度铺满内容行时关闭。该规则适用于任何导航来源，包括从浮动预览自己的目录树发起的打开。隐藏的目录树也消费导航，因此手动显示它不会重放旧的关闭操作。普通 tab 切换、浮出或停靠，以及刷新或 undo 恢复的 revision `0` 都不关闭目录树。files face 的消费记录按 tab 生命周期保存；导航订阅在 tab 关闭或插件卸载时释放。文件页始终可见的目录树不因导航而关闭。

树用 `aria-current` 标出当前文件所在行。目录树绘制期间，分栏内尚未定位过的文件会逐层展开其已列出的祖先目录，并把该行滚动到可见区域；保留的某一层正在重新列出时（例如隐藏的目录树重新显示，或收起的目录重新展开），定位会等它列完，再认定其中缺少的名称不存在；分栏记住上次定位的文件，因此同一 tab 重新挂载时既不改变展开状态，也不改变滚动位置。定位期间读者收起某个目录会结束这次定位，分栏把该文件记为已定位。工作区根目录之外的文件或其他 Session 的文件不会被定位；在 Windows 盘符或 UNC 根目录下，判断是否位于根目录内时不区分大小写和斜杠方向，在 POSIX 根目录下区分大小写。

<a id="the-tree"></a>
## 树

根是会话的工作目录，读自 `useSessions().byId[sessionId].cwd`。`/` 和 Windows 盘根等文件系统根路径均可作为树的根。每一层以绝对路径为键；子路径是父路径以 `/` 拼上条目名。一层在首次展开时经 `@deepseek-ai/dsh-api-workspace-files` 命名空间的 `remote.workspaceFiles.list(sessionId, absolutePath)` 列出。各行由[目录树 Factory](#tree-factory) 绘制并排序；`workspace-tree.ts` 传入每个已列出的条目，名字取目录列表中的拼写，类型作为 `meta.kind`，根的键去掉末尾分隔符，并传入已本地化的失败行。Factory 自行从 files locale 读取文案。dotfiles 与其他条目一样显示。

| 条目类型 | 行 |
|---|---|
| `directory` | 切换展开与折叠；再次打开时重新列举，并恢复仍存在的已展开后代。折叠期间保留已显示条目的缓存。 |
| `file` | 按[导航栏](#the-navigator)所述打开 `dsh-resource://file/session/<sessionId>/<encoded path relative to the root>`，地址由 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` 从条目的绝对路径与树的根生成。没有已注册的 tab 类型能打开该地址时（例如未启用 `ui-sidebar-documentpreview`），该行灰显、不可点击并说明原因；一旦有能打开它的类型注册，就变为可点击。 |
| `other` | 灰显且不可点击，从而完整呈现目录内容。 |

被端点条目上限截断的层以一条标记收尾；空层如实说明；失败的层按错误码各显示一行（`workspace-file/not-found`、`outside-workspace`、`not-directory`），其他情况显示传输层自己的消息。重新读取就地刷新根与展开中的层，读取期间保留显示条目，不重置整棵树；折叠的层在下次打开时重新拉取。没有工作目录的会话只显示一行说明，而不是树。

状态保存在绘制之外，以 `useTabInfo().panel` 报告的分栏 id 为键。类型自己的存储按分栏保存导航栏的 `open` 选择与 `width`，以及首次显示后的 `tree`：`root`、`levels`（每个绝对路径的 loading / ready / failed，ready 层重新列出期间标记 `refreshing`）、`expanded` 与 `autoRefresh`。分栏内的每个文件 tab 读取同一份记录，因此切换、打开或关闭 tab 时导航栏重新绘制，已加载的层、展开状态、宽度与滚动位置保持不变；切换 tab 不会重新列目录。隐藏目录树，或只显示不带目录树的 tab，会关闭其目录监听；再次显示时就地重新列出根目录与已展开的目录，期间保留的行照常显示。根目录不是 Session 当前工作目录的树会被替换，其滚动位置与已定位文件随之重置。分栏在显示导航栏、或仍有打开的 tab 最近一次在该分栏绘制导航栏时保留其目录树：移到另一分栏的文件 tab 显示那个分栏的目录树；原位替换的 tab（如选中的文件替换预览）保留它；浮动或停靠 tab 本身从不终结它。最后一个这样的 tab 关闭或在别处绘制导航栏后，分栏的目录树即被忘掉。文件页与每个预览的导航栏在同一 Session 中共用一个 face。

每个打开的 `DirectoryNode` 在目录树绘制期间持有自己的目标监听；折叠关闭该节点及其不可见后代。祖先恢复期间的展开状态变化会更新存储和待恢复节点，后代恢复时遵循最新展开偏好。自动刷新默认开启；独立开关暂时隐藏，状态、文案、样式与切换逻辑保留。目录读取期间或收尾时收到的变化仍会留待下一次刷新。

文件行提供共享[右键菜单](../ui-context-menu/README.zh.md)，不会同时触发普通点击导航。文件夹行和根路径使用 `directory` 操作对象，提供本机显示位置和复制路径操作，不会展开目录。

<a id="tree-factory"></a>
## 复用目录树 Factory

要绘制工作区列表、变更文件或本地 diff，在模块级声明 `const TREE_OPTIONS = { slots: { accessory: ModuleLevelComponent }, fallback: null }`，再调用 `renderFactorySlot('sidebar.files.tree', input, TREE_OPTIONS)`。保持 options 及其 `slots` 对象稳定；重新创建局部选择会让整棵树随父组件渲染而重画。该 root 作用域 Factory 仅在 files 插件加载时可用；未加载时，`renderFactorySlot` 绘制传入的 `fallback`，省略时不绘制内容。从 `@deepseek-ai/dsh-client-ui-sidebar-files/client` 仅以类型方式导入声明以及 `FileTreeInput`、`TreeEntry`、`TreeEntryMeta`、`TreeEntryKind`、`TreeDirectoryState`；不导出组件值。

`FileTreeInput` 携带 `root`、扁平 `entries`、`expanded`、`onToggle(entry, expanded)` 和 `onOpen(entry)`。可选的 `directories` 按键提供加载、本地化失败和截断状态；`current` 与 `currentRef` 标记并提供当前文件按钮。`canOpen(entry)` 可以拒绝打开文件而不禁用其附件。`rowTriggerProps(entry, kind)` 为文件夹行和可打开的文件行提供右键菜单处理器。Factory 通过 files locale 拥有加载、空目录、截断与不可用文案；调用方负责数据访问、展开、打开、祖先定位和滚动。

`TreeEntry` 为 `{ path, name, meta?: { kind?, hidden?, size? } }`。只有 `/` 分隔层级；父级是最后一个 `/` 前的部分，没有 `/` 时为 `root`。名字保持调用方传入的值；重复路径保留首个条目。根键条目被忽略，包括空根。缺少的中间目录只补一次，显式条目优先。省略 kind 时，路径下有条目则为目录，否则为文件。隐藏行用弱化文字颜色显示，不过滤；大小不显示。只有可见层排序，目录优先，再按名字的自然顺序、不区分大小写排列；各层保留排序缓存，直到名字或目录类型变化。

局部 `accessory` slot 使用 root 作用域，owner props 为 `{ entry: TreeEntry }`；其组件还可使用派生的 `FactoryLocalComponentPropsOf<'sidebar.files.tree', 'accessory'>` 席位。它只收到 `entry` 和 Factory 自己的席位，拿不到调用方的 store 或 inject face。传入模块级组件以保持身份稳定。附件位于主按钮旁，不在其操作或禁用范围内。默认组件不渲染内容。附件包装容器始终存在于 DOM 中；未提供 slot 或其组件返回空内容时，CSS 将其隐藏且不占用行空间。

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器里绘制工作区文件树，不注册任何面向模型的内容。

#### KV Cache 影响

无；目录列表经 Remote 传输，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **只有列目录。**没有搜索、产物过滤、拖拽或重命名。
- **只有一个根。**树以会话工作目录为根；没有办法浏览到它之上，而 Host 本来也拒绝工作区根之外的路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

页面刷新快捷键在文件页上、目录树显示期间通过常规目录读取器刷新其树，在预览中重新载入预览。文件页的重新读取控件在悬停和键盘聚焦时显示有效绑定。

</details>
