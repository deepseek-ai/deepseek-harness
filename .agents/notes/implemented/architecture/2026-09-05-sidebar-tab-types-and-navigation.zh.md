# Agent Note: 右侧 Sidebar 的 tab 类型与导航

Status: implemented

[English](2026-09-05-sidebar-tab-types-and-navigation.md) | 中文

## Problem

[停靠面](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)给了右侧 Sidebar 分栏、tab 与浮动面板，但一格 tab 只有在别的插件能往里放内容时才有用。这需要三份停靠面自身不定义的契约：插件如何声明一种 tab 及其能展示的地址；任何调用方——会话区里的产出文件 chip、文件树里的一行、插件自己的按钮——如何请 Sidebar 展示某样东西；以及 tab 的正文在运行时能依赖什么。每一份都是仓外插件将来要对着写的公开面，所以必须在那些插件出现之前定下来：之后改一个字段名、一个枚举值或地址语法，就会同时弄坏它们全部。

两条约束决定了答案。动态客户端插件之间不允许引用运行时值——函数、常量、类——只能引类型，因此这些契约里不得要求从 Sidebar 包引入帮助函数或导出常量。而 Web 客户端已经有一套组件模型，即 Slot 系统；再为 tab 造一套，就是第二个要学要维护的并行框架。

## Decision

tab 类型是向 `ctx.sidebarRightTabs` 的一次静态注册；tab 的正文与标题是普通的 keyed Slot 注册；`ctx.sidebarRight` 只以两种方式打开内容——按地址开资源、按 kind 开页——其余只操作布局；正文通过框架注入的 `useTabInfo()` 读取实例信息。下面按插件作者遇到的顺序描述这四个面。

### 类型注册表：`ctx.sidebarRightTabs`

`register(definition): () => void` 记录一种 tab 类型并返回注销器，调用方把它放进自己的 `ctx.effect`，于是类型的寿命恰好等于贡献它的插件。定义是静态的：

```ts ignore-check
interface SidebarRightTabDefinition {
  readonly id: string                                   // this implementation's identity in the tab system
  readonly kind: string                                 // what the tabs of this type are; what openTab names
  readonly patterns?: readonly string[]                 // resource-address globs; omitted by a page type
  readonly priority?: 'extension' | 'builtin' | 'fallback'   // defaults to extension
  readonly canOpen?: (address: string) => boolean       // veto after a glob matched
  readonly title: (address: string) => string           // chip text, captured at open time
  readonly guide?: readonly SidebarRightGuideEntry[]    // entry boxes on the guide page
}
```

`id` 与 `kind` 是两回事。`kind` 是类型判别符——tab *是什么*、`openTab` 点名什么、tab 身份由什么构成。`id` 是某个 kind 的一个*实现*的身份，在全部注册里唯一，包名是自然的取值。两者分开是因为 kind 并不唯一：`extension` 可以注册一个 `builtin` 已持有的 kind，两个实现随即在注册表里共存，生效的是 extension。注册表拒绝重复的 `id`、同一 kind 在同一档的第二次注册、以及任何与同 kind 的 `fallback` 相遇的注册；它只接受 extension 压 builtin 这一对，extension 注销后 builtin 恢复。

`patterns` 是资源地址上的 glob，用 `picomatch` 按 VS Code 编辑器解析器的规则匹配，只有一处本地改动：含 `:` 的 pattern 匹配整个地址（`dsh-resource://file/**`），不含的匹配 URI 的路径且任意深度（`*.md`），匹配不区分大小写、不隐藏 dotfile，不是 URI 的地址不匹配任何路径 pattern。页类型——引导页、文件树——不识别任何地址，省略 `patterns`，按 kind 打开。

`priority` 是三个字面量档位之一，写成字符串，好让别的包的类型不需要任何运行时引入：`extension` 是来自产品之外的类型的档位也是最高档，所以什么都不声明的类型压过这里随包交付的每个查看器；`builtin` 是随包类型的常规档；`fallback` 是任何更具体的东西都应压过的纯内容位置，VS Code 的文本编辑器隐含地占据它，我们的文本预览明确地占据它。`candidates(address)` 返回 glob 命中且 `canOpen` 未否决的每个类型，按档位、再按命中的最长 pattern 长度、再按注册顺序排序。`claim(address, kind?)` 取最佳候选，或在调用方指定时取该 kind 生效的类型（不查它的 glob；点名即决定），对无人愿开的地址抛错——这是接线错误，不是用户错误。`get(kind)` 返回生效类型；`entries()` 与 `guide()` 列出生效类型及其引导入口；`subscribe` 观察变化。

`title(address)`、`guide[].title()` 与可选的 `guide[].description()` 都是每次使用时重读的 thunk，语言切换无需重新注册。[引导起始页与统计 pill 的细化](../feature/2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)负责当前的描述显示与兜底图标规则。注册表本身是 `apply` 顶层提供的普通对象，**不带** `Service.tracker`：tracker 会把 `this.ctx` 重绑到调用方上下文，跨包 `register()` 就会在调用方 fiber 仍是活动作用域时往它上加 effect，浏览器启动会无声卡死。

### 正文与标题：按定义 `id` keyed 的 Slot 坑位

类型注册表说类型是什么；Slot 系统说它长什么样。类型把正文注册进 keyed、session 作用域的坑位 `sidebar.right.pane.tab`，键是自己的 `id`，并可把标题组件注册进 `sidebar.right.pane.tab.title`，键相同。画 tab 的座位经注册表把 tab 的 `kind` 解析成生效类型，再派发到该类型的 `id`，于是 extension 接管 builtin 的 kind 时两个包互不知晓也能正确渲染，且没有任何优先级数字跨过包边界。没有生效类型的 kind 渲染属主的「没有东西能查看它」提示；没注册标题的类型得到注册表在打开时捕获的 `title(address)` 文本。

另有两个坑位扩展引导与菜单：`sidebar.right.tab.guide` 是 chain，第一个不拒绝的条目在不替换 tab 的前提下替换随包引导正文；`sidebar.right.tab.menu.item` 是 list，追加在库自身布局动作之后，放与 tab 内容有关的动作。类型自己的控件——重载、换行开关——住在自己正文里；tab 条属于面板，只放面板的控件。类型自己的状态是正文注册上普通的 Slot store 与 inject 面；框架不给组件模型添任何东西。

### 标签实例信息

[响应式 Sidebar 与标签信息](2026-09-07-sidebar-responsive-tab-info.zh.md)取代本记录中以平铺 owner props 传递实例信息的选择。正文、标题与引导页替换项接收框架注入的 `useTabInfo()`，以 `{ sidebar, panel, tab }` 读取所属 Sidebar、窗格与标签。实例的记录、导航、可见性、signal 与绑定动作均在 `tab` 内；精确字段见 [Sidebar 参考](../../../../docs/subsystems/sidebar-right.zh.md)。

标签域仍为每个已提交记录拥有一个实例，包括 `AbortController`、导航快照和绑定到所属 Session 的动作。记录存活期间，其地址被钉在[资源模型](2026-09-05-client-resource-model.zh.md)中；隐藏与切换 Session 不结束实例，关闭记录则中止并释放它。框架已有的存储与导航钩子提供实时读取，类型不自行订阅。

### 导航：`ctx.sidebarRight`

该面以两种方式打开内容，对内容不做别的事：

```ts ignore-check
openResource(address: string, options?: { kind?: string; params?: SidebarRightResourceParams; paneId?; replaceTab?: TabId; revealIfOpened?: boolean }): void
openTab<K extends string>(kind: K, options?: { params?: SidebarRightTabParamsFor<K>; paneId?; replaceTab?: TabId; revealIfOpened?: boolean }): void
```

`openResource` 接一个资源地址——`dsh-resource://<type>/…` URI，资源模型仅有的 scheme——并问注册表谁来展示：不带 `kind` 时问遍所有类型由排序决定；带 `kind` 时由该类型生效的实现打开。其它 scheme 的地址与无人认领的地址走同一条失败路径。`openTab` 按 kind 打开页类型，永远见不到地址：Sidebar 把该 tab 记账在 `sidebar://<kind>` 下，这个字面量只在包内一处拼装，为的是页 tab 与其它 tab 一样有 `contentId` 供身份与历史使用。这个 scheme 只是记账：没有调用方拼它，业务包里没有这个字面量，文件树与引导页分别以 `openTab('files')`、`openTab('guide')` 打开。

两种打开走同样四步：解析类型（按排序或按 kind）；除非 `revealIfOpened` 为 `false`，否则按 `(kind, contentId)` 定位已有 tab；落位——落在 `replaceTab` 的格与条位、`paneId`、或活跃格；把展开、打开或聚焦、以及 `replaceTab` 的关闭记为一条历史，再把 `{ address, params }` 交给 tab 域。落位是调用方的事，从不是类型级特性：文件树把文件开进自己的格是因为它自己说了，正如 VS Code 的 Explorer 自己传 `SIDE_GROUP` 或 `ACTIVE_GROUP`。`replaceTab` 只有一个含义——在那个 tab 的位置打开并在同一步关掉它——为的是引导页入口框把自己的 tab 交给所点的页。

参数按被打开的东西定型，经 Sidebar 包声明、由键的拥有者增补的两张可声明合并表：

```ts
interface SidebarRightResourceParamsMap {}   // key: resource type — the text preview declares { line?: number }
interface SidebarRightTabParamsMap {}        // key: kind — a page type declares its own shape, or nothing
```

`openResource` 接受所有已声明资源形状的联合，`openTab<K>` 接受为 `K` 声明的形状；正文按自己所服务的协议或 kind 收窄 `navigation.params`。参数属于资源类型而非查看器，因为行号是关于文件位置的事实，不是关于文本预览的，任何认领 `file` 地址的类型收到同一形状。值必须可 JSON 序列化，一条记录必须只凭地址与参数就能重建，因为撤销、重做、刷新与 HMR 都在开启方已不在时重建 tab。

除两种打开外，该面还有 `close(tabId)`、`active()`、`isExpanded()`、`toggleExpanded()`，以及四个操作型方法——`focus(tabId)`、`split(paneId?)`（返回新格，预算或宽度规则不允许分栏时返回 `undefined` 且不记账）、`float(tabId, rect?)` 与 `dock(paneId)`——每个记一条历史，目标不存在或已在目标态时为 no-op。没有布局快照、没有订阅、没有按地址查找：该面给的是对布局的控制权，不是布局的视图。座位挂载期间发布其绑定——自己的会话、其 store 的 action 与其面；公开面上的命令作用于已挂载会话，没有已挂载会话面时抛错。tab 自己的动作则到达其会话自己的 store：slot 运行时每个会话铸一个 store，插件在铸出时逐个收养，控制器按会话 id 路由，因此用户切换会话之后触发的动作照样落地，而 store 从未铸出的会话什么也不做。

### 地址

地址分两族，永不混用。资源地址是资源模型的 `dsh-resource://<type>/…` URI（工作区文件是 `dsh-resource://file/session/<sessionId>/<相对该会话工作区根的路径>`，任意文件是 `dsh-resource://file/absolute/<绝对路径>`，都由 `dsh-util-workspace-path` 构造与解析）；它们是 `openResource` 的入参、`patterns` 的匹配对象、`useResource` 的读取对象。导航地址命名的是页而非数据；今天唯一的一种是页 tab 记账用的内部 `sidebar://<kind>`。只有资源族是契约：导航族在 Sidebar 内部拼装与消费，更完整的导航协议是之后的决定，本决定通过把所有导航字面量留在一处为它预留空间。

### 入口

会话区的 `openFile(path, { line? })`——工具行路径链接、产出文件 chip、收尾消息提及——把路径编码为该 Session 的文件资源地址并调用 `openResource`，调用方知道行号时带 `params.line`；`read` 工具行传入其 `offset` 参数起始的行。tab 条的「+」为所在格调用 `openTab('guide', { paneId, revealIfOpened: false })`；引导入口框调用 `tab.actions.openTab(entry.kind, { replaceTab: true })`；文件树的一行调用 `tab.actions.openResource(address)`，落在树自己的格里。

## Alternatives considered

**用 chain 坑位派发 tab，或只用 keyed 坑位。** chain 的 `select` 不可枚举，而引导页与导航面必须枚举类型；keyed 坑位只带正文，类型的标题与地址识别无处可住。两段——定义注册表加 keyed 组件坑位——是仓库既有模式（`ConversationViewRegistry`）。

**运行时 hook 或每 tab 一个实例对象。** 纸面上试过多种形态——每 tab 一个 Cordis fiber、抽象基类、返回带 `dispose` 实例的 `initial`/`create` 对、一组 `useTab*` hook、框架托管的 `useTabResource(fetch)`、`useTabStream`。依次否决：每 tab 一个 fiber 太重；动态包无法共享基类或导出常量；实例层重复了 Slot store 与 inject 面已经是的东西；每 tab hook 复述 owner props；框架托管的 fetch 没有好的缓存键；tab 域上的流 hook 问错了主人——聊天数据必须来自聊天域，文件数据来自工作区文件服务。剩下的是 owner props 加一个全客户端的 `useResource`。`visible` 后来以 prop 而非 hook 加入也是同一理由：它是关于该次出现的又一个事实，而 props 已经承载了该次出现。 对实例读取钩子的否决由[标签信息决策](2026-09-07-sidebar-responsive-tab-info.zh.md)取代；对独立实例对象、fiber 与数据流所有权的理由仍适用。

**每格一个工具区坑位放活跃 tab 的控件（`sidebar.right.pane.tab.tools`）。** 上线一轮评审后删除：它把类型私有按钮放到面板 tab 条上、与分栏和收起控件并列，读起来像面板 chrome。类型的控件属于自己的正文。

**类型级落位（`opensInto`）与隐藏的相邻格启发式。** 否决：tab 落在哪是开启方的事，正如 VS Code 的 Explorer 自己决定 `sideBySide`。

**扩展名列表与数字优先级。** `claims.extensions` 表达不了 `.d.ts`、`Dockerfile`、目录约束或整个 scheme——它是退化的 glob；数字优先级需要动态包无法引入的导出常量。字面量档位加 glob。VS Code 自己的档位从五个收成三个：`option` 档（只列出、永不自动选中）在「用其他方式打开」存在之前没有消费者，`default` 档改名 `extension`，因为那个名字读起来像最低档而它是最高档。

**一个 `open(address)` 包打天下，外加拼页地址的帮助函数。** 第一版页也按地址打开，于是业务包需要 `sidebar://<kind>` 字面量或来自 Sidebar 包的 `sidebarAddress(kind)` 帮助函数。两者都被值引用规则禁止，也都泄露了尚未设计的导航 scheme。把面拆成 `openResource` 与 `openTab`，唯一的字面量留在包内，且每种模式各自定型参数。

**打开时点名某个实现（`?impl=`）、`find(address)`、`mode()`/`setMode()`、布局快照、`features` 清单。** 都考虑过并留在外面。点名实现属于尚不存在的导航协议；`find` 与快照会把该面变成布局的视图，而它本该是对布局的控制；呈现模式是 UI 开关不是插件关心的事；能力清单在该面尚在收敛时为时过早。

**用 Slot 优先级表达 extension 接管 builtin，随后是注册表铸造的坑位键。** 第一次尝试让覆盖方经一个导出常量以更低的 Slot 优先级注册正文——这是动态插件间的值引用，也是拿第二套规则（Slot 优先级）替注册表的规则站台。第二次尝试让注册表为每次注册铸一个键并从 `register()` 返回，这把注册变成了两步且顺序敏感的舞步。让实现自己声明 `id`——必填、唯一、与它注册坑位所用的同一个串——既不需要常量，也不需要铸键与顺序，还给了注册表拒绝重复所需的身份。

## Consequences

- 一个类型 = 一个静态对象 + 一到两个 keyed 坑位注册；其实例信息通过注入的 `useTabInfo()` 读取。框架不长任何按类型的 API 面，仓外类型从 Sidebar 包只引类型。
- 两种打开配两张参数表，意味着调用方无法只按地址开页或只按 kind 开资源，编译器会说明；代价是每个想要类型化参数的新资源类型或页 kind 都要增补一张表。
- `id` 与 `kind` 分离让 extension 能按 kind 原位替换随包类型，extension 注销后 builtin 恢复；代价是每个定义多一个必填字段。
- 导航面只有控制权。需要知道布局的插件无法索取，这让布局的形状在导航协议决定暴露什么之前不进任何插件的契约。
- `sidebar://<kind>` 字面量住在一个文件里。之后改导航语法只碰 Sidebar 包。
- 这些面是 Sidebar 里被定死的部分：地址、注册字段与档位、两种打开及其参数表、slot 名与注入的标签信息。用户看到的一切行为——浮窗贴到哪、分栏控件何时置灰、文案、树的排序——都是这里任何契约之外的产品规则，改动无需通知任何插件。

## Testing

`ui-sidebar-right` 的 spec 覆盖注册表（档位、extension 压 builtin 及恢复、`id` 与同档冲突、glob 与路径匹配、`canOpen`、排序与平局）、两种打开（正常、边界与失败路径，含错误 scheme 与未注册 kind）、`replaceTab` 记一条历史、座位把 kind 解析到生效实现并回退、`useTabInfo()` 含折叠与浮窗下的 `tab.visible`、以及操作型方法的 no-op 与抛错情形。Web e2e 套件在 Chromium 里经真实插件图驱动引导页、文件树与一次文件打开。两套均无需密钥。

## Deferred

- `sidebar://<kind>` 之外的导航协议：页内子路由、点名实现、以及面向生态的其它导航 scheme 规则。
- 随包页类型的参数，今天未声明任何。
- 从公开面往屏上会话之外的会话里打开；公开面只作用于已挂载的会话，而 tab 自己的动作已作用于其所在会话。
- 从会话区打开失败时的本地化提示；目前是抛错文本本身。
