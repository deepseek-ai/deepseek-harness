---
description: "Web \"Open In...\" 控件：会话头部在记住的应用中打开 workspace 目录的分体按钮，以及文档预览里用默认应用打开、显示单个文件位置的控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

[English](README.md) | 中文

## 概述

本包提供 open-in-app 功能的浏览器表面。会话头部的分体按钮在记住的应用中打开当前会话的 workspace 目录（会话摘要的 `cwd`），下拉箭头列出主机探测到已安装的全部 catalog 应用；可用性、图标与启动均来自 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 的主机路由，所以两个包要一起挂载。在右侧 Sidebar 的文档预览里，一个「打开」分体按钮和一个空态按钮经由 Session Remote 用默认应用打开当前文件或显示其位置。主机没有这项能力时，这些控件一个都不渲染。

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

把本插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 并排挂进 Web 组合；这对包用两行 cordis.yml 组成完整功能，本行不接受任何配置。只要主机探测到至少一个已安装的 catalog 应用且会话有已知的 workspace 目录，会话头部就会出现 "Open In..." 分体按钮。只要 Host 通过 Session Remote 的 `session.canOpenWorkspacePath` 报告有桌面，[`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.zh.md) 的文档预览就会长出文件控件；删掉这一行会一次去掉所有控件。

### 预期行为

会话标题栏和文档标题栏共用同一个高 24px、圆角 9px 的分体按钮。两个标题栏都只显示图标，悬停提示显示默认应用名称或文件定位动作。两者都显示默认动作的图标，在菜单的默认应用后标注“（默认）”，仅在自己的操作执行期间禁用，并通过短暂提示报告失败。目录适配器使用已有的跨平台应用列表，将最后一次成功选择保存在 `dsh.open-in-app.choice` 中；原选择不可用时回退到第一个可用应用。

**在本地打开**快捷键捕获主会话的目录，并使用与头部按钮相同的已记住应用。按钮 tooltip 和 `aria-keyshortcuts` 显示当前有效绑定；Web 遵循[快捷键服务的平台默认值](../shortcuts/README.zh.md)。只有选中会话界面、且头部按钮有可打开的目录和已安装应用时，命令才执行。启动尚未结束时也会阻止命令。鼠标与键盘操作共享 controller 的启动状态，重复操作不会启动两次，也不会在启动期间更改已记住的选择。

文件菜单列出已发现的关联应用，不单列“用默认应用打开”。“显示文件位置”固定在菜单底部，通过分隔线与滚动的应用列表分开。查询成功且只有一个可用操作时显示单按钮，不再显示下拉箭头。文件关联首次加载时使用灰色骨架图标。Host 识别出默认应用时，菜单将该项标注为“（默认）”，主按钮打开该应用；否则第一个关联应用占据该位置，只有在一个关联应用都没有时主按钮才执行文件定位。目录菜单不包含定位项。选择文件应用不修改系统默认应用。无法预览文件时，空态使用同一菜单，按钮增大到 40px 高并显示图标和动作文字；根据默认动作显示“打开”或“显示文件位置”。

使用同一查询函数和文件的已挂载控件共用查询与结果，打开任一菜单会刷新所有相关控件。最后一个控件释放后取消查询并清除状态。已取消的查询不会覆盖其他文件的结果。查询失败时菜单显示提示，并以文件定位作为默认动作。文件关联查询的平台支持范围见 [native-command](../../util/native-command/README.zh.md)；查询结果为空时，包括平台尚无查询适配器的情况，控件统一使用定位动作，不按操作系统分支处理。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

插件通过标准 slot/inject 机制把分体按钮注册到 `conversation.session.header.utilities`，并以一个 effect 注册 `open-in-app` 词典。一个页面生命周期的 controller（[`src/client/controller.ts`](src/client/controller.ts)）拥有每页一次的可用性读取、持久化选择的 snapshot store 与启动 POST；组件经 inject 的 `hooks` 隔间接收共享源，因此所有会话头部共享同一份事实。文档相对的路由形式与 wire 载荷类型来自主机包的浏览器安全子路径 `@deepseek-ai/dsh-host-open-in-app/shared`。controller 守卫执行中的启动，并发布所捕获的目录与状态；头部控件从该源派生延迟出现的等待态和短暂错误态。

目录和文件适配器把应用信息与操作交给 [`OpenTargetButton`](src/client/OpenTargetButton.tsx)，由它统一管理菜单顺序、默认标记、图标、尺寸和操作反馈。文件标题栏和空态共用 `FileOpenTarget`，`OpenPathInjected.applications` 通过 [`open-path.ts`](src/client/open-path.ts) 查询 `session.workspacePathApplications`。打开操作使用 `session.openWorkspacePath`，Host 在启动前重新验证指定的关联应用。`FileRouteAction` 通过 `deliverables.file.actions` 和 `deliverables.review.file.actions` 为交付卡片和变更对比页提供同一控件，其认证路由保留会话文件校验。目录适配器继续使用已有的应用列表路由，文件查询失败或不可用时无需增加平台专用的界面实现。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-host-open-in-app](../../host/open-in-app/README.zh.md)——提供可用性、图标与启动的主机路由，及其背后的目录。
- [dsh-session-log-export](../../session-query/session-log-export/README.zh.md)——会话头部的姊妹动作。
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.zh.md)——声明文件控件所占头部与空态子 slot 的文档预览。
- [ui-deliverables](../ui-deliverables/README.zh.md)——交付卡片，仍通过自己的路由打开声明过的文件。
- [Web client 架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无。分体按钮是浏览器 chrome；这里没有任何东西进入模型请求。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延后工作

Host 在打开或定位前通过当前文件系统验证路径。没有对应 Host 映射的路径会失败，不会启动原生应用。默认打开遵循文件类型关联，包括 HTML 和 SVG。

<a id="known-limitations-and-deferred-work"></a>

- **词典把守菜单。** 主机目录的新条目若在两份词典中没有对应的 `app.<id>` 条目，将保持不可见而不是显示裸 id；扩展目录意味着同时扩展 [`dsh-host-open-in-app`](../../host/open-in-app/README.zh.md) 与本包的 locale。
- **可用性每页只读一次。** 页面打开期间安装的应用要重新加载页面后才出现（主机侧还需主机重启）；文件控件背后的桌面回答同样每页只读一次。
- **所有平台共用一个定位标签。** Session Remote 只报告有没有桌面，不报告它跑的是哪个文件管理器，所以菜单写「显示文件位置」，而不像交付卡片那样点名访达或文件资源管理器。
- **交付卡片保留自己的打开器。** [`ui-deliverables`](../ui-deliverables/README.zh.md) 仍通过自己按 Session 与事件定位的路由打开声明过的文件；把这些卡片并到这里的文件控件上，延后到 [Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.zh.md) 记录的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

功能层面的各项决定，包括拆分为主机包与本表面包，记录在[转正 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.zh.md)；文档预览的文件控件记录在[默认应用 Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.zh.md)。

</details>

**运行时不变式：** 不发布伴生入口。插件注册一个词典 effect 和五个 slot 条目，HMR 安全性 spec 证明它们都会在资源释放时撤销；应用可用性、选择与桌面回答存储在控制器的快照存储中，不存在可能与之分歧的第二份副本。
