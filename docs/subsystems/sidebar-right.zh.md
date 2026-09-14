# 右侧 Sidebar

[English](sidebar-right.md) | 中文

右侧 Sidebar 是 Web Client 里每个会话一份的停靠面：会话区旁的一列 pane 与 tab，按地址寻址的内容——工作区文件、目录树、产品自带页面——在这里打开、分栏、浮出、关闭。[`dsh-client-ui-sidebar-right`](../../packages/client/ui-sidebar-right/README.zh.md) 拥有这个面、tab 类型注册表与导航服务；[`dsh-client-ui-dockkit`](../../packages/client/ui-dockkit/README.zh.md) 是它内部的布局引擎；[`dsh-client-resources`](../../packages/client/resources/README.zh.md) 把地址变成任何组件都能读的活数据；[`dsh-api-workspace-files`](../../packages/api/workspace-files/README.zh.md) 同时提供 Host 工作区文件服务与 Client `file` 资源提供者。

本页是该子系统契约的参考：地址、tab 类型注册、导航服务、扩展 slot 与其 owner props、资源模型、Workspace Files 服务、内置类型，以及明确不做的事。布局引擎、frame 与停靠面如何拼在一起见 [Agent Note](../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)；slot 机制见 [Slots 参考](slots.zh.md)。

## 定位与归属

每个会话恰有一个停靠面，保存在会话作用域的 slot store 里、由 `rightbar.session` 绘制。root 作用域的 `rightbar` 控制器仅在选中 Conversation 时挂载该席位；刷新页面后每个会话回到折叠的默认态，切换会话时各自的面保持原状（[状态](../../packages/client/ui-sidebar-right/README.zh.md#state)）。面的每一次变化都是 kit 纯规划器算出的一条历史记录；停靠的 pane 从不空着，根 pane 为空时会加入根据已注册引导入口选出的默认页。

一个 tab 类型是共用定义 `id` 的两次注册：在 `ctx.sidebarRightTabs` 里的静态定义说明其 `kind` 打开哪些地址，一次 keyed slot 注册提供它的正文。框架注入 `useTabInfo()` 以读取 Sidebar、窗格和标签的实时信息；各类型把自身状态放在 slot store 里。各包之间只以类型形式引用彼此的声明。

| 包 | 职责 |
|---|---|
| [`client/ui-sidebar-right`](../../packages/client/ui-sidebar-right/README.zh.md) | 面板与栏席位、布局 store、`ctx.sidebarRightTabs`、`ctx.sidebarRight`、Tab 域、引导类型 |
| [`client/ui-dockkit`](../../packages/client/ui-dockkit/README.zh.md) | 纯布局引擎与 React 面；`ui-sidebar-right` 的内部依赖，不是稳定接口 |
| [`client/resources`](../../packages/client/resources/README.zh.md) | `ctx.resources`、`useResource`、协议 → 值类型的花名册 `ResourceProtocolMap` |
| [`api/workspace-files`](../../packages/api/workspace-files/README.zh.md) | Host `ctx.workspaceFiles`、`workspaceFiles` Remote 命名空间与 Client `file` 资源提供者 |
| [`util/workspace-path`](../../packages/util/workspace-path/README.zh.md) | 文件地址语法：`fileAddressFor`、`parseFileAddress` |
| [`client/ui-sidebar-documentpreview`](../../packages/client/ui-sidebar-documentpreview/README.zh.md)、[`client/ui-sidebar-files`](../../packages/client/ui-sidebar-files/README.zh.md) | 内置的 `text` 与 `files` 类型 |

## 地址

每个 tab 都由一个地址字串打开，地址就是 tab 的内容身份。地址分两族。

**资源地址**是 `dsh-resource://<type>/…` 形式的 URL。host 命名资源协议——即 `ResourceProtocolMap` 的键——其后是该协议自己的路径；所有协议共用一个 scheme，新增协议只新增 host、不新增 scheme。`file` 协议的路径以其作用域开头：`session/<sessionId>` 后接相对该会话工作区根的路径（`dsh-resource://file/session/abc/src/notes.txt`），或 `absolute` 后接去掉前导 `/` 的绝对路径（`dsh-resource://file/absolute/home/ys/notes.txt`，Windows 上为 `dsh-resource://file/absolute/C:/x/y.txt`）。id 与每一段路径都做组件编码，盘符的 `:` 保留原样。`fileAddressFor(sessionId, cwd, path)` 构造地址——相对路径或工作区内的绝对路径成为 `session` 相对地址，其他绝对路径成为 `absolute` 地址——`parseFileAddress(address)` 读回各部分或返回 `undefined`（[语法](../../packages/util/workspace-path/README.zh.md)）。

**页面地址**是 Sidebar 为按 kind（而非按资源）打开的 tab 记下的地址：`sidebar://<kind>`，由 Sidebar 自己在 `openTab(kind)` 运行时写入。调用方从不拼它——引导页与文件树以 `openTab('guide')`、`openTab('files')` 打开——此外不存在任何导航地址（[不做](#not-built)）。

tab 身份是 `(kind, address)` 二元组：注册表的认领把地址原文用作记录的 `contentId`，因此同一地址经同一类型再次打开会找到已有 tab，同一地址经两个类型打开则是两个 tab。

## Tab 类型注册

`ctx.sidebarRightTabs.register(definition)` 在调用方的生命周期内注册一个类型的一份实现并返回注销器；调用方把它放在自己的 `ctx.effect` 里，因此实现与贡献它的插件同寿，同一 `id` 的第二次注册抛错（[扩展席位](../../packages/client/ui-sidebar-right/README.zh.md#extension-seats)）。定义是静态的：没有运行时 hook，没有按 tab 或按会话的东西。

| 字段 | 含义 |
|---|---|
| `id` | 该实现的身份，在所有注册中唯一；包名是自然取值（`@deepseek-ai/dsh-client-ui-sidebar-files`）。正文与标题坑位按它注册。 |
| `kind` | 类型的判别名：它的 tab 是什么，也是 `openTab` 点名的对象。不唯一——extension 可以接管 builtin 的 kind。内置 kind 为 `guide`、`text`、`files`。 |
| `patterns` | 可选的资源地址 glob；按 kind 打开的页面类型省略。含 `:` 的模式匹配整个地址（`dsh-resource://file/**`）；不含的匹配 URL 的路径部分且任意深度都中（`*.md`），不是 URL 的地址不会命中此类模式。匹配不分大小写、不隐藏 dotfile；语法为 picomatch 的 POSIX 方言。 |
| `priority` | 三档字面量之一：`extension`（缺省且最高：产品之外的类型压过所有内置查看器）、`builtin`（随产品发布的类型）、`fallback`（任何更具体的类型都应压过的纯内容查看器）。 |
| `canOpen(address)` | 可选的同步否决，对 glob 命中生效；每次路由决策都会调用。 |
| `title(address)` | chip 文本，在 tab 打开时捕获进布局记录，之后不再改写。 |
| `guide` | 可选的引导页入口框：`{ order, title(), description?(), icon? }`。点一框即把贡献它的类型作为页面打开；省略即不上引导页。 |

路由是一次排序认领。`candidates(address)` 对模式命中且未被 `canOpen` 否决的类型排序：先按档，再按最长命中模式的长度，最后按注册顺序。`claim(address, kind?)` 取第一个候选，或直接用点名的 `kind`——跳过它的 glob，但 `canOpen` 仍生效——返回 `{ kind, contentId: address, title }`。没有任何类型认领的地址会抛错：这是接线错误，不是用户错误。

同一个 `kind` 可同时携带一个 `builtin` 与一个 `extension` 注册。extension 在认领、`get(kind)`、`openTab(kind)` 与引导页上生效，席位按生效定义的 `id` 找 tab 的正文与标题，不涉及任何 slot 优先级；extension 注销后 builtin 恢复。kind 上的其它任何撞名以及任何重复的 `id` 都抛错。

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const inject = ['sidebarRightTabs', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: '@acme/dsh-client-ui-image',
    kind: 'image',
    patterns: ['*.png', '*.jpg', '*.gif', '*.svg'],
    canOpen: address => address.startsWith('dsh-resource://file/'),
    title: address => address.slice(address.lastIndexOf('/') + 1),
  }), 'image type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: '@acme/dsh-client-ui-image' },
    ImageBody,
  )), 'image body')
}
```

## 导航：`ctx.sidebarRight`

两种打开构成导航控制器，进入这一列的每条路都调用其一：`openResource(address, options?)` 打开 `dsh-resource://` 地址——会话区的文件链接、工具行的行号引用、文件树的行；`openTab(kind, options?)` 打开页面——tab 条的新增控件、引导页入口框。两者都以一条历史记录走完四步——认领（注册表为资源排候选，或点名 `kind` 的生效实现应答）；聚焦已显示同一 `(kind, address)` 的 tab；否则落一个新 tab；展开这一列——然后把导航记入 Tab 域（[服务](../../packages/client/ui-sidebar-right/README.zh.md#ctxsidebarright)）。用户看不见的内容不算打开，所以折叠的列会在同一步展开。`openResource` 对 `dsh-resource://` 之外的地址或无人认领的地址抛错；`openTab` 对无人注册的 kind 抛错：二者都是接线错误，不是用户错误。

| 选项 | 含义 |
|---|---|
| `paneId` | 新 tab 落到这个 pane；缺省为活动的停靠 pane（活动的是浮窗时取第一个停靠 pane）。 |
| `replaceTab` | 占用这个 tab 的 pane 与条上位置，并在同一步关闭它；浮窗里的 tab 让不出位置，新 tab 按未指定位置落位。 |
| `revealIfOpened` | 缺省 `true`：已显示同一 `(kind, address)` 的 tab 被聚焦并收到 `params`。`false` 则无论如何再开一个。 |
| `kind`（仅 `openResource`） | 点名打开类型而不排候选；该 kind 的生效实现打开地址，它的 `canOpen` 仍生效。 |
| `params` | 给正文的导航参数，作为 `navigation.params` 送达。`openResource` 按资源类型经声明合并表 `SidebarRightResourceParamsMap` 定型（文本预览声明 `{ line?: number }`）；`openTab<K>` 按 kind 经 `SidebarRightTabParamsMap` 定型，未声明的 kind 为 `undefined`；正文读到的是二者联合 `SidebarRightNavigationParams`。值按约定为 JSON 形状，运行时不校验。 |

落位是调用方的选项，从不是类型的属性。会话区调 `openResource(fileAddressFor(sessionId, cwd, path))`，`read` 工具行另加 `{ params: { line } }`（来自调用的 1 起 `offset`）；引导页入口框调 `tab.actions.openTab(entry.kind, { replaceTab: true })`；文件树的行调 `tab.actions.openResource(address)`；tab 条的新增控件调 `openTab('guide', { paneId, revealIfOpened: false })`。

`close(tabId)` 关闭一个 tab；`active()` 返回活动 pane 的活动 tab；`isExpanded()` 与 `toggleExpanded()` 读取与翻转这一列，翻转记入序列。无会话时读操作返回 `undefined` 或 `false`；写操作需要已挂载的会话面，没有时抛错而不是写进没人绘制的面。

`focus(tabId)` 让一个 tab 成为其 pane 的活动 tab；`split(paneId?)` 分割活动的停靠 pane 或点名的 pane，返回新 pane 的 id——pane 数预算或列宽不允许时返回 `undefined` 且不记账；`float(tabId, rect?)` 把一个 tab 浮出为浮窗 pane；`dock(paneId)` 把浮窗 pane 收回停靠区。四者都走 store 既有动作、各记一条历史；目标不存在或已处于目标状态时是空操作，与 `open` 一样在没有已挂载会话面时抛错。`TabId`、`PaneId`、`TabRecord`、`FloatRect` 自本包 `/client` 入口再导出，调用方无需引 dockkit。

## Slot 与 owner props

Sidebar 声明四个扩展 slot；其文档 tab 另行声明下表中的 keyed 文档正文 slot（[层级](slots.zh.md)）。

| Slot | Cardinality | 用途 |
|---|---|---|
| `sidebar.right.pane.tab` | 按定义的 `id` keyed，会话作用域 | 一个 tab 的正文。席位把 tab 分发到其 kind 生效实现的 `id`，因此注册者收到该 kind 的每个 tab，停靠或浮窗。实现没有注册正文的 kind 渲染 owner 的「无法查看此内容」提示。 |
| `sidebar.right.pane.tab.title` | 按定义的 `id` keyed，会话作用域 | chip 的标题，owner share 与正文相同。可选：没有条目时 chip 显示打开时捕获的 `title(address)` 文本；有活标题的类型在此读自己的 store。 |
| `sidebar.right.tab.guide` | chain，会话作用域 | 替换引导 tab 的内容而不替换 tab；第一个不拒绝的条目接管正文，否则渲染自带引导。 |
| `sidebar.right.tab.menu.item` | list，会话作用域 | 追加在 kit 自身布局动作之后的内容级动作。执行了动作的条目必须调用 owner 的 `dismiss()`。 |
| `sidebar.right.tab.document` | 按文档实现的 `id` keyed，会话作用域 | 文档 tab 内选中的文件渲染器；父组件拥有共享加载与工具栏控件。 |

正文、标题与引导页替换项接收框架注入的 `useTabInfo()`。它返回 `{ sidebar, panel, tab }`：`sidebar` 包含 `expanded` 与 `fullscreen`，`panel.id` 标识所属窗格，`tab` 包含记录字段以及 `visible`、`navigation`、`signal` 和 `actions`。停靠正文仅在展开且活跃时可见；停靠标题只要求展开；浮窗保持可见。`signal` 在记录消失或插件卸载时中止，不因隐藏或切换 Session 而中止。`tab.actions` 提供绑定到标签所属 Session 的 `openResource`、`openTab` 与 `close`。打开位置缺省为当前所属窗格；`revealIfOpened` 缺省为 `true`，`replaceTab: true` 在同一历史项中替换本记录。菜单项保留普通的 `tab` 与 `dismiss` owner 参数。

`navigation.revision` 在每次导航到该 tab 时递增，`params` 不变也递增，正文可仅凭「又被导航了」行动；按地址打开的 tab 为 `1`，没有人按地址打开的记录——种入的引导、撤销恢复的 tab——为 `0`。Tab 域为每条打开的记录保有一个 occurrence：记录出现即在资源模型里钉住，因此切换 tab 卸载正文也不丢内容；记录消失即中止并丢弃；撤销恢复的记录是新的 occurrence（[Tab 域](../../packages/client/ui-sidebar-right/README.zh.md#the-tab-domain)）。

## 文档渲染器

`text` tab 是共享的 Document Preview 所有者。其[根注册](../../packages/client/ui-sidebar-documentpreview/src/client/index.ts)声明 `sidebar.right.tab.document` 并提供 `ctx.documentPreviews`。渲染器在自己的 effect 中注册 `DocumentPreviewDefinition` 元数据，再通过 `ctx.slots.inject('sidebar.right.tab.document', ...)` 等待 slot，以 `key: definition.id` 和自己的 locale 命名空间注册组件。切换渲染器不改变 tab 或资源地址；[扩展决议](../../.agents/notes/implemented/architecture/2026-09-08-document-preview-operations.zh.md)将预览策略与资源归属分开。

[注册表](../../packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts)记录唯一的 `id`、`extensions`、本地化 `title()`、`loading`，以及可选的 `priority` 和 `wrap`。后缀匹配不区分大小写，先排 `extension`（缺省值）、再排 `builtin`，随后比较后缀长度（长者优先）与注册顺序。与 tab kind 替换不同，注册表保留所有实现；工具栏列出匹配的候选，按 tab 记住选择。未知扩展名使用纯文本。`loading` 为 `text-pages` 或 `bytes-complete`；`wrap` 声明是否支持共享的源码换行控件。

[`DocumentPreviewProps`](../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts) 派生自 `PropsRuntime<'sidebar.right.tab.document'>`。owner 提供原始 `resourceAddress`、`content` 与当前 `wrap`：文本内容为 `{ kind: 'text', text, pages: [{ offset, text, lines }], eof }`，其中 `text` 为累积文本；完整字节为 `{ kind: 'bytes', data }`，其中 `data` 为 `Uint8Array<ArrayBuffer>`。这些瞬时缓冲区按只读方式借用，不得进入持久布局或 Session JSON。PDF 在转移到 Worker 前复制字节，以保留 owner 的缓冲区。子组件收到同一个框架绑定的 `useTabInfo`，以及全局共享、仅提供元数据的 `useResource`。父组件通过普通 inject 回调调用 `remote.workspaceFiles.read`/`readAll`，拥有追加分页、逐 tab 刷新与加载状态。HTML 自己的 inject 回调使用 `readRelated`；路径由 Host 代码解析。Markdown 和代码在追加期间保留同一个增量渲染器，到 EOF 完成最终解析；HTML 和 PDF 接收完整字节。

Preview 记录已载入版本和读取开始时的观察版本。刷新只重读当前 tab，不改变共享元数据或其他 tab 的内容。读取不具备事务性；版本是不透明的相等性令牌，不是可排序的时间戳（[资源观察与 Preview RPC](../../.agents/notes/implemented/architecture/2026-09-08-document-preview-operations.zh.md)）。

## 资源模型

模型本身见[客户端资源](client-resources.zh.md)；本节只写 Sidebar 依赖的部分。一份资源是一个地址，资源地址是 `dsh-resource://<type>/…` 形式的 URL，小写 host 即协议键。协议所属的客户端包用 `ctx.resources.register(provider)` 在自身生命周期内注册唯一的提供方；同一协议的第二个提供方抛错（[提供协议](../../packages/client/resources/README.zh.md#provide-a-protocol)）。提供方是 `{ protocol, open(address, { signal }) }`：`open` 产出 `RemoteResult` 帧——首帧是当前状态，之后每次变化一帧——并在 `signal` 中止时停下；失败是 `{ ok: false, error }` 帧而不是抛错，流里抛出的东西是编程错误，模型不捕获。

`useResource<P>(address)` 是每个 slot 组件都有的全局标准 prop，不论作用域。它返回 `{ status, value, failure }`：地址协议没有提供方或地址不是资源地址（`sidebar://guide` 不指向资源）时为 `none`，首帧之前为 `loading`，`live` 携带最新 `ok` 值，`failed` 在最后一个值旁携带最新帧的失败。（[读取资源](../../packages/client/resources/README.zh.md#read-a-resource)）。

资源有持有者就保持打开——订阅中的 `useResource` 或一次 `ctx.resources.pin(address, signal)`；第一个持有者打开提供方的流，之后的持有者共享它并立刻读到最新值，最后一个释放时中止流并丢弃值。流只推元数据不推内容：`file` 的值是 `{ absolutePath, version, bytes? }`，消费方自己经 Workspace Files 服务按页读文件文本（[生命周期](../../packages/client/resources/README.zh.md#lifecycle)）。

## Workspace Files

Host 的 `ctx.workspaceFiles` 服务与生成的 `workspaceFiles` Remote 命名空间读取 Session 文件系统后端允许的文件：`stat(path)` 返回 `{ absolutePath, version, bytes? }`；`read(path, { offset?, limit? })` 返回一页行（`offset` 1 起，`limit` 受配置页长限制），形如 `{ …stat, offset, text, eof }`；`readBytes(path, { offset?, length? })` 返回一个原始字节窗口（`offset` 0 起，`length` 受配置字节上限限制），形如 base64 的 `{ …stat, offset, data, eof }`、不做文本解码。`list(path)` 仍限定在工作区根内，返回目录的直接子项（`name`、`type: 'file' | 'directory' | 'other'`、`size?`），按配置上限截断并置 `truncated`。`changes()` 同样限定于工作区，订阅就绪后产出 `{ kind: 'ready' }`，随后产出 `{ kind: 'change', change }` 帧，其载荷为 `{ absolutePath, version }` 或 `{ absolutePath, absent: true }`（[README](../../packages/api/workspace-files/README.zh.md#use-this-package)）。文件操作拒绝末端符号链接并执行传输上限；`read` 还要求 UTF-8 文本。失败使用 `workspace-file/*` 错误码（[失败](../../packages/api/workspace-files/README.zh.md)）。

[`dsh-api-workspace-files`](../../packages/api/workspace-files/README.zh.md) 注册 `file` 提供方，`ResourceProtocolMap.file` 直接是 `WorkspaceFileStat`。Session 地址携带授权 Session 与相对或绝对路径，Host 原样接收并解析。提供方在 stat 前等待 Host 的 `ready` 帧，并按 `stat.absolutePath` 过滤变更。裸 `absolute` 地址没有授权 Session，以 `workspace-file/unknown-workspace` 失败，不借用当前或 Tab Session。任何 UI（包括 Global）访问同一完整地址都共享观察。Preview 的普通 Remote 回调使用地址中的 Session；Host `readAll` 和 `readRelated` 保留，字节结果由 Preview 的 `rpc.ts` 解码。

## 内置类型

- **`guide`**——`builtin`，以 `openTab('guide')` 打开。一枚弱化的罗盘位于各类型按 `order` 贡献的入口胶囊上方；入口较少时显示已注册的描述，未提供图标的入口统一使用内置占位符。点选胶囊即在引导 tab 的位置把贡献它的类型作为页面打开。每个 pane 最多一个引导 tab，tab 条的新增控件只在本 pane 没有引导时出现。新 pane 使用已注册的默认页：只有一个引导入口时直接使用该入口，否则使用引导页（[引导](../../packages/client/ui-sidebar-right/README.zh.md#the-guide)）。
- **`text`**——`fallback`，`dsh-resource://file/**`，只认领 Session 地址。Document Preview 通过 `useResource<'file'>` 观察元数据，经 Remote 回调加载内容，并拥有渲染器选择、工具栏、逐 tab 刷新、滚动与源码定位；未知扩展名按纯文本渲染（[README](../../packages/client/ui-sidebar-documentpreview/README.zh.md)）。
- **`files`**——`builtin`，以 `openTab('files')` 打开。工作区目录树，经 `list` 懒加载，用 `tab.actions.openResource(fileAddressFor(sessionId, root, path))` 在自己所在 pane 打开文件（[README](../../packages/client/ui-sidebar-files/README.zh.md)）。

<a id="not-built"></a>
## 不做

- 持久化：布局状态只在内存里；刷新后每个会话从折叠开始，任何会话的 tab 都不会出现在另一个会话里。
- `ctx.sidebarRight` 上的只读布局快照或订阅：服务只暴露操作，dockkit 的 `LayoutState`/`LayoutOp` 是内部的。
- 服务上的能力探测数组（`features`）。
- tab 类型的 `option` 优先级档：没有「只列出、不许认领」的 tab 类型。
- 改写记录的标题：`title(address)` 只捕获一次；活的 chip 来自标题 slot，而不是记录。
- 打开时点名某个 tab 实现：`openResource` 最多点名一个 kind；文档渲染器由文件 tab 的工具栏选择。
- 服务上的地址查找（`find`）：调用方用 `revealIfOpened` 打开，由停靠面去重。
- Sidebar 自身 `sidebar://<kind>` 记账之外的导航地址；其语法等导航控制器整体做时再定。
- 面向用户的撤销、内容导航栈与 tab 图标（[暂缓](../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md#deferred)）。
