---
description: "通过作用域交互路径响应 Host 权限请求的浏览器批准界面。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

[English](README.md) | 中文

## 概述

基于 Agent-scoped Remote Event waterfall 的浏览器审批界面。插件通过 `ctx.uiSession` 发布每个待处理请求、接管 Conversation composer、按需渲染关联的 Tool 详情，并将用户决定返回给等待中的 Host 请求。当浏览器必须为等待中的 Host 操作收集批准时，请使用它。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

聚焦审批详情区域后，Enter 批准，Esc 拒绝。插件挂载期间，这两个按键不能分配给可编辑快捷键。聚焦“拒绝”按钮后，Enter 保留按钮原生拒绝操作。输入控件与输入法候选保留各自的按键。键盘和指针操作共用同一待处理请求锁；已撤销或替换的请求不能再次作答，较早请求的失败也不会解锁替代请求。

提供“始终允许”时，将它显示为高亮主按钮；否则高亮当前请求的允许按钮。在详情区域按 Enter 始终授予有限范围的许可：工具审批为单次，CUA 为当前会话。持久授权需要显式操作“始终允许”按钮。快捷键说明使用“允许”，具体范围由调用方提供。

<a id="model-experience"></a>
## 模型体验

无，因为本包只在浏览器中呈现审批请求，不注册任何面向模型的内容。

#### KV Cache 影响

无；审批请求和响应的呈现不会改变模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 共用的 `conversation.approval.card` Factory 展示拒绝、允许和可选的始终允许操作，授权范围、对象信息和回答回调由调用方提供。工具审批保留原来的两种选择。应用授权可以复用卡片，同时保留独立的授权规则。传入对象信息时，内容左对齐，按钮允许换行；未传入时沿用继承的对齐方式和单排按钮。图标和名称用于识别对象，身份校验和授权保存由调用方负责。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
