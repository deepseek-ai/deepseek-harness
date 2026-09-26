---
description: "从 Web 侧栏管理 profile 的插件组合包、它们的行，以及插件的配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

[English](README.md) | 中文

## 概述

使用 Web 侧栏的**插件**入口管理 profile 已安装的组合包，以及安装随附、默认关闭的官方组合包。可以启停组合包及其行、在 Host 读出 spec 指向什么之后安装组合包、查看 pnpm 输出、停止一次运行，并启用它新增的包。卸载会要求确认。注册了配置页的插件在这里、在它自己的页面上编辑；设置里只保留只读的插件列表。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在侧栏选择**插件**。页面首次打开时通过 `api-remotes` 读取清单与组合包；没有受管 profile 的 Host 上页面显示为不可用。**官方**排在前面，列出安装随附、供开启的组合包——开启前保持关闭、没有卸载、属于实验性功能的带**实验性**标签——其后是注册了配置页的官方插件；**已安装**列出 profile 持有的组合包。卡片按名称排序，启停组合包不会挪动它的卡片。没有组合包 patch 的依赖不是插件，除非 profile 选中了它才会带异常标签列出。全局配置仍在设置的**插件**分区中编辑。

已安装的组合包及其插件行在卡片和详情页中，按当前界面语言显示各自的标题与描述。每个字段先读取导出的 locale `meta`，缺失时回退到该插件地址下可访问的 `package.json`；标题最终使用完整包名或模块名，两处都没有描述时不提供包描述。作者格式见[插件展示元信息](../../../docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)。组合包卡片、详情和组件行显示各自 `package.json.icon` 声明的图片；未声明或无法解码时保留默认插画。安装预览仍使用注册表或 manifest 信息。

### 安装一个组合包

首次使用时，如果未显式配置安装源、pnpm 使用官方 npm 源，且列表提供 npmmirror，Host 会并发探测这两个源，选择最先成功响应 HTTPS ping 的源。已记住的选择、用户手选、管理器显式配置，以及自定义或未知的 pnpm 源均保留。在初次探测期间点击安装会等待这次有时限的操作；迟到结果不会覆盖手选或重新打开已关闭的对话框。

Host 通过普通 fetch 代理向 `https://registry.npmjs.org/-/ping` 和 `https://registry.npmmirror.com/-/ping` 发送 GET 请求，以最先返回 2xx 的源为结果；重定向和失败不参与选择。随后取消另一条请求、丢弃两个响应体，并在清理完成后返回。默认时限为 1500 毫秒，包括不可用结果在内的探测结果均缓存五分钟。在 `ui-plugin-manager` 上配置 `registryProbeTimeoutMs` 和 `registryProbeCacheTtlMs`；`registryProbeEnabled: false` 关闭探测。两条请求都失败或超时时保留现有默认源。不使用 IP 地区服务，也不发送 Session 内容。

**添加插件**接受包名（可带版本）、Git 地址、压缩包或本地绝对路径；对话框说明包名就是 README 里 `dsh plugin add` 后面的那一段。输入框下方的**插件安装引导和示例**展开一段引导，给出三种常见形式各一个示例；**填入示例**把示例填进输入框。旁边的**安装源**写着安装首先询问的注册表，展开后可选：pnpm 自身的注册表，按它实际指向的源命名——npm 官方源、中国大陆镜像源，其余以主机名显示——Host 读不到时保留中性的默认名称，只列一次，选项标题带上主机名（主机名即名称时不重复显示）；Host 配置的每个镜像（`pluginManager.registries`），npmmirror 显示为中国大陆镜像源；以及手动输入的 http(s) 地址。选项从控件上浮在对话框之上，展开不会拉长卡片；引导使卡片高过视口时，卡片内容可以滚动。初始选择遵循上文的响应比较规则；之后选择记在本浏览器（`localStorage`）里，下次打开对话框从它开始，Host 不再提供的已记住地址保留为手动输入的地址；在安装源列表返回前开始安装，也仍请求该地址。**安装**先让 Host 在所选注册表读出 spec 指向什么（`pluginManager.inspect`）：列表中已有的名字、所有注册表都没有的名字、没有包的路径、没有组合包 patch 的包，或 pnpm 会拒绝的 spec，都以一句话回到输入框下方，spec 保留可继续编辑；所有注册表都连不上时，这句话列出问过的每一个。随后安装从作答的那个注册表开始。通过检查的 spec 打开安装中界面，展示 Host 读到的包名、一句话简介和版本，pnpm 的命令与输出折叠在**查看安装详情**之后。安装完成后提供**立即启用**：启用新组合包、关闭对话框并把列表滚动到它；直接关闭则让它保持已安装但关闭。Host 改问另一个注册表时，安装中界面会说明哪个源没能提供这个包、现在改问哪个，详情里每次 pnpm 运行都带一个写明所用源的标记。安装失败时按 Host 的归因用一行话说明原因——所有安装源都连不上，并列出问过的每一个；GitHub 地址或压缩包链接自身的主机连不上，换源无济于事；包不存在、磁盘已满、profile 不可写、pnpm 拦下了构建脚本——pnpm 输出在详情里，**重试**就在手边，Host 把失败归于所问注册表时还在旁边提供**更换安装源**，回到 spec 输入界面并展开安装源选项；Host 已经把 profile 文件放回原样。pnpm 拦下依赖的安装脚本时，失败界面列出等待允许的包，并以**允许这些脚本并重试**取代**重试**；Host 把授权写进 profile 的 `pnpm-workspace.yaml`（失败的运行保留 pnpm 写入的这个文件）再运行 pnpm，安装完成界面会说明允许了哪些脚本。安装成功不代表模块一定能够激活。

准备和下载期间，**取消安装**会请求 Host 停止运行并等待确认。加载组合包的阶段不可取消。点击 ×、按 Escape 或点击遮罩会立即隐藏对话框，并在可以取消时请求取消。**查看安装任务**会重新打开同一任务并保留输出；结果待定或尚未确认时不能发起另一项安装。确认取消后回到 spec 输入界面并显示 toast；manifest 与 lockfile 已恢复，已下载文件可能保留。安装响应丢失后会请求恢复结果；**核对安装状态**和重连会重试该请求。Host 已无活动请求时，**未能获取安装结果**允许检查插件列表后返回编辑。早于接收确认的取消请求会等待并自动重试；取消失败可手动重试。隐藏的任务通过 toast 通知结果，不会重新弹出对话框。

Host 将网络失败或超时归因于 GitHub 地址，且提供 npmmirror 时，对话框显示**无法访问 GitHub**，超时时显示**连接 GitHub 超时**，提供**改用国内镜像**和**取消**。选择镜像后回到空的包名输入框，记住所选安装源，不自动开始下一次安装。安装已在使用 npmmirror 时（无论是选中、手动输入，还是 pnpm 自身配置指向它），按钮改为**试试其他方式**，同样回到空的包名输入框并展开**插件安装引导和示例**，安装源保持不变。其他失败保留原有诊断和操作。镜像提供注册表中的包及依赖，不代替 GitHub 仓库下载。

### 切换一个组合包

组合包页面在标题下方显示完整包名，也就是在别处安装它所需的 spec。组合包开关改变其层选择。启用了 HMR 的 profile 在操作完成前重组；没有 HMR 的 profile，以及被更高层覆盖的组合包，会以 toast 说明。Host 读不了的组合包带异常标签，其页面给出原因，且不能打开；提供管理组件的组合包保持锁定。Host 以错误码作答，由页面字典措辞；pnpm 与 Loader 自己的诊断原样显示。页面从卡片与数量中排除内置 profile 组合包，即使 profile 将它们列为依赖或 Host 报告了异常。Host 清单仍保留完整数据；设置中「插件」分区的「插件列表」标签页负责查看它们的插件。

### 切换组合包里的一行

组合包页面上行的开关调用 `pluginManager.setPluginEnabled`，往 profile 的 `cordis.patch.yml` 写入该行的 `disabled` 覆盖。启用了 HMR 的 profile 的树随即重组，该行的宿主半区卸下或挂上，组合包其余部分照常运行，页面无需重载即跟随客户端模块图。行使用共享状态标记表示 Host fiber 阶段：pending 与 disabled 为 idle，loading 与 unloading 为 ongoing，active 为 done，failed 为 error。开关只出现在已打开的组合包上；没有存活条目的行，以及 Host 不通过 profile patch 寻址的行，带着 Host 的原因锁定。超过十行的列表带一个按本地化标题、描述、行 id 和模块名筛选的输入框。

### 配置页

自带配置的插件把配置渲染在本页而不是设置里，通过本页声明的三个 slot：`plugins.item`（list）用于官方插件，按其 `label` 列在官方分组里；`plugins.bundle.config`（以组合包的包名为键）用于组合包自己的配置，显示在组合包页面的描述与行之间；`plugins.row.config`（以 `<包名>#<行 id>` 为键）用于某一行的配置，这一行由此多出一个**配置**控件，打开该行自己的页面。页面用 `view: 'page'` 渲染带自己保存控件的表单。官方插件卡片还在标题下渲染 `view: 'summary'`；行详情页只在缺少包描述时使用该视图。只有保存才写入：页面负责画标题、图标与面包屑，条目的表单在离开页面时丢弃暂存的修改。安装随附的四个宿主平面配置页——shell 执行器、agent loop、子智能体、DeepSeek 搜索提供方——各来自一个伴生包：[ui-settings-shell](../ui-settings-shell/README.zh.md)、[ui-settings-agent-loop](../ui-settings-agent-loop/README.zh.md)、[ui-settings-subagent](../ui-settings-subagent/README.zh.md) 与 [ui-settings-web-search](../ui-settings-web-search/README.zh.md)，在 Host 服务其命名空间期间注册。组合包的浏览器半侧用同样的方式注册：

```tsx ignore-check
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@acme/dsh-sidebar#sidebar',
  locale: 'acmeSidebar',
}, ({ t, view }) => view === 'summary' ? t('summary') : <SidebarForm t={t} />))
```

组合包的 patch 必须以该 id 声明这一行；注册只在组合包开启期间存在，因此关闭的组合包不显示配置控件。

### 详情页扩展点

对某个不属于自己的组合包、行或官方插件有话要说的插件，通过本页声明的三个 list slot 向该对象的页面贡献内容：`plugins.detail.actions` 在页头放一个控件，位于页面自己的开关和卸载之前；`plugins.detail.badge` 在标题旁放一个标签，位于版本、实验性和异常标签之后；`plugins.detail.section` 在页面自身内容之下放一个区块——组合包页在组件列表之后，行页和官方插件页在配置之后。每个条目都以页面的 `subject` 渲染：`{ kind: 'bundle', pkg }`、`{ kind: 'row', pkg, row }` 或 `{ kind: 'item', id }`，其中 `pkg` 与 `row` 携带包名、版本、是否已安装、是否启用以及行列表这些供贡献者判断的事实。条目对无话可说的 subject 返回 null，自绘区块外观；页面按 `order` 排列条目。

```tsx ignore-check
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
  name: 'plugins.detail.section',
  id: 'acme-health',
  locale: 'acmeHealth',
}, ({ t, subject }) => subject.kind === 'bundle' ? <HealthSection pkg={subject.pkg} t={t} /> : null))
```

行页只在某个 `plugins.row.config` 条目点名这一行时存在，因此给行的贡献渲染在该配置打开的页面上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件管理依据 profile 的依赖记录：已安装组合包可启停、可移除，随安装提供的组合包保持锁定。这一区分不决定启动失败策略。

<details>
<summary>实现细节——点击展开</summary>

### 注册

Host 入口通过生成的 Remote 接口暴露 `pluginRegistryProbe.fastest()`，共享进行中的比较、让缓存按时过期，并在卸载时中止和等待未完成探测。卸载后调用会返回拒绝的 Promise。

浏览器插件通过 `ctx.slots.inject()` 注册 `plugins` 侧栏入口与它的 `main` 面板，使两者跟随 slot 延迟声明、本地化变化与销毁。页面为全局页面，不属于任何 Session。显示文本来自包元信息与页面字典。

### store

`PluginManagerController` 拥有组合包视图、忙碌键、提示、安装进度和卸载确认。每次读取先问清单 Host 是否管理着 profile，再把 `listBundles` 与 `listPlugins` 合成每个组合包一份视图，其行携带存活条目的启停状态与 fiber 阶段。它合并重叠读取，在操作后、收到 `plugin-manager/changed` 时以及重连后刷新，并在销毁后忽略晚到结果。安装输出按 job id 分组。安装对话框沿 `idle → checking → starting → running → done | failed` 推进，`cancelling` 与 `applying` 按 Host 的报告呈现，安装或取消响应丢失时进入 `unconfirmed`；已确认的 `applying` 阶段不会倒退。通过 `waitForInstall` 恢复结果，无活动请求时结束为 `unknown`；checking 与所有活动阶段使用 ongoing，最终页面使用 done 或 error。检查在一个 `AbortController` 下运行，返回编辑或关闭会中止它并丢弃其结果；运行只能通过 `pluginManager.cancelInstall` 停止。关闭会隐藏任务而保留其状态。如果取消请求先于安装到达，在进度或输出确认该请求后会再次请求取消。Host 无法应用的变更、要等重启的变更、被更高层覆盖的变更，都是会自行消失的 toast。

### 配置 slot

自定义条目页以 Host 条目 id 作为注册 id；行页面使用 bundle 包名和行 id。当条目提供可编辑 Config 字段时，页面宿主传入 `form.state` 和 `form.mutate(operations, expectedRevision)`。自定义页面负责草稿和校验提示，并可复用 ui-primitives 的 `ConfigField`。整个 bundle 的页面可以包含多个条目，因此没有单一表单。

页面的 `main` 注册把 `plugins.item`、`plugins.bundle.config` 与 `plugins.row.config` 声明为子 slot，因此它们与页面同生，注册方的 `ctx.slots.inject` 会等到它们出现。`configLedgerSource` 把三份账本投影成一个可观察对象——按账本顺序排列、标签按当前语言解析的官方条目，以及组合包与行的键——在账本或语言变化前保持缓存；页面把它作为 `useConfigLedger` 绑在 store 旁边，自身从不点名任何可配置插件。注册拥有的导航 store 选择卡片、某个组合包、某个官方插件或组合包的某一行；切换离开插件面板时重置为列表，React 重新挂载则保留所选目标。其他 Client 插件注入 `pluginNavigation`，调用 `ctx.pluginNavigation.openBundle(packageName)` 即可打开组合包详情，不改变当前 Session。首次读取清单期间保留导航目标；组合包不存在时显示列表。注册与做出它的浏览器半侧同生共死。`dsh-client-modules` 只把一个包的浏览器半侧挂在说明符恰为包名的那一行 Loader 行上，所以组合包为自己或任一行注册的页面，都会在那一行被关闭时一起消失；需要在其他行关闭时仍保留页面的子插件，应作为独立的包发布。 名称以 `@deepseek-ai/dsh-experimental-` 开头的官方包显示实验性标记。

`plugins.bundle.config` 以 npm 包名为 key，提供 Bundle 详情配置。`plugins.bundle.activation` 在用户从列表显式启用后提供 Bundle 自有引导，并传入关闭引导和打开详情的回调。仅列出已启用的 Bundle 不会触发引导。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖侧栏、Remote 调用与 Host 侧管理器。

- [ui-sidebar](../ui-sidebar/README.zh.md)——插件入口注册进的面板列表；[ui-layout](../ui-layout/README.zh.md)——页面占用的主 slot。
- [api-remotes](../../api/remotes/README.zh.md)——`pluginManager.*` 与 `pluginInventory.*` 背后的 Remote BFF 面。
- [plugin-manager](../../boot/plugin-manager/README.zh.md)——本页驱动的 Host 侧管理器。
- [ui-settings-shell](../ui-settings-shell/README.zh.md)、[ui-settings-agent-loop](../ui-settings-agent-loop/README.zh.md)、[ui-settings-subagent](../ui-settings-subagent/README.zh.md)、[ui-settings-web-search](../ui-settings-web-search/README.zh.md)——注册进本页 `plugins.item` slot 的官方配置页。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的管理界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

- Ping 响应时间不代表包下载吞吐量。探测使用 Host fetch 的网络路径，pnpm 专用代理设置可能使用不同路径；用户始终可以手动选择安装源，安装仍遵循现有回退规则。

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了管理视图的范围；它们是当前包的约束。

- **页面生命周期**——刷新浏览器会丢失跟踪的请求与输出。同一页面内重连可以恢复活动请求；Host 不保留已完成的结果。profile 文件锁串行化安装写入。
- **只管理组合包**——没有组合包 patch 的依赖在安装前就被拒绝；profile 里已有的这类依赖不上页面，除非 profile 选中了它；加载普通插件模块仍是文件操作。
- **行只显示阶段，不显示原因**——失败的行只显示为失败，没有 Host 的错误文本；Host 日志里有。
- **一次只能安装一个**——对话框一次运行一个 pnpm 命令；第二个 spec 要等前一个完成。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；页面不列出注册表版本，也不提供升级。
- **安装源选择只属于本浏览器**——它存在 `localStorage` 里，所以另一个浏览器会独立计算初始推荐；`dsh plugin` 命令和 agent 工具使用 Host 配置的注册表。
- **每次读注册表都要运行 pnpm**——打开对话框、检查、安装各问一次 pnpm 自身配置指向哪里；没有 pnpm 的机器读作未知，不提供备选。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生检查。面板读取 Host 事实，安装源探测缓存只保存一次比较结果，没有独立维护的投影。
