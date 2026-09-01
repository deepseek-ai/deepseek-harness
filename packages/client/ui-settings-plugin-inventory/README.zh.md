---
description: "dsh Web 客户端设置中按作用域分组的只读插件清单标签页：Agent 预设组合在前，全局平面收在折叠分组里，搜索跨两组。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-plugin-inventory` 向 Web 设置的「插件」分区贡献只读的**插件列表**标签页。该标签页在首次被选择时懒调用 `ctx.remote.pluginInventory.list()`，并把清单分成两个可折叠分组渲染。Agent 预设组在前、默认展开：一个只改显示的切换器胶囊覆盖 roster、初始停在默认预设，每个组合行是一张紧凑折叠卡片，携带其启停状态——含宿主无法求值的 disabled 门对应的 `conditional`——出处事实收在折叠里。全局组随后且默认收起，组头带条目计数与失败计数；展开后失败行浮在最前，全局停用但被至少一个预设启用的条目就地标记为预设提供——详情列出启用它的预设——而不是读作单纯的已停用。搜索同时过滤两组、强制撑开收起的分组，并指出未选中预设里的匹配。加载、空结果、无匹配与通用失败状态只属于已挂载组件，读取失败后可以重试，且不会暴露传输细节；没有 roster 时标签页只渲染全局平面并保持展开。

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

打开设置中的「插件」分区并选择**插件列表**标签页，即可查看宿主的插件清单。插件激活期间不会读取 Remote——首次选择该标签页时才挂载组件，并通过 `api-remotes` 懒调用 `ctx.remote.pluginInventory.list()`。

### 阅读卡片

每张收起的卡片使用模块短名称作为标题，并以小标签表示启停状态；已启用的条目还会显示彩色根 fiber 状态圆点。展开卡片后会显示声明的条目 id、完整模块标识与状态事实：预设行说明它来自哪个预设、组合存活时的运行状态，以及它携带的禁用条件；被预设提供的全局行说明它由 Agent 预设按会话提供、列出启用它的预设，并提供跳转到预设组的入口。预设名经共享的 `presetDisplayText` 纯函数（`dsh-agent-presets/display`）叠在 [`ui-agent-preset`](../ui-agent-preset/README.zh.md) 的字典上解析：内置预设走当前语言，用户自建预设保留自己的元数据，因此英文界面不会回显预设文件里的中文名。搜索按模块名称与条目 id 过滤两组。

### 预设切换器

切换器与通用设置各行使用同一种「选择胶囊 + 菜单」控件。它列出 roster 的每个预设——默认项带后缀、坏预设带标记——并且只改变列表显示什么：它不写任何设置，选中坏预设时在行的位置展示 discovery 报告的原因。选默认预设或某个会话的预设仍在原处：Agent 预设分区与新会话页。

### 重试失败的读取

读取失败会在标签页内渲染通用失败状态；重试会重新执行懒 `list()` 调用，且不会暴露传输细节。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该标签页是宿主拥有快照的只读投影；插件激活期间不执行任何 Remote 读取，首次选择时才取快照。

### 注册

浏览器插件注册一个 id 为 `all` 的本地化 `settings.plugins.tab` 贡献；「插件」分区拥有导航入口与标签栏。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

### 渲染

行 key 按作用域限定（`global:`、`preset:<id>:<index>`），因此同一模块出现在两个作用域时保持各自的展开状态；条目 id 只在行声明了它时作为详情展示，代码不按字符串形状对它分类。预设提供标记在客户端推导：一个全局条目在全局被停用、且至少一个预设行对同一模块标识实际启用时才携带它，因此被所有预设关掉（或仅条件声明）的模块保持单纯的已停用，而不是夸大提供关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置分区、Remote 调用与宿主侧投影。

- [ui-settings-plugins](../ui-settings-plugins/README.zh.md)——本标签页注册进的「插件」分区。
- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.plugins.tab` 的领域底座。
- [api-remotes](../../api/remotes/README.zh.md)——`pluginInventory.list()` 背后的 Remote BFF 表面。
- [plugin-inventory](../../host/plugin-inventory/README.zh.md)——本标签页所渲染的宿主侧只读 Loader 投影。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端清单投影，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义清单视图的新鲜度与触达范围；它们是当前包约束。

- **每次 Settings 挂载或重试只读取一份快照**：标签页不订阅 Loader 变化，也不会在重连后自动重新读取；切换标签页会保留当前快照，重新打开 Settings 则会取得新快照。
- **两个平面都只读**：标签页展示全局与预设的启停状态但都不修改；写回自定义预设组合文件的启停控件是刻意留作后续的工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只持有一个只读 Settings contribution。
