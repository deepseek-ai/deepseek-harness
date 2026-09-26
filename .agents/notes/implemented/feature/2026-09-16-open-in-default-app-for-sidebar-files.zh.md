# Agent Note：用默认应用打开 Sidebar 预览的文件

Status: implemented

[English](2026-09-16-open-in-default-app-for-sidebar-files.md) | 中文

## 问题

用 Host 默认应用打开文件、或在文件管理器中显示文件，此前只存在于交付卡片上，走的是 `ui-deliverables` 私有的路由与 fetch 控制器，按 Session、声明事件序号和文件下标定位。右侧 Sidebar 的文档预览没有任何本地交接：视频、压缩包、office 文档、被读取器判为非文本的文件、过大的文件，都停在一行说明上，唯一的控件是重试，哪怕再读一次也无济于事（issue #3932）。这些文件没有交付事件可供定位，所以现有管线无法服务第二个界面。第一版实现（PR #4120，作者 Yifffan）新增了 `ui-open-locally` 包，自带 Host 路由，并把交付卡片也迁了过去；产品评审要求改为把文件打开放进现有的 open-in-app 功能，并接受本期先落一个中间态。

## 决定

[ui-open-in-app](../../../../packages/client/ui-open-in-app/README.zh.md) 拥有浏览器侧的控件。[ui-sidebar-documentpreview](../../../../packages/client/ui-sidebar-documentpreview/README.zh.md) 的文档预览声明两个 Session 作用域的 list 子 slot，owner props 携带文件在执行环境中的绝对路径，只在文件元数据报出该路径后渲染：`sidebar.right.tab.document.actions` 在每个显示头部的状态里跟在头部自有控件之后，`sidebar.right.tab.document.unpreviewable` 占据原本放重试的位置。预览对空态的读取失败分类：`not-text` 与 `too-large` 是可读但预览无法渲染的文件，提供 unpreviewable slot；`not-found` 与 `not-regular-file` 只给说明；其余失败保留重试，因为再读一次可能解决。不支持后缀的空态不发起读取，提供同一个 slot。

ui-open-in-app 填满这两个 slot：一个「打开 ▾」分体按钮，主按钮用默认应用打开文件，菜单再加文件管理器定位；一个空态的「用默认应用打开」按钮。Host 回答有桌面之前，两个控件都不渲染。控件调用 Host 早已发布的 Session Remote：每页调用一次 `session.canOpenWorkspacePath`，每个手势调用一次 `session.openWorkspacePath`，带上绝对路径，定位时再带 `action: 'reveal'`；没有新增任何 Host 路由。两个控件共用一个手势 hook：只有用户按下的那个控件在调用结算期间禁用，失败的调用解析为一个失败种类，由该控件通过短暂 toast 提示一次，控件上不残留失败状态。

## 考虑过的备选

**新建自带 Host 路由的 `ui-open-locally` 包**（PR #4120）是这对 slot、失败分类、分体按钮设计和 toast 规则的来源。放弃它是因为仓库已经有 open-in-app 功能，再来一个负责本地打开的包属于重复；共享的 Session Remote 负责通过当前文件系统验证 Host 路径。

**在 `dsh-host-open-in-app` 里加 Host 路由**提供桌面信息和按路径打开，能让 Host 报出文件管理器的名字，并区分文件不存在和启动失败。但这会让 Host 半边为了 Session Remote 已经发布的两个调用而依赖 `sessionController`、`workspaceFiles` 与 `fs`，所以直接使用 Remote，定位标签保持通用说法。

**现在就把交付卡片迁到这些控件上**会重做 PR #4120 里最大的那部分，包括评审否决的跨插件运行时导入，以及它不得不迁移的交付录制场景。本期卡片保留自己的路由。

## 后果

每个有经过验证的 Host 映射的预览文件都能从 Sidebar 本地打开，包括从未交付过的文件。没有这种映射的路径会在原生打开前被拒绝。交付卡片和预览在同一项 Host 能力上跑着两套打开器；把它们统一起来，并按界面决定展示完整应用列表还是只展示默认应用，是产品方向点名的下一步。定位菜单项在所有平台都写「显示文件位置」，因为 Session Remote 不报告文件管理器。用默认应用打开带有 Host 文件关联的执行语义；护栏是用户对 Session 已可读文件的明确手势，没有授予任何新的 Host 权限。

单元测试覆盖失败分类、预览对每种出路的渲染以及在 Host 路径未知时对座位的保留、路径控制器的桌面读取与手势结果、两个控件的可见性、忙碌隔离与 toast，以及插件的注册与 fiber 释放时的移除。无密钥的 Web 文档预览场景在 POSIX 主机上用桩打开器驱动不支持后缀的控件，seeded-history 的文件预览 golden 固定住头部控件。
