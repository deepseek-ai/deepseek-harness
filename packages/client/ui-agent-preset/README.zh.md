---
description: "Web GUI 的 agent（智能体） preset 界面：选择器可见性与默认设置、新建会话 chip、会话标题标签与 preset 名单管理分区；供 agent 组装的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

[English](README.md) | 中文

## 概述

使用本包可以为新的 Web GUI 会话选择 agent preset、在会话标题中查看当前 preset，并在设置中管理可用 preset。Agent 模式选择器默认显示；设置可以隐藏它，而不会改变运行中或历史会话。preset 在会话创建时即固定，因此更改选择或默认值只影响此后创建的会话。如果部署未提供任何 preset，这些控件保持隐藏，每个会话都使用宿主组装。

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

与设置和对话包一起挂载本插件；管理分区随后显示一个默认开启的可见性开关。关闭期间，新建会话 chip 不出现，宿主会依据部署默认值（随附 Web bundle 中为 `standard`）组装未指名会话。开启时会恢复已保存的用户默认值；尚未保存时则使用部署默认值；该默认值会同时带到当前空白任务上。chip 中的选择本身只为下一个空白会话暂存一次。再次关闭选择器会以同样方式把当前空白任务带回部署默认值，并丢弃尚未使用的暂存选择；已开始及历史会话的标签、组装与已记录历史均保持不变。

### 管理名单

设置分区把名单呈现为卡片：复制对话框是创建 preset 的唯一入口——浏览器不编辑任何组装文本——每张自定义卡片都保留一个打开 preset 自身文件的位置动作。可见性开关只决定已保存的用户默认值是否生效：宿主在隐藏期间使用部署默认值，再次显示选择器时恢复已保存的默认值。选择器开启期间，选择健康且非默认的卡片会为后续会话写入新的用户默认值；如果当前新任务页已经复用一个空白会话，这次在设置中的明确选择也会通过既有选择链路把同一 preset 带到这个精确的空白会话。已开始及历史会话保持不变。保存期间开关会被禁用；写入失败时，界面保留先前的偏好并显示错误。隐藏选择器会禁用默认值选择与 Creator 启动，但名单查看、复制、位置和删除仍然可用。删除会移除 preset 目录，而已据其组装的会话继续运行。随附 preset 在只读查看器中打开，不提供位置或删除。名单行携带 `broken` 时渲染为标记卡片，其主体与复制均被禁用，因为损坏 preset 的副本只是另一个损坏 preset；损坏的自定义行保留位置与删除动作，以便修复文件、清掉幽灵目录。卡片正面仍显示 preset 自己的描述——在选择器里，一个包说明符不足以让人采取行动——宿主给出的原因作为工具提示附在徽标上，另有一个视觉隐藏的 alert 将该原因传达给辅助技术，而被禁用的卡片主体无法做到这一点。

### 对话式入口

名单携带自指的 `cordis` preset 时，其虚线添加卡在选择器开启前保持禁用。开启后，它会暂存 `cordis` 并启动新会话——分区关闭设置面板，新建会话 chip 自己的应用器负责组装工作区流程产出的空白会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

设置分区通过现有的 `settings.update` 写入宿主的 `agent-presets` 命名空间。可见性开关只设置 `modeSelectionEnabled`；仅当选择器显示时，设为默认动作才会写入 `default`。两种写入之后，都由宿主名单给出当前生效的默认值，再由 chip controller 的 `agentPresets/select` 链路把它带到同一个仍为空白的会话；这些界面只使用这一条会话修改 API。展示选项与宿主的生效可见性来自 `agentPresets/list`——名单本身已标记宿主当前生效的默认值并携带 `modeSelectionEnabled`，因此非 loopback 的只读客户端无需内省 settings schema 也能保持一致。设置分区首次加载时查询 `settings.canOpenAgentPresetDirectory()`，并把结果与名单合并；查询失败只会移除原生打开动作。新建会话 chip 仅在 `modeSelectionEnabled` 为 `true` 时渲染；隐藏它会丢弃待处理的暂存选择及本地菜单或失败横幅状态，而标题标签保持注册并读取每个会话已记录的 preset。暂存值在会话到达时应用（既覆盖工作区连接新建的会话，也覆盖它复用的空白会话），被拒绝时丢弃。系统会通过 composer 列上方的瞬时横幅提示拒绝结果，因为 chip 的标签此时已经恢复原值，而被宿主拒绝挂载的 preset 正是发现过程报告为健康的那一种——它的名单卡片上没有任何原因可供回头查看。只有用户刚做出的选择会触发提示；会话成为当前会话时触发的应用器不会。[`dsh-client-connection`](../connection/README.zh.md) 使用同一浏览器会话认证 `agentPresets/read`、`agentPresets/copy`、`settings/openAgentPresetDirectory`、`agentPresets/deletePreset`、`agentPresets/list` 及其他所有宿主 API 方法。组装仍会指明一个会话所运行的插件，因此读取属于侦察，而复制、删除与设置模块拥有的目录打开操作负责管理名单并驱动宿主桌面。分区在自身操作、`settings/document-updated` 与 `connection/reset` 时重读，因为组装文件在浏览器之外编辑，协议链路不会通知文件变动。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 preset 界面无法满足需求时，请阅读以下页面。它们从浏览器界面延伸至 preset 领域与组装模型。

- [dsh-agent-presets](../../preset/agent-presets/README.zh.md)——这些界面读取并管理的宿主名单与组装。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 chip 与标签填充的首屏与会话头部槽位。
- [ui-settings](../ui-settings/README.zh.md)——承载名单分区的设置外壳。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由此后会话据以组装的 preset；它所选择的 preset 拥有所有面向模型的效果。

#### KV Cache 影响

没有直接的失效影响。更改选择器可见性或默认值不会改变运行中会话的组装或前缀，也不会改变历史会话已记录的 preset；此后创建的会话依据它自己的组装建立自己的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前 preset 界面。它们是当前包约束，不是通用组装对比或任务积压。

- **没有元数据的 preset 按 id 列出**——展示文本是可选的，未取名的副本刻意回退到目录名，而不是与其来源呈现得一模一样。解析本身使用 [`dsh-agent-presets/display`](../../preset/agent-presets/README.zh.md) 共享的 `presetDisplayText` 解析逻辑，设置的插件列表把它内联在本插件的字典之上，按当前语言显示随附 preset 的名称，同时不翻译用户自建的元数据。
- **展示的路径是文本，不是链接**——宿主没有桌面打开器时，卡片显示目录供手工复制；浏览器自身无法打开宿主文件系统上的位置。
- **组装编辑对页面不可见**——文件在浏览器之外编辑，协议链路不广播文件变动，因此名单只在自身操作、`settings/document-updated` 与 `connection/reset` 时重读，而非每次磁盘编辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是浏览器侧界面插件，Node 侧不拥有事件流或可变运行时数据；名单与设置写入属于宿主约定。
