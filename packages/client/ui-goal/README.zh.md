---
description: "Web GUI 的 goal 界面：显示当前目标并支持编辑、暂停、恢复或清除的 composer 上下文条带；供 goal 体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-goal

[English](README.md) | 中文

## 概述

Web GUI 的 goal 界面同时显示持久 goal 状态及当前的进程本地激活状态，供用户编辑、暂停、恢复或清除 goal；被拒绝的变更所产生的错误会内联显示。它把持久的 `/goal` 运行显示为 `Command input` 气泡，让用户或模型发出的命令在重新加载后仍然可见。goal 创建仍不归本包。除 `minimal` 外，随附的 Web preset 都会向 agent（智能体）提供 `/goal`。

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

与 `ui-conversation` 及 goal 领域包一起挂载本插件；只要会话存在目标，条带就会作为 composer 上下文堆栈的第二张卡片出现（位于 Todo 之后、Queue 之前）。已 armed 的 active goal 提供暂停动作；active-but-disarmed 或 paused 的 goal 提供恢复；编辑重写目标文本；清除移除目标，并在投影追上之前抑制条带。

### 指令输入气泡

每条持久的 `/goal` 运行都投影为一个右对齐的用户样式气泡，标签为 `Command input`（或 `指令输入`），渲染在通用命令结果行之前；开头的 `/goal` token 经 ui-primitives 的 `projectUserText` 以等宽代码字体渲染为指令引用 chip，目标文本保持正文字体。它不含时间戳、复制或分支操作，重新加载时会依据运行记录重建。

### 失败

被拒绝的变更会把 Remote 错误内联呈现到条带上；加载中、无目标、已完成与成功清除的目标一律不渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

持久 goal 经 `useProjection('goal')` 到达（由历史尾页播种、`session/projection` 帧更新）。注入面携带注册方私有的激活钩子源与四个变更动词。该源仅在框架钩子观察它时启动；启动后会读取 `ctx.remote.goals.get`、订阅 `goal/activation-changed`，并在 running 状态或连接重置时刷新。实时事件 epoch 会让在途读取失效，因此较旧的 HTTP 响应不能覆盖较新的 activation 变化；running 刷新会保留最后一次已知 activation，直到读取完成。条带不持有领域存储或跨插件缓存。每个变更在调用时从会话当前投影值读取 CAS ref，比较并交换（RPC 的 CAS）就是陈旧性护栏。由于 React 的 pending 渲染无法拦住同一帧内的点击，条带会同步为变更建立 single-flight 防护。指令输入投影是独立的 Conversation Definition，在通用命令结果 Node 之前构建 `command-input` Chat Node；它绝不创建 `user/message` 或模型轮次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 goal 界面不够用时阅读以下页面。它们从浏览器条带进入 goal 领域与它所填充的 slot。

- [dsh-goal](../../goal/goal/README.zh.md)——本界面读取并变更的 goal 领域、投影与 `/goal` 命令。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 `conversation.input.dock` slot 并拥有 composer。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：条带路由 `goals/edit`、`goals/pause`、`goals/resume` 与 `goals/clear` 变更；宿主 GoalService 拥有这些变更排队的模型可见 goal 上下文消息。

#### KV Cache 影响

除非已排队的 goal 上下文获准，否则没有影响。获准的上下文会像其他消息一样扩展历史尾部；准入前被丢弃的插入项不会影响缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前 goal 界面。它们是当前包约束，不是 goal 领域对比或任务积压。

- **Host 状态与 preset 无关**——把活跃会话切换到 `minimal` 后，Host 拥有的 goal 仍会保留。`/goal` 与 goal 工具会消失，但该条带仍可编辑、暂停、恢复或清除 goal。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 GoalBar dock，其释放已由 HMR（热模块替换）安全性用例证明；持久状态来自 goal projection，进程本地 activation 来自入口私有钩子源，且该源只在框架钩子观察期间订阅。
