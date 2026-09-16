---
description: "从 Web 侧栏管理 profile 的插件组合包及其行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

[English](README.md) | 中文

## 概述

使用 Web 侧栏的**插件**入口管理 profile 已安装的组合包，以及安装随附、默认关闭的官方组合包。可以启停组合包及其行、在 Host 读出 spec 指向什么之后安装组合包、查看 pnpm 输出、停止一次运行，并启用它新增的包。卸载会要求确认。全局配置仍在设置中编辑。

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

在侧栏选择**插件**。页面首次打开时通过 `api-remotes` 读取清单与组合包；没有受管 profile 的 Host 上页面显示为不可用。**内置**排在前面，列出安装随附、供开启的组合包，每个带官方标签，开启前保持关闭，且没有卸载；**已安装**列出 profile 持有的组合包。卡片按名称排序，启停组合包不会挪动它的卡片。没有组合包 patch 的依赖不是插件，除非 profile 选中了它才会带异常标签列出。全局配置仍在设置的**插件**分区中编辑。

### 安装一个组合包

**添加插件**接受包名（可带版本）、Git 地址、压缩包或本地绝对路径；对话框说明包名就是 README 里 `dsh plugin add` 后面的那一段。输入框下方的**不知道该填什么？**展开一段引导，给出三种常见形式各一个示例；**填入示例**把示例填进输入框。**安装**先让 Host 读出 spec 指向什么（`pluginManager.inspect`）：列表中已有的名字、注册表没有的名字、没有包的路径、没有组合包 patch 的包，或 pnpm 会拒绝的 spec，都以一句话回到输入框下方，spec 保留可继续编辑。通过检查的 spec 打开安装中界面，展示 Host 读到的包名、一句话简介和版本，pnpm 的命令与输出折叠在**查看安装详情**之后。安装完成后提供**立即启用**：启用新组合包、关闭对话框并把列表滚动到它；直接关闭则让它保持已安装但关闭。安装失败时用一行话说明原因——注册表或网络不可达、包不存在、磁盘已满、profile 不可写、pnpm 拦下了构建脚本——pnpm 输出在详情里，**重试**就在手边；Host 已经把 profile 文件放回原样。pnpm 拦下依赖的安装脚本时，失败界面列出等待允许的包，并以**允许这些脚本并重试**取代**重试**；Host 把授权写进 profile 的 `pnpm-workspace.yaml`（失败的运行保留 pnpm 写入的这个文件）再运行 pnpm，安装完成界面会说明允许了哪些脚本。安装成功不代表模块一定能够激活。

安装期间可点击**取消安装**，对话框显示**正在停止安装…**，直到 Host 确认。加载组合包的阶段不可取消。确认后对话框回到 spec 输入界面，可再次安装，并用 toast 说明安装已取消；manifest 与 lockfile 已恢复原样，已下载文件可能保留。Host 仍在处理操作时不能关闭对话框。连接错误不代表取消成功：安装中界面会如此说明，可以再次尝试取消。

### 切换一个组合包

组合包页面在标题下方显示完整包名，也就是在别处安装它所需的 spec。组合包开关改变其层选择。启用了 HMR 的 profile 在操作完成前重组；没有 HMR 的 profile，以及被更高层覆盖的组合包，会以 toast 说明。Host 读不了的组合包带异常标签，其页面给出原因，且不能打开；提供管理组件的组合包保持锁定。Host 以错误码作答，由页面字典措辞；pnpm 与 Loader 自己的诊断原样显示。随安装提供的组合包不在本页；设置中「插件」分区的「插件列表」标签页负责查看它们。

### 切换组合包里的一行

组合包页面上行的开关调用 `pluginManager.setPluginEnabled`，往 profile 的 `cordis.patch.yml` 写入该行的 `disabled` 覆盖。启用了 HMR 的 profile 的树随即重组，该行的宿主半区卸下或挂上，组合包其余部分照常运行，页面无需重载即跟随客户端模块图。行按 Host 运行它们的 fiber 阶段显示状态。开关只出现在已打开的组合包上；没有存活条目的行，以及 Host 不通过 profile patch 寻址的行，带着 Host 的原因锁定。超过十行的列表带一个按行 id 筛选的输入框。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件管理依据 profile 的依赖记录：已安装组合包可启停、可移除，随安装提供的组合包保持锁定。这一区分不决定启动失败策略。

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件通过 `ctx.slots.inject()` 注册 `plugins` 侧栏入口与它的 `main` 面板，使两者跟随 slot 延迟声明、本地化变化与销毁。页面为全局页面，不属于任何 Session。显示文本来自包元信息与页面字典。

### store

`PluginManagerController` 拥有组合包视图、忙碌键、提示、安装进度和卸载确认。每次读取先问清单 Host 是否管理着 profile，再把 `listBundles` 与 `listPlugins` 合成每个组合包一份视图，其行携带存活条目的启停状态与 fiber 阶段。它合并重叠读取，在操作后、收到 `plugin-manager/changed` 时以及重连后刷新，并在销毁后忽略晚到结果。安装输出按 job id 分组。安装对话框沿 `idle → checking → starting → running → done | failed` 推进，`cancelling` 与 `applying` 按 Host 的报告呈现。检查在一个 `AbortController` 下运行，返回编辑或关闭会中止它并丢弃其结果；运行只能通过 `pluginManager.cancelInstall` 停止，对话框等待其答复。Host 无法应用的变更、要等重启的变更、被更高层覆盖的变更，都是会自行消失的 toast。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖侧栏、Remote 调用与 Host 侧管理器。

- [ui-sidebar](../ui-sidebar/README.zh.md)——插件入口注册进的面板列表；[ui-layout](../ui-layout/README.zh.md)——页面占用的主 slot。
- [api-remotes](../../api/remotes/README.zh.md)——`pluginManager.*` 与 `pluginInventory.*` 背后的 Remote BFF 面。
- [plugin-manager](../../boot/plugin-manager/README.zh.md)——本页驱动的 Host 侧管理器。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的管理界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了管理视图的范围；它们是当前包的约束。

- **只管理组合包**——没有组合包 patch 的依赖在安装前就被拒绝；profile 里已有的这类依赖不上页面，除非 profile 选中了它；加载普通插件模块仍是文件操作。
- **行只显示阶段，不显示原因**——失败的行只显示为失败，没有 Host 的错误文本；Host 日志里有。
- **一次只能安装一个**——对话框一次运行一个 pnpm 命令；第二个 spec 要等前一个完成。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；页面不列出注册表版本，也不提供升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生检查。本包只拥有一个基于 Host 事实的侧栏面板。
