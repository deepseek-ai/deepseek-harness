---
description: "复用 Computer Use 应用和窗口对象，通过已授权并记录日志的平台操作完成任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cua

[English](README.md) | 中文

各提供方通过 `installCua` 安装应用/窗口对象 API；调用方通过 `connectCua` 连接。`cua` API 负责发现应用，`CuaApp` 对象负责激活选定的应用并枚举其窗口。`CuaApp` 与 `CuaWindow` 都扩展 `CuaSurface`；显式窗口对象负责截图和指针输入。macOS 提供方为此接口提供原生执行。

## 概述

通过保留对象检查并操作应用：选择应用、读取辅助功能树、截取显式窗口并派发已授权输入。标准、创造及其他非 PTC preset 使用 `cua_run_code`，其中自动提供 `cua` 对象。持久 PTC 使用显式 bridge 初始化。平台提供方负责原生执行；CUA 负责授权与图像接纳。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

应用授权从 `src/locales.ts` 提供中英日展示文案。它使用 User Questions 的固定审批呈现，仍独立于会话的工具审批策略。本机图标用于授权提示和权限页展示，不进入保存的身份信息或模型结果。系统权限、持久授权与拒绝记录、图标分别查询，各项结果返回后即可显示。

-----

<a id="use-this-package"></a>
## 使用本包

挂载 [macOS 提供方](../cua-macos/README.zh.md)以在 macOS 上启用原生操作。外部 PTC 宿主从 `@deepseek-ai/dsh-cua/bridge` 导入 `connectCua`，并提供当前 `tools.cua` 绑定。源码组合与原生组件准备由提供方负责。

`cua_run_code` 为每个 agent（智能体）在独立的持久 Node 环境中运行 TypeScript。程序开始前即可使用全局 `cua` 对象；`tools` 中只有 `cua`。其他普通工具在程序外直接调用。使用顶层 `await`，通过 `inspect(...values)` 展示选中的文字和截图；顶层 `return` 无效。工具接受与 `run_code` 相同的超时和沙箱控制参数。运行时重启会自动重建 `cua`，但其他变量和已选择的应用对象需要重新创建。

通过提供方的 `standaloneRunCode.runtime` 配置运行时资源和启动设置，通过 `standaloneRunCode.executor` 配置程序调用上限。运行时固定使用 `persistent-in-memory`，在其中设置 `executionMode` 或 `scriptPersistence` 会被拒绝。这些设置不改变 profile 的共享 PTC 运行时。

原始 `cua` 的注册使用基础 CUA 服务和 preset 选择，不依赖私有 Node 运行时，也不依赖仅供程序工具使用的 `workingDirectory`。其他 preset 仅在程序工具所需服务可用时获得 `cua_run_code`。只有创建使用程序形态的 Agent 时，才会等待私有运行时启动并报告其失败。修正无效设置后，显式重载已失败的插件；补齐缺失依赖会使等待中的插件继续启动。`agentPreset: false` 全局注册原始 `cua`，不创建私有运行时。

`cua` 在创建环境时安装一次。不要覆盖这个全局对象。需要重建损坏的环境时，在 `cua_run_code` 中执行 `process.exit(0)`；该次工具调用会因进程退出而返回失败。下一次调用启动新环境并恢复 `cua`。请重新创建其他变量，并重新选择应用和窗口。

使用 `cua.getApp(selector)` 选择应用；它会获取授权、按需在后台启动已停止的应用，不读取辅助功能树。`cua.listApps` 和 `cua.getState` 列出运行中的应用；`cua.findApps(query)` 搜索已安装应用，包括未运行的应用。`app.activate()`、`app.getWindows()` 和 `app.getWindow(windowId)` 操作选定的应用；`getWindow` 返回对象时不发送原生请求；窗口操作会拒绝已关闭或属于其他应用的窗口。进行任何截图或指针输入前，必须选择应用及其一个窗口。元素操作前须显式读取 `app.getAccessibilityTree()` 或 `window.getAccessibilityTree()`。AX 读取失败时仍可截图。读取应用或窗口时，可以单独传入 `maxElements` 或 `maxDepth`。省略的参数使用当前平台配置。在单个 API 实例内，门面按应用句柄保存一份当前辅助功能快照，该句柄的所有应用对象和窗口对象共享它，包括重复选择；每次新读取都会使上一份快照失效。元素操作使用最新快照 ID，因此调用方应使用最新树中的元素 ID，不应假定旧 ID 仍指向同一控件。元素 ID 是不透明字符串。

键盘方法可在 provider 声明的作用域中使用；每个作用域内的输入投递由 provider 负责。连接丢失会使其句柄和坐标失效。清理失败会被报告，该连接不再复用；应重新选择应用并读取新状态，因为先前的输入可能已部分执行。截图图像错误会保留失败阶段和附件错误码。请求参数校验失败时，在分派前返回包含方法、参数和要求的可读消息。

观察方法输出并返回结果。通过 `connectCua(() => tools.cua, text => inspect(text))` 连接 PTC 文本输出。`window.getScreenshot()` 返回普通 `Image`，其 `path` 指向执行环境可读取的附件文件，`width` 和 `height` 对应保存图片的像素尺寸。使用 `inspect("操作前", before, "操作后", after)` 选择展示截图；窗口 ID 从 `window.windowId` 读取。`createCuaApi(dispatch, onText?)` 接收相同的程序分派器和文本回调。

`tools.cua` 的截图操作在 TypeScript 程序中返回 `Image`。宿主侧的规范化截图结果包含编码图像数据与持久的 `attachment` 引用；原生渲染器将坐标元数据和图片投影为模型内容。截图前要求附件服务可用，并确认当前模型支持图片输入。图片接入或保存失败会拒绝调用。

应用授权发生在启动、观察、截图和输入之前。会话许可按对话和应用身份持久化，重启 DSH 或关闭 Computer Use 后仍可复用，其他对话需要单独授权。长期许可要求平台提供可复用的应用身份。拒绝或撤销会关闭受影响的 Agent 连接，因此旧对象必须重新选择目标。取消、超时或重新连接后均不重放输入。

动作返回 `dispatched` 布尔值；`mouseMove` 还会返回 `hoverRoute` 和 `systemPointerMoved`，`show()` 还会返回 `windowId` 和 `foregroundChanged`。请读取新状态以验证结果。截图和指针操作只能通过显式窗口对象使用。坐标操作默认使用最近返回截图中的像素；成功读取覆盖该窗口的 AX 或取得截图后，传入 `relative: true` 可使用 0～999 的整数坐标。仅选择窗口不会建立该观察。数值除以 1000 后按窗口尺寸缩放，并限制在窗口内。Host 在返回截图前解析附件归一化和当前模型的图片缩放规则，再将输入换算为提供方的原生窗口坐标。窗口尺寸变化会使截图映射失效，绝对坐标遇到 `SCREENSHOT_REQUIRED` 时需要重新截图。窗口缩放后以 `WINDOW_CHANGED` 拒绝旧坐标；单纯移动窗口不改变窗口内坐标。

`click(target, { holdMs: 800 })` 按住鼠标按钮 800 毫秒后松开。`holdMs` 仅适用于 `click`；它接受非负整数，双击时应用于每次按下；0 表示按下后立即松开，不额外等待。提供方配置 `maxClickHoldMs` 限制显式按住时长，默认 5000 毫秒。指定时长后使用鼠标事件；省略时保留普通点击行为。按住时间计入操作超时，取消或超时会松开按钮。已接收的输入无法撤销；辅助进程被强制终止时无法保证松开。

### 权限控件

应用授权卡片包含**风险提示**标签。悬停、通过键盘聚焦或轻触该标签，可阅读保留格式的卡片，了解对已授权应用的后台访问、各应用的自动化规则和可能的账号限制，以及通过 DeepSeek Harness 停止操作的方法。指针移入卡片后，可以继续阅读和选择文字。

Computer Use 详情页的权限卡片、组件列表和来源信息使用 l3 边框，区块间距为 32px。应用名称徽标保留 l1 边框。

[Computer Use 组合](../cua-bundle/README.zh.md)将本页与原生 provider 一起挂载。“给 Computer Use 授权”把新会话默认模式、PTC 执行方式、辅助功能和屏幕录制放在同一个边框内。每条权限要求显示责任应用的名称和图标。“申请权限”将所选权限和当前界面语言交给 provider；原生拖动引导由 [macOS provider](../cua-macos/README.zh.md)负责。“已允许”描边按钮打开设置以撤销权限；未知状态使用“未确认”。应用访问授权保持独立分组。

进入页面、返回窗口和操作结束后会刷新状态。查询失败保留上次观测但标为未确认，并提供“重试”。打开设置或申请权限不代表授权完成。原生引导、配置和本地化恢复提示由 provider 负责。

系统权限操作作用于运行 DSH 的电脑。远程访问时，请在该电脑上完成授权。

从插件列表或详情页启用后，系统权限尚未就绪时会显示设置引导，提供“稍后”和“前往设置”。标准、创造和 PTC 模式均可使用 Computer Use。详情页的“新会话默认模式”提供“设为 PTC”按钮，仅点击此按钮才保存默认值。已有会话保留原 preset。“PTC 执行方式”一行的“设为持久化”在选用 Script 模式时单独启用 `ptc-runtime.scriptPersistence`；其他模式下保存 `ptc-runtime.executionMode: persistent-in-memory`。切换会重载共享 PTC 执行器，可能打断当前调用；后续调用在内存中保留变量和应用对象。已经使用持久化模式时，按钮显示“已设为持久化”并禁用。其他 preset 单独保留自己的 CUA 程序状态，不依赖此设置。

页面展示“始终允许的应用”和“不允许访问的应用”。后者汇总任一会话的拒绝记录，不取消其他会话已有的授权，也不阻止新会话询问授权。会话授权仍在对应会话中生效，详情页不展示这类应用。“撤销”会移除对应应用的访问许可并取消相关操作。已发送到应用的输入无法撤回，继续操作前需重新观察应用。“允许再次询问”清除该应用在所有会话中的拒绝记录；下次选择应用时仍需用户重新决定。

本插件没有配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

提供方通过 `systemPointer: true` 声明支持真实鼠标移动。CUA 据此在工具 schema 和模型提示词中加入该选项，负责显示授权卡、记录当前会话的决定并限制子代理。CUA 检查应用访问权限和本次移动所需的授权后，将悬停方式传给提供方。

权限响应标识所属平台，并且只报告该平台能够观察到的状态。共享页面显示这些观察结果支持的控件。平台尚未确认时显示通用观察和输入项，不提供系统操作。原生提供方共用编译锁和编译进程清理逻辑。独立可执行文件按内容摘要保存。macOS 提供方在锁内等待编译完成，再读取签名应用的构建回执。

<details>
<summary>共享执行与平台职责</summary>

[授权存储](src/permission-store.ts)复用 `storageDomain` 和配置的后端。默认 JSON 后端写入 `$DSH_HOME/storages/cua_permissions_<sha256>.json`，摘要对应 profile 的真实目录。每次授权检查在 profile 文件锁内打开并读取最新状态，随后关闭存储域；原生操作使用单独的应用锁。撤销会等待其他进程已获准执行的操作结束；撤销完成后，各进程都拒绝旧句柄。不同电脑或 PID 命名空间不能共享这把锁。

旧 `allowedApps` 只在首次访问存储时导入，迁移后不再应用。确认权限页显示正确后，可以删除旧配置。授权、拒绝和允许再次询问均持久化，页面仍不显示仅对某个会话生效的许可。没有 profile 的独立组合只保留进程内决定；有 profile 但缺少域存储的组合会拒绝授权操作。

授权记录中的可执行路径是可选的展示信息。缺少路径时不显示路径提示，也不查询图标，应用名称和撤销操作仍然可用。已有存储记录保持有效，缺少路径的新记录需要支持可选字段的读取方。存储失败仍会拒绝授权和操作，不会改用临时许可。

权限 Remote 还通过 `ptcConfiguration()` 和 `enablePersistentPtc()` 支持详情页的执行方式设置。查询读取现有执行器和可编辑的 profile 条目。显式写入从 Node 提供方的 `resolvePersistentExecution` 辅助函数获取执行设置，再用 `configEditor.edit()` 保留其他字段并按正常 Loader 规则重载；已是持久化模式的执行器保持不变。CUA 将 Node 提供方声明为 peer 依赖，使这些设置与已安装的提供方版本一致。此设置独立于系统权限和应用授权。

提供方将准备好的 helper、连接工厂、指引回调和启动能力传给 [installCua](src/index.ts)。[NativeClient](src/native-client.ts) 负责请求关联、字节上限、取消确认和失败处理。平台连接器负责启动和连接清理。其带类型的启动失败在请求写入和连接关闭时保留错误码及诊断。共享执行器为每个 Agent 保留一个连接，并在销毁时等待进行中的图像写入。

提供方实现 `CuaBackend.getGuidance(kind)`，其中 `kind: 'raw' | 'standalone'`，分别返回原始 `cua` 调用和 `cua_run_code` 程序的操作指引；两种形态可以返回相同文本。共享 CUA 为两份结果统一补充对应能力的权限指引、配置的 AX 读取默认值和最大点击按住时长。

提供方通过 `NativeClient.registerCleanup(cleanup)` 注册归连接所有的资源清理；返回的 disposer 用于注销回调。连接仍可发送请求时，回调收到 `canRequest: true`，通过 `requestCleanup()` 执行原生清理，并等待确认后返回。连接被强制关闭后，`canRequest: false` 只允许清理本地状态。程序结束和连接关闭都触发清理时，每项资源复用同一个已缓存的清理 Promise。

正常关闭连接会等待已注册的清理结束。原生清理被拒绝或超时会使连接及其句柄失效；连接释放仍会继续，清理失败也会被报告。普通原生请求超时仍然请求取消，并在 `graceMs` 内等待确认。提供方卸载会等待自己持有的 CUA 程序结束；使用原始 `cua` 的 PTC 程序可在释放其持有的输入后继续其他工作。

`agentPreset` 默认为 `ptc`：匹配的 Agent 获得原始 `cua` 工具和 PTC 指引，其他已组合的 preset 只获得 `cua_run_code` 及其指引，包括标准、创造、极简和自定义 preset。基础注册的所有者使用 `agent/created`、`agent-preset/selected` 事件和 Agent 自有作用域，也处理提供方加载前已存在的 Agent。它按定义对象的身份同步替换每组工具及提示词；程序服务不可用时只撤回程序工具定义，保留原始工具的注册。Agent 销毁会移除其注册并释放保留环境，提供方卸载还会释放专用 CUA 运行时。未组合 preset 的 Agent 不获得这两个工具。在独立组合中设置 `agentPreset: false` 可全局注册原始 `cua` 工具。Host 负责权限、本机连接和取消；preset 定义保持不变。

`cua_run_code` 复用 PTC 程序工具工厂，由 CUA 提供方持有一个隔离的 Node 运行时。每个 Agent 通过自己的 `stateOwner` 选择独立的保留进程。CUA 在该运行时注册环境初始化程序，为每个新进程安装一次 `cua`，包括临时提权执行。初始化程序的所属作用域只依赖运行时，程序工具的依赖重载时仍保留这项注册。先销毁程序工具并等待其执行结束，再注销初始化程序并关闭运行时。工厂只绑定私有 `cua` 操作工具，保留嵌套策略检查、guard、日志、取消和截图交付。私有工具不会出现在模型可直接调用的工具列表中。

[操作 schema](src/protocol.ts) 定义模型参数，以及 Host 补充的请求字段。[原生观察](src/native-observation.ts) 解析窗口回复的私有字段，更新坐标记录后返回公开结果。原生实现在执行时检查目标身份、窗口几何、资源上限和操作系统访问条件。授权存储独立于原生协议保存持久许可。

对象门面（[src/api.ts](src/api.ts)）构建共享的 `CuaSurface`，并从它派生 `CuaApp` 和 `CuaWindow`。派生工厂注入作用域参数以及该作用域的辅助功能和键盘检查；共享基类不为仅属于应用的能力分支。在单个 API 实例内，门面按 `appHandle` 保存一份当前辅助功能快照，该句柄的所有应用对象和窗口对象共享它。选择对象不改变当前辅助功能快照。每次显式调用 `getAccessibilityTree()` 在分派前使上一份快照失效，元素操作使用最新快照 ID。只有 `CuaWindow` 可以截图或发送指针输入。

提供方启动能力在安装时固定：平台、方法、应用级辅助功能、键盘作用域、浏览器支持和坐标空间。原生 `getCapabilities` RPC 只报告运行时权限和会话锁定状态；`installCua` 为模型可见结果合并两层。原生 RPC 仍是通用操作表示，而不是能力清单，因此 provider 指引说明其平台支持的动作。

通过 `await cua.getCapabilities()` 返回的 `methods` 和 `keyboard` 确认支持的操作和输入范围。`pressKey(key, modifiers?)` 在按住所列修饰键时按下并释放一个键；`sendKeyEvent(key, direction)` 只发送一次按下或抬起。`typeText` 和 `paste` 在 provider 声明的键盘作用域内传送字面文本。键盘修饰键名称是 provider 解释的普通字符串。


平台提供方从 `@deepseek-ai/dsh-cua/config` 导入 `CuaConfigFields` 来扩展共享配置。根 Host 入口导出 `installCua`、`CuaConfig` 和供 Typert 发现的 `CuaAccess` 服务，`apply()` 只标记可选 Client 贡献。`/client` 通过现有模块加载器加载权限界面。Host 和 Client 使用独立编译项目，headless 导入不会加载 React、CSS 或浏览器注册。`/api` 提供应用、窗口 API 及其类型；`/bridge`、`/native-client` 和 `/protocol` 保留运行时和平台消费者。`/types` 仅导出生成 Remote 声明所需的命名类型，Client 使用包内类型。`/typert` 提供 Host 反射，`/remote` 提供浏览器描述和编解码，权限判断仍由 Host 执行。

可选浏览器插件挂载原生 provider 的权限 Remote，复用插件页的启用引导和配置插槽。四排使用条件始终可见，未加载的字段保留占位；平台确认后，查询期间和权限已允许时均保留权限管理说明。默认模式、执行方式、系统权限、应用列表和应用图标分别查询，结果返回后各自显示。应用名称和操作按钮不等待图标，图标位置保留空位。用户操作按顺序执行，不等待尚未完成的查询；卸载时等待操作和查询全部结束，再释放独立持有的 Remote 挂载。已知查询错误和只读设置提示在管理操作或重试期间保持可见，操作按钮禁用。查询错误只显示在对应部分，启用引导只等待系统权限结果。注入层独立于页面观察插件管理操作。组合包和组件行变更会暂停四项查询，并使进行中的结果失效；操作结束后即使页面已关闭，也会重新查询。已知错误保留至读取成功；卸载后的迟到结果会被丢弃。控制器直接接收生成的 `ctx.remote.cuaAccess`，在现有查询和操作流程中处理失败响应，并把查询结果投影到页面和设置弹窗；重新连接时刷新状态。进入页面、窗口聚焦或操作完成后读取当前授权存储。操作提示挂载到 shell overlay，关闭页面后仍可显示。provider 负责权限检查、持久授权和取消；浏览器不保存授权决定。

详情页通过现有 `configForms` 服务读取实际默认值（`selectedDefault ?? default`）。默认模式按钮仅写入 `selectedDefault`，沿用表单带版本检查的设置写入流程。执行方式一行调用 CUA 的 `ptcConfiguration()` 和 `enablePersistentPtc()`，根据已加载运行时的 `retainsState` 判断状态保留。启用持久化时保留正在使用的 Script 求值器，并通过配置编辑器同时写入 `executionMode` 和 `scriptPersistence`；其他模式选择保留状态的 REPL，并关闭 Script 状态保留。操作沿用普通 Loader 重载规则。权限检查和执行方式状态独立返回。设置仍在加载、只读或不可用时不能提交；写入失败时在设置旁显示错误，供用户重试。
</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [macOS 提供方](../cua-macos/README.zh.md)
- [对象接口](src/types.ts)
- [作用域表面与键盘输入](../../../.agents/notes/implemented/architecture/2026-11-05-cua-scoped-surfaces-and-input.zh.md)
- [授权存储迁移](../../../docs/upgrade-guide/v0.2.1-rc.2/cua-consent-storage/guide.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 已授权的应用操作

#### 模型可见内容

默认 preset 配置下，PTC 通过已有 `run_code` 工具获得 `cua`，其他已组合的 preset 获得 `cua_run_code`。其描述说明：“The global cua object is ready to use; retain application and window objects across calls.” 程序只绑定 `tools.cua`，普通工具仍可直接调用。调用和观察使用同一套应用与窗口接口，进入正常 Session 历史。Web 卡片显示程序、嵌套调用和截图。平台指引见 [macOS 提供方](../cua-macos/README.zh.md#model-experience)。

#### Token 影响

选用的工具 schema 和 CUA 指引增加模型输入。程序输出、操作结果和接纳的图像增加历史；程序内只描述 CUA 绑定。保留的 JavaScript 对象不会序列化进提示词。调用方重复打印会重复观察文本。

#### KV Cache 影响

结果追加到历史。保留对象不重写已有消息；更改挂载的工具或指引可能改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 会话决定没有自动保留期限，也不会随对话删除而自动清理。撤销会移除许可，但保留撤销代次，用于拒绝旧句柄和先前尚未完成的审批。
- 原生行为和桌面验证由各平台负责；支持的应用、输入限制和实测覆盖范围见对应提供方文档。
- `agentPreset` 选择一个 preset ID，不检测执行器。ID 不匹配的自定义 PTC preset 会在外层 `run_code` 中获得 `tools.cua_run_code`。嵌套程序使用独立的 CUA 环境和 `standaloneRunCode` 上限，同时仍受外层程序的截止时间和取消约束。将 `agentPreset` 设为该自定义 ID，可在其中使用原始 `tools.cua`；只有匹配的 ID 获得原始形态。
- `cua_run_code` 状态仅保存在内存中，且独立于 PTC 状态。进程丢失、Agent 销毁或提供方卸载都会丢弃它；应用授权仍独立保存。
- 持久变量不会在一组连续操作期间独占应用。其他 Agent 和用户可能改变其状态。指针移动和观察不恢复先前的鼠标位置；[连续交互](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)不分配跨调用所有权。
- 元素 ID 是应用当前辅助功能快照中的不透明字符串。之后读取同一应用的任一窗口会替换当前快照，因此调用方必须使用最新树中的 ID；旧字符串可能被复用于另一个控件。截图或指针输入要求显式选择窗口。

-----

<a id="dev-note"></a>
### 开发备注

无。
