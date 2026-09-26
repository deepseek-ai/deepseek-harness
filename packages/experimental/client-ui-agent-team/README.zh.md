---
description: "使用并排查实验性 Web Agent Teams roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户检查当前 roster、查看共享任务板并导航到 teammate 会话。它从共享 Session store 读取 Lead Session 的 `agentTeam` 投影，Host 投影 frame 使其保持最新而无需刷新控件，并让普通 child history 导航继续使用稳定的 addressed-subagent 路径。通过公开发布的实验性 Agent Teams bundle 选择本包。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

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

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

面板从共享 Session store 展示 Lead Session 的 roster 与任务板。面板保持打开时，任务和成员更新会直接出现。打开面板不发起投影请求。会话或 Session 列表正在加载时，面板显示加载提示；加载结束后仍无 Team 值时，显示不可用提示。

Roster 行展示持久名称与阶段。provisioning 和 running 成员使用共享 ongoing loading，inactive 成员使用人物图标，failed 成员使用 error 红点。实时 Session 状态提供运行活动；共享 `modelSelection` 投影在可用时提供模型。当前会话带有“当前会话”标签且不可选择。在 teammate 会话中选择 Lead 会直接打开 Lead Session。选择 active teammate 会打开其普通 continuable 子会话地址。Host 在打开历史时校验 parent、child 与 mode；后续人类提示词使用同一 addressed-subagent 会话。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板展示任务标识、负责人、依赖、就绪状态、提示性写入范围与重叠警告。超过两行的描述提供展开按钮。分区标题显示成员与任务数量；空任务板显示简短描述，只有一名成员且无任务时采用单列面板。Team agent 通过工具创建和更新任务；面板不提供任务修改控件。当投影报告某条持久 Team 记录被拒绝时，面板在最后有效的 roster 与任务上方显示该失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot；它不挂载任何 Remote namespace。Dispose plugin fiber 会移除这两项 registration。

面板渲染在会话容器外，并保持在视口范围内。成员卡片在静止、选中和悬停状态下均使用共享 elevation 描边绘制轮廓。悬停触发按钮 150ms 后打开面板；指针离开触发按钮和面板后，经过 120ms 宽限关闭。点击触发按钮会固定面板并将焦点移入其中。点击外部或按 Escape 可关闭面板；仅当焦点原本位于面板内时，Escape 才将焦点返回触发按钮。页头较窄时触发按钮折叠为图标，只响应点击打开。组件从 `useSessions`、`useSessionStatus` 与 `useSession` 座位派生每一行：Lead 身份来自当前 Session 的 subagent address，Team 视图来自 `projectionsBySession[lead].values.agentTeam`，成员活动来自 Session 状态并以列表摘要为后备，model 来自 `projectionsBySession[member].values.modelSelection.next`。每个 roster 行只选择自己的运行状态。唯一的注入回调通过当前与目标 Session 的 id 打开 roster Session。切换会话会关闭面板并清除导航失败。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | 由投影派生的 roster 与任务板及面板交互状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与投影行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 mailbox timeline**——投影视图只承载 roster 与任务；不显示 peer 消息。
- **晚启用插件** — 在已经打开的会话中启用 Agent Teams 后，需要刷新页面才能接收其 Team 投影。
- **模型可用性** — 仅当共享 store 包含该成员的持久选择或请求时才显示模型。冷缓存中缺少的值会保持缺失，直到正常 Session 加载或实时更新提供它们。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Host 投影是权威来源，本包只持有一个可释放的 slot 注册。
