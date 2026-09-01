---
description: "Web GUI 的 agent preset 表面：默认 preset 设置、新建会话 chip、会话标题标签与 preset 名单管理分区；供 agent 组装的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的 agent preset 表面：新建会话界面的一枚 chip，选择下一个会话的 preset；会话标题旁的一个只读标签；以及一个设置分区，用于管理名单——复制、删除、默认值，以及通往 preset 自身文件的入口。会话的 preset 在创建时即固定，因此选择作用于此后开启的会话，运行中的会话保持它们开始时的组装；默认 preset 在能看到名单的设置分区里编辑，通用设置不再为同一字段保留重复控件。当部署未组装任何 preset 时，三个表面都不渲染任何内容，每个会话共用宿主组装。

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

与设置与对话包一起挂载本插件；preset 表面随即出现在各自槽位渲染之处。新建会话 chip 以部署默认值打开并暂存一个选择，落到下一个空白会话上；暂存一经使用即被清空，因此再下一个新会话重新以默认值打开。

### 管理名单

设置分区把名单呈现为卡片：复制对话框是创建 preset 的唯一入口——浏览器不编辑任何组装文本——每张自定义卡片都保留一个打开 preset 自身文件的位置动作。默认值可在任一表面设置；删除会移除 preset 目录，而已据其组装的会话继续运行。随附 preset 在只读查看器中打开，不提供位置或删除。名单行携带 `broken` 时渲染为标记卡片，其主体与复制均被禁用，因为损坏 preset 的副本只是另一个损坏 preset；损坏的自定义行保留位置与删除动作，以便修复文件、清掉幽灵目录。卡片正面仍显示 preset 自己的描述——在选择器里，一个包说明符不足以让人采取行动——宿主给出的原因作为提示条挂在徽标上，另有一个视觉隐藏的 alert 把它送达辅助技术，而被禁用的卡片主体做不到这一点。

### 对话式入口

名单携带自指的 `cordis` preset 时，一张虚线添加卡会暂存它并开启新会话——分区关闭设置面板，新建会话 chip 自己的应用器负责组装工作区流程产出的空白会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

展示选项来自同一次 `agentPresets/list` 调用——名单本身已报告未显式选择的会话会得到哪个 id，因此任何表面都无需对 settings schema 做内省——默认值的写入即设置分区的设为默认动作，目标是 `agent-presets` settings 命名空间的 `default` 字段，也正是 Host 在创建时解析的字段。设置分区首次加载时查询 `settings.canOpenAgentPresetDirectory()`，并把结果与名单合并；查询失败只会移除原生打开动作。新建会话 chip 与标题标签共用一个控制器，因为暂存选择属于流程而非任何单个会话；暂存值在会话到达时应用（既覆盖工作区连接新建的会话，也覆盖它复用的空白会话），被拒绝时丢弃。被拒绝会以一条瞬时横幅在 composer 列上方自报，因为 chip 的标签此时已经弹回，而被 Host 拒绝挂载的 preset 正是发现过程报告为健康的那一种——它的名单卡片上没有任何原因可供回头查看。只有人刚做出的选择会被自报；会话成为当前会话时触发的应用器不会。[`dsh-client-connection`](../connection/README.zh.md) 使用同一浏览器会话认证 `agentPresets/read`、`agentPresets/copy`、`settings/openAgentPresetDirectory`、`agentPresets/deletePreset`、`agentPresets/list` 及其他所有 Host API 方法。组装仍会指明一个会话所运行的插件，因此读取属于侦察，而 copy、delete 与 settings 所有的目录打开操作负责管理名单并驱动 Host 桌面。分区在自身操作、`settings/document-updated` 与 `connection/reset` 时重读，因为组装文件在浏览器之外编辑，线上没有任何机制宣布文件变动。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 preset 面不够用时阅读以下页面。它们从浏览器表面进入 preset 领域与组装模型。

- [dsh-agent-presets](../../preset/agent-presets/README.zh.md)——这些表面读取并管理的宿主名单与组装。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 chip 与标签填充的首屏与会话头部槽位。
- [ui-settings](../ui-settings/README.zh.md)——承载名单分区的设置外壳。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由此后会话据以组装的 preset；它所选择的 preset 拥有所有面向模型的效果。

#### KV Cache 影响

没有直接的失效影响。更改默认值绝不触及运行中会话的前缀；此后创建的会话依据它自己的组装建立自己的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前 preset 表面。它们是当前包约束，不是通用组装对比或任务积压。

- **没有元数据的 preset 按 id 列出**——展示文本是可选的，未取名的副本刻意回退到目录名，而不是与其来源呈现得一模一样。解析本身是 [`dsh-agent-presets/display`](../../preset/agent-presets/README.zh.md) 的共享 `presetDisplayText` 纯函数，设置的插件列表把它内联在本插件的字典之上，按当前语言显示内置预设名，同时不翻译用户自建的元数据。
- **展示的路径是文本，不是链接**——宿主没有桌面打开器时，卡片显示目录供手工复制；浏览器自身无法打开宿主文件系统上的位置。
- **组装编辑对页面不可见**——文件在浏览器之外编辑，线上不广播文件变动，因此名单只在自身操作、`settings/changed` 与 `connection/reset` 时重读，而非每次磁盘编辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是浏览器侧 surface 插件，node half 不拥有事件流或可变运行时数据；roster 与 settings 写入属于 Host 约定。
