# Agent Note: 语言中立的默认工作区命名

Status: implemented

[English](2026-09-23-language-neutral-default-workspace-naming.md) | 中文

## Problem

[首次使用默认工作区](2026-09-20-default-workspace.zh.md)让 Client 按启动语言同时决定目录名和存储标题：中文安装环境创建 `默认工作区`，英文创建 `Default workspace`，其他语言创建 `default-workspace`。读者看到的名称与写入磁盘的名称是同一个字符串，因此一个产品决策承担了两项互不兼容的要求。路径会被 shell 命令、工具参数、`@path` 引用、会话日志和备份寻址，不应取决于安装环境启动时恰好使用哪种语言。标签是给人读的，应当使用读者的语言。事后切换语言两者都无法满足：路径已经固定，由它派生的标签也已固定。

## Decision

目录名与存储标题是同一个固定的、语言中立的字符串；只有屏幕上的标签跟随读者语言。

`DEFAULT_WORKSPACE_DIRECTORY`（`default-workspace`）由 [Workspace 控制器](../../../../packages/api/workspace-controller/README.zh.md#first-use-workspace)拥有，并通过其独立的 `./default-workspace` 子路径导出——它是一个没有任何 import 的纯折叠函数，因此 Client 包会内联它，而不是去请求本包并未发布的模块表条目。Host 将它拼接在 `<Documents>/deepseek-harness` 下，注册表则以规范目录的最后一段作为工作区标题，因此自动标题*就是*同一个名称，不存在需要同步的第二个来源。

因此 `workspace.initializeDefault` 完全不接受请求参数；`WorkspaceInitializeDefaultRequest` 及其名称校验被删除，注册表的解析器返回路径而不是路径加标题。语言不会传到 Host，因此那里不可能与 Client 在命名上产生分歧。

浏览器消费方通过 `workspaceDisplayTitle(title, localizedDefault)` 为单个工作区加标签：标题仍等于自动标题时显示为本地化的默认名称，其他标题一律原样显示。该名称放在 `common` 语言命名空间（`workspace.defaultName`），因为有两个包展示它——Workspace 浏览区在读取 store 时解析一次，行、悬浮卡片、搜索结果元信息以及重命名与删除对话框都继承该结果；Conversation 的工作区 chip 则为 hero 自行解析。

让某一行不再跟随语言的动作就是重命名，无需额外存储标记：对话框以屏幕上的标签作为初值，而判断确认是否需要保存用的是*存储*标题。对于仍保留自动标题的工作区两者不同，因此直接确认未改动的初值就是一次真实的重命名，会把该名称固定下来。重名检查中排除自身也因此改为按工作区身份判断——初值标签与该行自己显示的标题相同，但这并不构成与自身的冲突。

## Alternatives considered

- 在 `WorkspaceView` 上标记"从未重命名"状态（由 Host 依据 `defaultWorkspaceId` 与自动标题推导的布尔值）可以消除下述误判，但会让一个共享的传输类型多承载一项 Host 本身别无用途的展示状态。比较存储标题是同一项判断，且不增加 wire 表面。
- 在 Client Workspace store 内部本地化标题可以一处覆盖所有消费方，但返回产品文案的 store 需要在语言修订变化时重新投影，而且会把文案放到 i18n 门禁检查的 `t` 座位之外。
- 保留本地化目录名并另存一个标题可以保住旧路径拼写，但每个安装环境的路径仍由其首个语言决定——正是本笔记要消除的缺陷。
- 在语言切换时重命名已有的本地化目录，会为了外观收益破坏已记录的会话 `cwd`、工具参数和 `@path` 引用。

## Consequences

本次改动之前创建的安装环境保留其既有的本地化目录和标题。不会有任何重命名或迁移；它们的标题不再与自动名称相同，因此原样显示——这与从未重命名过中文安装环境的用户已经看到的结果一致。

存储标题恰好为 `default-workspace` 的工作区会按默认工作区显示，即使它并非注册表的默认工作区——例如从选择器采用的同名文件夹，或被重命名为该字面值。除标签之外没有其他行为依赖该判断。Workspace 浏览区在 Client 侧的重名检查比较的是本地化标题，因此当第二个工作区被命名为本地化默认名称时它会报冲突，而按存储标题比较的 Host 会允许；拒绝两行显示完全相同的名称是更好的答案，权威的唯一性检查仍由 Host 拥有。

有两处由工作目录派生的 *Session* 标签仍显示原始路径片段，因为它们命名的是目录而非工作区：Session Controller 的 `displayTitleOf` 在 Session 没有持久标题时回退到 cwd 最后一段，侧栏搜索结果的元信息在 Session 没有所属工作区时同样回退。两处此前显示本地化名称，现在显示 `default-workspace`。把它们接入 `workspaceDisplayTitle` 会把自动标题判断扩散进 Session 命名，而这种情形几乎总会先被 Session 标题生成填上。
