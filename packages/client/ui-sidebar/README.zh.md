---
description: "dsh Web 客户端的侧边栏外壳插件：品牌行、New Session 操作、折叠控件、可感知滚动的区域席位与底部固定的 Settings 席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

[English](README.md) | 中文

## 概述

dsh Web 客户端的侧边栏让用户识别当前构建、启动新会话、将导航折叠为 56px 轨道、浏览 Workspace 与 Session，以及打开 Settings。它会将 Settings 入口固定在底部，并在隐藏空闲滚动条时避免浏览器行发生位移。New Session 优先使用显式选择的 Workspace，其次使用当前 Session 所属的 Workspace，再其次使用最近活跃的 Workspace；如果都不存在，则打开空白的 New Session 页面。部署可以替换品牌标记或名称，同时保留导航控件和轨道几何。

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

侧边栏是导航外壳：用户看到品牌、启动新会话、折叠轨道并到达 Settings。功能插件填充它的席位——ui-workspace 填充 `sidebar.workspaces`，ui-settings 在 `sidebar.settings` 注册触发行与设置面板。

### 品牌与 New Session

展开的品牌行把 `sidebar.brand.mark` 与 `sidebar.brand.name` 渲染为两个独立的 single slot；收起轨道则渲染同一个 mark slot。没有占位者时，外壳使用鱼形标记和本地化的本地构建标签。完整构建会在标签下方显示代码徽标；该徽标使用 `DSH_CLIENT_VERSION`、可选的 7 位 `DSH_CLIENT_COMMIT_HASH` 与 `DSH_CLIENT_GIT_DIRTY=true` 组装成 `version[-commit][-dirty]`；缺少版本元数据时不显示徽标。New Session 优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。

### 全局面板入口

插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或 locale-aware 的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。标签提供普通可见文字、无障碍名称和折叠提示。每一行通过 `usePanelInfo` 读取自己的选中态；DOM 焦点移到搜索框或目录选择器时，显示的面板及其列表项选中态不变。没有注册项时，列表及其间距均不渲染。产品随附的组合不注册示例面板。

### 折叠行为

实时收起时，展开内容在当前宽度淡出，上方控件共用同一段透明度渐变，并向左平移进入 56px 轨道，由布局的栏滑动结束整段动画。页面初始即为收起状态时会静态渲染轨道；减少动态效果模式会禁用两段过渡。固定在底部的 `sidebar.settings` 控件共用相同的透明度渐变时序，但不发生横向位移。

### 滚动条

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把滚动条间接层重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（ui-workspace），所以显示滑块不会引起重排。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳是纯组合：`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 与 `useWorkspaces` 钩子、已声明的品牌、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的导航回调。面板入口及其可选标题使用相同的组合方式。面板元数据由列表注册和 locale 变化派生；选中态属于布局存储。

### slot 纪律

声明感知的 `slots.inject()` 让替换包无论先于还是后于侧边栏激活都能生效。页脚承载 `sidebar.settings` 席位：侧边栏只渲染固定在底部的布局 slot，并共享其栏状态（`wide`）。`/client` 导出接口只包含插件主体（`apply`/`inject`）及约定类型；SidebarRoot、行组件与树派生仍由 slot 注册封装在包内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖填充外壳席位的各个界面与组合模型。

- [ui-workspace](../ui-workspace/README.zh.md)——渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器。
- [ui-settings](../ui-settings/README.zh.md)——在 `sidebar.settings` 注册触发行与设置面板的设置领域底座。
- [ui-layout](../ui-layout/README.zh.md)——折叠所使用轨道与栏状态的布局 owner。
- [ui-theme](../ui-theme/README.zh.md)——外壳所重新绑定的滚动条 token 间接层。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——席位背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义外壳拥有什么、其占位方拥有什么；它们是当前包约束。

- **Session 状态点渲染由 ui-workspace 持有**：本外壳没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 ui-workspace，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。面板元数据是 Slot 注册表与 locale 的只读呈现投影，没有独立写入 API。注册表负责条目身份与资源释放；本包的装配测试在注册和 locale 通知完成后断言该投影。外壳没有需要与这些来源协调的独立导航状态。
