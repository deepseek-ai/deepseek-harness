---
description: "dsh Web 客户端的设置外壳、无特定功能归属文案与持久化产品引导命名空间：「通用」分区、触发控件界面框架与引导账本投影。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-general

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-general` 是 dsh Web 客户端的设置外壳：Settings 面板从侧边栏底部的控件打开，该控件旁的连接故障指示器提供即时恢复操作；导航由各功能贡献的分区构建；首次运行的用户一次只走一个引导步骤。它还注册设置页面上所有不属于单一功能的内容：触发器、标题栏与关闭控件界面框架、「本地配置文件」操作、「通用」分区及其 `settings.general.item` slot，以及 `settings` 字典。归具体功能所有的行（「权限」、「语言」、「外观」）、分区（「模型」）与条件式首次使用引导步骤仍由各自的功能包提供；外壳本身不自带任何引导文案。

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

用户通过侧边栏底部的 Settings 控件进入外壳；功能插件通过本外壳所投影的 slot 账本贡献自己的页面与引导步骤。Host 连接失败后，浅黄色的**连接异常**操作会出现在 Settings 右侧；自动恢复期间显示**连接中**，其后一至三个点每 500ms 前进一次。鼠标悬浮或键盘聚焦任一黄色状态时，只有文案变为**立即重连**，背景保持不变；按压反馈留在黄色色阶内，选中后立即从 retry 1 开始。恢复后该区域变为浅绿色的**连接成功**，驻留 2 秒再消失。所有可见状态的文字都左对齐，且图标、文字起点、高度和宽度保持固定。首次启动与未曾中断的健康连接保持静默。外壳渲染模态面板、由 `settings.section` 条目构建的导航，以及每次只挂载一个的引导步骤。

### 「通用」分区

「通用」分区承载由功能包注册进 `settings.general.item` 的行——它没有内置行。功能插件拥有行文案与行为；外壳只提供分区及其 slot。例如「外观」行位于 ui-theme。

### 打开配置文件

在回环浏览器上，只有当宿主确认可准备好一份由提供方持有的本地文档时，外壳才渲染**打开配置文件**。该操作会在原生文本编辑器中打开该文档（macOS 上绕过浏览器文件关联）。远程浏览器从不注册该操作，也从不发起这项特权设置读取。

### 引导步骤

引导账本按升序投影，每次只挂载一个步骤。注册方持有持久化完成状态、能力就绪状态、文案、变更操作与可见包装，因此独立注册的流程无法堆叠，外壳也不会成为第二个配置事实来源。可见步骤自行持有弹窗框架与应用根节点 `inert` 生命周期。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳拥有界面框架与投影；每段内容与文案都属于某个注册方。

### 账本投影

导航是 `settings.section` 账本的投影；导航 label 可以是跟随语言的 thunk，经 `resolveSlotLabel` 解析，并在分区账本更新或 locale revision 变化时重新渲染（`ctx.get('locale')` 可选读取，无硬 locale 依赖）。引导账本按升序投影；当前注册方会收到该条目的 id、`complete()` 与 `openSection(id)` 回调，完成或跳过当前步骤后，所有权转交给下一项。

### 连接恢复

外壳是明确的恢复功能消费方，因此直接注入 Connection，而不把生命周期控制放进 `ctx.remote`。它的私有 hooks compartment 绑定 `ctx.connection.state`，组件只接收选出的状态与调用 `ctx.connection.reconnect()` 的注入回调。`ConnectionIndicator` 拥有内联展示并从 `settings` locale namespace 接收全部可见与无障碍文案；2 秒恢复状态计时器归外壳所有。

### 文档可用性

在 loopback 页面上，Client 通过 `settings/describe` 加载提供方的 `hasDocument` 能力，且只有在 Host 确认可准备好一份由提供方持有的本地文档时才渲染配置文件操作。该操作调用无路径参数且经浏览器认证的 `settings/openSettingsDocument` Remote；Host 会再次解析提供方路径、在文档缺失时将其创建出来，并交给原生文本编辑器（macOS 上使用 `open -t`，绕过浏览器文件关联；Linux 和 Windows 上使用桌面文件关联；WSL 上经 `wslpath -w` 转换后使用 Windows 文件关联）。打开失败时该操作仍可使用，并渲染本地化错误。临时读取失败或 Host 拓扑变化后，重新打开对话框或重新连接会刷新可用性。非 loopback 页面保留 Client 策略，不提供该原生操作及其 settings 读取。

### 宿主端

宿主端在用户设置 seam 中注册 `ui-onboarding`。`ui-settings-models` 提供的欢迎步骤通过既有公开 settings 边界读写其中的 `welcomeNoticeVersion`；外壳本身仍不持有产品策略。

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

- **「通用」分区没有内置行**：每一行仅在其所属功能插件挂载时出现；外壳单独无法填满该分区。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。settings seam 校验并发布持久 onboarding section，slot core 会拒绝冲突；本地 document action 由 store 与组件测试覆盖。
