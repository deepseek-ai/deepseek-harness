---
description: "通过应用子菜单打开会话目录，并通过原生应用打开预览文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

[English](README.md) | 中文

## 概述

通过会话头部更多菜单或会话行、标题右键菜单中的**在应用中打开**打开会话目录。子菜单按 Host 顺序列出已安装且已本地化的应用，仅显示图标和名称，不标注默认应用。文件树、文档预览和交付控件也可通过原生应用打开文件或目录。可用性、图标和启动由 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 提供；两个包应一起挂载。会话目录未知或没有符合条件的应用时，不显示在应用中打开。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 并排挂载到 Web 组合；本行不接受配置。会话目录已知且至少有一个已安装、已本地化的目录应用时，显示在应用中打开子菜单。Host 通过 `session.canOpenWorkspacePath` 报告桌面可用时，[`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.zh.md) 的文档预览显示文件控件；删除本行会移除其全部控件与菜单贡献。

头部入口使用 [`ui-conversation`](../ui-conversation/README.zh.md) 持有的更多按钮，由 [`ui-context-menu`](../ui-context-menu/README.zh.md) 提供共享按钮行为。未挂载导出插件时，在应用中打开仍可通过该入口使用；本包提供菜单项，而不创建自己的头部按钮。

### 预期行为

会话头部把**在应用中打开**放在下载之后、反馈之前的独立分隔组。会话行更多、行右键及标题右键菜单把它放在复制 Session ID 之后、归档之前。只有一个应用时仍保留子菜单。文件树与文档标题栏保留高 24px、圆角 9px 的纯图标分体按钮。这些按钮的悬停提示显示默认应用或定位动作，其菜单保留默认标记。所有应用图标加载失败时均使用原生打开图标。文件树按钮以所属组件传入的 `absolutePath` 为目标，并与会话菜单共享应用选择及启动占用状态。目录选择仅在启动成功后持久化到 `dsh.open-in-app.choice`；原选择不可用时回退到首个符合条件的应用。目录启动忙碌时，禁用子菜单父项和全部应用行。

在 iOS、Android 手机和平板上（包括已安装的 PWA），原生打开获得确认后显示「已在其它设备打开」，文件定位则显示「已在其它设备显示文件位置」。电脑端成功时不提示，包括窄窗口浏览器与已安装的桌面 PWA。Host 拒绝请求或无法连通时，所有客户端都会收到失败 toast。成功表示 Host 已接受原生操作，不代表目标应用已完成文件加载。反馈复用现有移动设备判定，不依据窗口宽度或安装模式。

**在本地打开**快捷键捕获主会话目录及已记住的应用。有效绑定继续显示在文件树打开按钮的 tooltip 和 `aria-keyshortcuts` 中；Web 遵循[快捷键服务的平台默认值](../shortcuts/README.zh.md)。只有选中会话界面且该会话具有可打开目录与已安装应用时才执行命令。启动进行中会阻止命令；结果遵循与点击操作相同的反馈规则。鼠标与键盘操作共享控制器的启动状态，因此重复操作不会启动两次，也不会在启动期间更改已记住的选择。

文件菜单列出已发现的关联应用，不单列“用默认应用打开”。“显示文件位置”固定在菜单底部，通过分隔线与滚动的应用列表分开。查询成功且只有一个可用操作时显示单按钮，不再显示下拉箭头。文件关联首次加载时使用灰色骨架图标。Host 识别出默认应用时，菜单将该项标注为“（默认）”，主按钮打开该应用；否则第一个关联应用占据该位置，只有在一个关联应用都没有时主按钮才执行文件定位。目录菜单不包含定位项。选择文件应用不修改系统默认应用。无法预览文件时，空态使用同一菜单，按钮增大到 40px 高并显示图标和动作文字；根据默认动作显示“打开”或“显示文件位置”。

使用同一查询函数和文件的已挂载控件共用查询与结果，打开任一菜单会刷新所有相关控件。最后一个控件释放后取消查询并清除状态。已取消的查询不会覆盖其他文件的结果。查询失败时菜单显示提示，并以文件定位作为默认动作。文件关联查询的平台支持范围见 [native-command](../../util/native-command/README.zh.md)；查询结果为空时，包括平台尚无查询适配器的情况，控件统一使用定位动作，不按操作系统分支处理。

工作区右键菜单通过共享的目录应用列表定位被点击的文件夹。文件树目录提供原生定位与复制文件夹路径，不提供文件预览或保存。

右键菜单通过 [ui-context-menu](../ui-context-menu/README.zh.md) 贡献文件预览、原生应用打开、原文件定位以及链接导航与复制。会话子菜单解析被捕获会话 ID 的目录，不使用主视图，并观察应用、操作、会话列表及语言变化。原生操作在菜单关闭或目标切换后仍通过本功能的全局 toast 报告，不产生第二个注册表提示。原生文件操作先通过授权元数据解析会话路径，再查询关联应用。文件不存在时禁用路径操作；图片定位要求实际 Host 文件，并始终针对原文件。[ui-file-actions](../ui-file-actions/README.zh.md) 负责复制、下载、另存为及完成提示，包括通过提示定位保存目标。

文件菜单复制不含行号的绝对路径；网址复制保留查询参数与锚点。图片文件在既有文件操作之外，还提供复制图片与下载原图。下载和保存成功后显示共享 Toast，取消选择器时不提示。

文件菜单提供“在侧边栏打开”与“在浮窗中打开”，以 `destination: 'sidebar'` 或 `'float'` 和目标的行号调用 `ctx.sidebarRight.openResourceIn`，从不传菜单所在的分栏。文件已在请求的位置打开时揭示它；在另一位置打开时连同阅读位置移过去，因此菜单可以把预览在停靠列和浮窗之间移动。左键打开文件的行为不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

[`session-open-with.ts`](src/client/session-open-with.ts) 为共享右键菜单包声明的 `session` 和 `sessionHeader` 目标共用一个解析器；其他贡献不会在这两种目标间扩散。文件树插槽通过所属组件的 `absolutePath` 使用 `OpenInAppAction`；会话头部没有独立打开按钮插槽。页面生命周期的 [`controller`](src/client/controller.ts) 持有可用性、持久化偏好与启动 POST 状态。菜单观察器和组件注入 hooks 读取同一组源。文档相对路由与载荷类型来自 Host 的浏览器安全子路径 `@deepseek-ai/dsh-host-open-in-app/shared`。适配器将原生操作及传输失败解析为具名结果；跳过的请求不播报。

目录和文件适配器把应用信息与操作交给 [`OpenTargetButton`](src/client/OpenTargetButton.tsx)，由它统一管理菜单顺序、默认标记、图标和尺寸。注入的回调将结果交给本功能在 `shell.overlay` 中持有的唯一 toast，因此切换会话或关闭发起操作的预览不会丢失结果。文件标题栏和空态共用 `FileOpenTarget`，`OpenPathInjected.applications` 通过 [`open-path.ts`](src/client/open-path.ts) 查询 `session.workspacePathApplications`。打开操作使用 `session.openWorkspacePath`，Host 在启动前重新验证指定的关联应用。`FileRouteAction` 通过 `deliverables.file.actions` 和 `deliverables.review.file.actions` 为交付卡片和变更对比页提供同一控件，其认证路由保留会话文件校验。目录适配器继续使用已有的应用列表路由，文件查询失败或不可用时无需增加平台专用的界面实现。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-host-open-in-app](../../host/open-in-app/README.zh.md)——提供可用性、图标与启动的主机路由，及其背后的目录。
- [ui-conversation](../ui-conversation/README.zh.md)——持有共享更多按钮的会话头部。
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.zh.md)——声明文件控件所占头部与空态子 slot 的文档预览。
- [ui-deliverables](../ui-deliverables/README.zh.md)——交付卡片，仍通过自己的路由打开声明过的文件。
- [Web client 架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无。这些打开控件与菜单是浏览器界面；不会进入模型请求。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延后工作

Host 在打开或定位前通过当前文件系统验证路径。没有对应 Host 映射的路径会失败，不会启动原生应用。默认打开遵循文件类型关联，包括 HTML 和 SVG。

<a id="known-limitations-and-deferred-work"></a>

- **词典把守菜单。** 主机目录的新条目若在两份词典中没有对应的 `app.<id>` 条目，将保持不可见而不是显示裸 id；扩展目录意味着同时扩展 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 与本包的 locale。
- **可用性每页只读一次。** 页面打开期间安装的应用要重新加载页面后才出现（主机侧还需主机重启）；文件控件背后的桌面回答同样每页只读一次。
- **所有平台共用一个定位标签。** Session Remote 只报告有没有桌面，不报告它跑的是哪个文件管理器，所以菜单写「显示文件位置」，而不像交付卡片那样点名访达或文件资源管理器。
- **交付卡片保留自己的打开器。** [`ui-deliverables`](../ui-deliverables/README.zh.md) 仍通过自己按 Session 与事件定位的路由打开声明过的文件；把这些卡片并到这里的文件控件上仍属延期工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

功能层面的各项决定，包括拆分为主机包与本表面包，记录在[历史转正 Agent Note](../../../.agents/notes/archived/feature/2026-08-25-promote-open-anywhere-plugin.md)；文档预览的文件控件记录在[历史默认应用 Agent Note](../../../.agents/notes/archived/feature/2026-09-16-open-in-default-app-for-sidebar-files.md)。

</details>
