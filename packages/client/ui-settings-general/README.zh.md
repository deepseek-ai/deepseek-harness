---
description: "dsh Web 客户端的设置外壳、无特定功能归属文案与持久化产品引导命名空间：「通用」分区、触发控件界面框架与引导账本投影。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-general

[English](README.md) | 中文

## 概述

使用本包可为 dsh Web 客户端提供 Settings 面板、连接恢复控件、由功能包贡献的导航，以及依次进行的首次运行引导。用户可以从侧边栏打开面板、立即重试失败的连接，并在宿主为回环浏览器提供本地配置文件时访问该文件。各功能包提供自己的设置行、分区和引导步骤；本包提供共享的界面展示和代码工作工具开关，但不添加引导文案。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

设置面板采用各页面共享的 800 × 800 布局，并受视口大小约束。较长的页面在内容栏内部滚动；账号入口使用账号图标。面板挂载在 `#root` 之外而不是其内部，这样在文档序上更靠后的 chrome 行所声明的 macOS 窗口拖拽区不会吞掉它的控件。

<a id="use-this-package"></a>
## 使用本包

用户通过侧边栏底部的 Settings 控件进入外壳；功能插件通过本外壳所投影的 slot 账本贡献自己的页面与引导步骤。在展开侧边栏和收起轨道中，该控件都会把本地化的 Settings 文案作为其可访问名称。Settings 右侧浅黄色的**连接异常**操作表示浏览器离线暂停；其常驻重试图形与中文文案「连接异常，刷新重试」都指明重试动作。每次恢复尝试都显示共享 ongoing loading 加**重新连接中**，其后一至三个点每 500ms 前进一次，且每次尝试至少可见 800ms，短暂重试不会闪动。选中任一黄色状态都会立即发起重试；按压反馈留在黄色色阶内。恢复后该区域变为浅绿色的**连接成功**，从绿色药丸可见起驻留 2 秒再消失。药丸出现时淡入、移除时以 150ms 淡出，宽度随当前文案自适应。首次启动与未曾中断的健康连接保持静默。外壳渲染模态面板、由 `settings.section` 条目构建的导航，以及每次只挂载一个的引导步骤。

设置面板使用[框架共享的浮层起点](../ui-layout/README.zh.md#window-chrome-seat)，视口边距至少为 24px。其遮罩不绘制 Windows 顶栏区域，覆盖整个视口的模态层仍阻挡背景点击。

当分区导航超出面板可用高度时，列表独立于设置内容滚动，并保持「设置」标题固定。

在 Desktop 中，账户行更新控件显示可用版本、进度、验证、就绪和持久重试反馈。它与连接指示器共用 28px 高度、8px 圆角、14px 图标占位、4px 图文间距，以及 12px 中等字重文字和 18px 行高；更新状态的边框、填充和文字颜色独立定义。重试文字及其圆点与其他更新文案使用相同的品牌蓝色；数字下载进度不带省略号。预加载仅传递语义化阶段、版本、进度和失败类别；组件从当前 `settings` locale 解析全部可见与无障碍文案，并在应用内语言变化后同步更新。选择可用更新即开始下载；安装需要独立的壳拥有的确认。侧栏收起时，其顶部展开按钮以品牌蓝色圆点显示相同状态，包括失败状态。连接反馈通常优先展示，但壳报告正在安装时，预期的后端断开不能遮盖更新状态；失败后恢复连接反馈。两个控件共用一次载体订阅；浏览器代码不能选择安装包或授权安装。[Desktop 更新](../../../apps/desktop/README.zh.md)负责发布流程。检查中、校验中和准备重启状态的悬浮提示只显示已提供的版本号；没有版本号时保留状态文案。桌面更新提示完整保留版本号及预发布后缀，不额外添加 v 或 V；错误提示与桌面升级弹窗保持一致。

设置的可见状态和分区选择由 shell owner store 保存。外壳将设置命令的有效绑定传给入口贡献，用于菜单键帽和 `aria-keyshortcuts`；回退按钮使用相同绑定提供悬停、键盘聚焦提示和 `aria-keyshortcuts`。设置位于最前方或没有模态弹窗时，设置命令（Desktop 为 `Mod+,`，Windows/macOS Web 为 `Mod+Alt+,`）切换设置弹窗的开关；侧栏控件打开同一弹窗。快捷键速查或其他模态弹窗位于前方时，该命令不能打开或关闭设置。长按产生的重复按键不执行操作。初始焦点落在导航中选中的分区；没有可用分区时落在标题上，均不绘制焦点外轮廓线。Tab 和方向键导航保留可见焦点提示。`Mod+/` 可在设置上方打开快捷键速查；`Escape` 关闭最上层弹窗，焦点返回触发该弹窗的控件。通过快捷键、Esc 或鼠标关闭后的回焦均不绘制外轮廓线。

### 「通用」分区

Web 与桌面端的通用设置底部显示当前发布版本，使用构建注入的 `DSH_CLIENT_VERSION` 元数据和当前语言。缺少版本元数据的局部构建不显示该行。

代码工作工具开关控制 [ui-settings](../ui-settings/README.zh.md#use-this-package) 定义的共享偏好 `ui-settings.enabled`。Web 和桌面端均提供此开关，立即跟随已接受的变更，并在写入完成前禁用重复输入。写入失败时显示本地化的重试提示。

「通用」分区承载内置的代码工作工具行与当前版本行，以及功能包注册进 `settings.general.item` 的行。每个注册方拥有自己的行文案与行为。例如「外观」行位于 ui-theme。

### 打开配置文件

在回环浏览器上，只有当宿主确认可准备好一份由提供方持有的本地文档时，外壳才渲染**打开配置文件**。该操作会在原生文本编辑器中打开该文档（macOS 上绕过浏览器文件关联）。远程浏览器从不注册该操作，也从不发起这项特权设置读取。

### 引导步骤

引导账本按升序投影，每次只挂载一个步骤。注册方持有持久化完成状态、能力就绪状态、文案、变更操作与可见包装，因此独立注册的流程无法堆叠，外壳也不会成为第二个配置事实来源。可见步骤自行持有弹窗框架与应用根节点 `inert` 生命周期。

-----

<a id="understand-the-implementation"></a>
## 理解实现

外壳声明 settings.launcher，供账号功能提供侧边栏菜单，并以设置按钮作为回退。入口接收 settingsOpen，其 false→true 边沿代表一次进入设置页，因此注册方在每次进入时执行一次，而不是在同一次打开中的每次重渲染执行。关闭对话框后，焦点返回当前入口。

<details>
<summary>实现细节——点击展开</summary>

外壳拥有界面框架与投影，并提供代码工作工具行与当前版本行；功能注册方拥有其余内容与文案。

### 账本投影

导航是 `settings.section` 账本的投影；导航 label 可以是跟随语言的 thunk，经 `resolveSlotLabel` 解析，并在分区账本更新或 locale revision 变化时重新渲染（`ctx.get('locale')` 可选读取，无硬 locale 依赖）。引导账本按升序投影；当前注册方会收到该条目的 id、`complete()` 与 `openSection(id)` 回调，完成或跳过当前步骤后，所有权转交给下一项。

### 连接恢复

外壳是明确的恢复功能消费方，因此直接注入 Connection，而不把生命周期控制放进 `ctx.remote`。它的私有 hooks compartment 绑定 `ctx.connection.state`，组件只接收选出的状态与调用 `ctx.connection.reconnect()` 的注入回调。`ConnectionIndicator` 拥有内联展示并从 `settings` locale namespace 接收全部可见与无障碍文案；连接中状态的 800ms 最短可见驻留与 2 秒恢复确认计时器归外壳所有；恢复计时从驻留结束、恢复药丸实际可见时开始。

### 文档可用性

在 loopback 页面上，Client 通过 `settings/describe` 加载提供方的 `hasDocument` 能力，且只有在 Host 确认可准备好一份由提供方持有的本地文档时才渲染**打开配置文件**操作。该操作调用无路径参数且经浏览器认证的 `settings/openSettingsDocument` Remote；Host 会再次解析提供方路径、在文档缺失时将其创建出来，并交给原生文本编辑器（macOS 上使用 `open -t`，绕过浏览器文件关联；Linux 和 Windows 上使用桌面文件关联；WSL 上经 `wslpath -w` 转换后使用 Windows 文件关联）。打开失败时该操作仍可使用，并渲染本地化错误。临时读取失败或 Host 拓扑变化后，重新打开对话框或重新连接会刷新可用性。非 loopback 页面保留 Client 策略，不提供该原生操作及其 settings 读取。

### 宿主端

宿主端在 `ui-settings-general` 条目的 Config 中把 `welcomeNoticeVersion` 声明为 volatile 字段。`ui-settings-models` 提供的欢迎步骤通过既有公开 settings 边界读写其中的 `welcomeNoticeVersion`；外壳本身仍不持有产品策略。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置界面家族与组合模型。

- [ui-settings](../ui-settings/README.zh.md)——本外壳所依赖 slot 类型与 scope 服务所在的领域底座。
- [ui-sidebar](../ui-sidebar/README.zh.md)——承载 `sidebar.settings` 席位的侧边栏外壳。
- [ui-settings-models](../ui-settings-models/README.zh.md)——贡献 DeepSeek 引导步骤的功能包。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——账本背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明外壳自身提供什么、功能包必须提供什么；它们是当前包约束。

- **额外的通用设置行需要相应功能插件**：外壳提供代码工作工具与当前版本；功能插件提供其他偏好。
- **Windows 顶栏徽标的气泡仍向右展开**：`DesktopUpdateBadge` 占用顶栏的 `sidebar.toggle.badge` 且请求 `side="right"`，侧栏收起时其气泡会被 Desktop 菜单文字遮挡；侧栏开关与新建会话的气泡则改在顶栏下方展开（#4688）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
