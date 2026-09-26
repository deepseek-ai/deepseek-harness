---
description: "历史 Cordis 卡片及进程内 runner 定义的控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cordis

[English](README.md) | 中文

## 概述

`dsh-client-ui-cordis` 渲染历史生成插件卡片，并为进程内定义提供控制面板。用户可以操作程序消费者提供的定义；重启后持久化卡片仍可读取，但不会重建定义。新建 Creator 插件使用 Plugin Manager。

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

将本包与 Host 和 Client runner 组合，可渲染历史工具卡片，并在面板中操作程序注册的定义。新建 agent 插件使用 Plugin Manager；本包不提供模型变更工具。

### 面板显示什么

一个 `sidebar.footer.action` 席位显示角标，计数在跑数加待确认数；点开后列出每个定义及其运行控件。列表从不按会话过滤：当前会话的行置顶成组，其他会话的行仍在下方列出。行来自 host 的当前清单，并在公告改变「有哪些定义」时更新。上一次读取覆盖不到的待审批 run 请求仍然有行，直接用请求自带的会话、标签、用途与标识渲染。每一行显示两个独立事实——host 在跑什么与本页装载了什么——并把它们映射到共享状态标记：idle 使用 idle，客户端装载及正在执行的操作使用 ongoing，运行中的定义使用 done，等待批准使用 warning，失败使用 error。刷新后的页面会先给「装回本页」、再给全局 stop，而纯 host 定义的行如实读作运行中、只给 stop。该行还会把本页最后一次渲染失败就地显示，与装载失败共用同一个位置：一个是「它从来没装上」，另一个是「它装上了、然后抛了」。

### 工具卡片显示什么

准备中的调用显示为带普通 Cordis 图标与标题的不可展开单行。此阶段不派生包身份、不读取其当前清单，也不挂载其业务视图；这些操作需要 start/result props。

`cordis_define` 卡片是一份记录：模型写下的 name 与 purpose、它写的源码，以及该定义是否在跑——没有开关、没有审批，只有一句指向面板的指引。`cordis_run` 卡片显示模式、插件标识、包标识与运行标识、结果，并在包注册了业务视图时经 `tool.view.cordis` slot 提供它。define、run、stop 与 undefine 卡片在失败或中断时继续保留普通业务图标，包括调用回执成功后发生的关联激活失败。所有卡片都渲染会话记录下的 call 与 result，因此回放显示同一张卡。

### 需要规划的边界

定义仅存在于进程内：刷新后的页面手上什么都没有，直到有人再次运行某个包；面板在每次公告时重读清单。审批按设计是框架级的，所以某个标签页里的人可以批准模型为另一个标签页正在看的会话所发起的 run；首个应答生效，其余收敛。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释这些界面背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

这些界面建立在一个规则之上：两者都不把运行态放进组件 state，因为 define 调用结算时卡片会在聊天流里换位置并重挂。事实活在「谁能关闭它、就归谁」的观察量里——浏览器 runner 拥有开放请求、编排结果、本页的 live set 及其渲染失败，而本包拥有自己读来的清单与折叠过的公告。面板做成全局，是因为 run 请求会阻塞模型、且可能点名一个当前没人在看的会话里的定义；审批入口若只存在于那个会话的对话流里，就会在它正阻塞模型的时候恰好不可达。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：slot 注册和 inventory 连接 |
| [`src/client/CordisPanel.tsx`](src/client/CordisPanel.tsx) | 全局面板及其运行控件 |
| [`src/client/CordisDefineRow.tsx`](src/client/CordisDefineRow.tsx) | 只读的 `cordis_define` 卡片 |
| [`src/client/CordisRunRow.tsx`](src/client/CordisRunRow.tsx) | `cordis_run` 卡片及其业务视图席位 |
| [`src/client/CordisActionRow.tsx`](src/client/CordisActionRow.tsx) | `cordis_stop`／`cordis_undefine` 行 |
| [`src/client/card-model.ts`](src/client/card-model.ts) | 从冻结 call/result 切片派生的可回放视图模型 |
| [`src/client/inventory.ts`](src/client/inventory.ts) | 单飞清单读取及其重连处理 |
| [`src/client/status.ts`](src/client/status.ts) | 基于清单与本页 live set 的可见状态读数 |
| [`src/client/slots.ts`](src/client/slots.ts) | 注入面与包自有的 `tool.view.cordis` slot 声明 |
| [`src/client/run-card-index.ts`](src/client/run-card-index.ts) | 每会话「最新合格 `cordis_run` 卡片」索引 |

### 面板如何保持最新

公告（`cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/request-run`、`cordis/request-run-resolved`）触发清单重读，而不是就地打补丁——因为公告不携带标签，而定义可能在两次公告之间出现或消失。读取是单飞的，因此多条公告同时结算不会放大调用次数；连接重置既丢弃在途读取、又为新读取腾出位置，所以重连绝不会发布旧 host 的行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从这些界面逐步进入它们所操作的面，以及其调用被渲染成卡片的工具。

- [Client runner](../cordis-client-runner/README.zh.md)——面板读取并调用的浏览器面。
- [Host runner](../cordis-host-runner/README.zh.md)——面板背后的清单与生命周期动词。
- [工具包](../tool-cordis/README.zh.md)——只读运行时 API 发现。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.dynamicCordisRunner` API 与转发的 `cordis/*` 事件。
- [slots 子系统](../../../docs/subsystems/slots.zh.md)——slot 注册的浏览器 UI 如何归其包所有。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过负责会话 steering 和权限结果的 runner 生命周期操作；本包渲染历史调用与结果，不添加工具或提示段落。

#### KV Cache 影响

没有直接影响：本包负责渲染；runner 发出的 steering 会改变会话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明这些界面何时需要特别小心。它们是当前包约束，不是任务积压。

- **面板无法看到没有广播的注册表变更**——程序侧 `define` 和未运行定义的 `undefine` 可使当前行保持不变，直到下一次 inventory 读取。运行请求会触发读取。
- **只有请求、没有清单的行可应答但不可操作**——它只提供批准与拒绝，因为 run／stop 控件需要那次读取尚未送达的注册表行。
- **行可能消失一次读取的时长**——活动的 orchestrating 臂带会话但刻意不带标签，因此一个已批准、但注册表读取尚未落地的请求，在读取落地前没有行；实践中读取在请求到达时即已触发。
- **渲染失败属于当前页面，且发生在加载回执之后**——面板显示本页的崩溃；Host runner 单独向所属会话发送 steering。
- **某一页的装载失败对其他页不可见**——host 以首个装载回报结算一次 dispatch，因此在另一页确认之后浏览器半才失败的页面，在其他页上仍会读作运行中。
- **任何页面都可以应答任何请求**——审批按设计是框架级的，所以某个标签页里的人可以批准模型为另一个标签页正在看的会话所发起的 run；收窄「谁有权应答」延后。
- **call head 掉出事件窗的卡片会丢掉标签**——define 卡片的 name 与 purpose 取自调用参数，因此会话长到把它们截断时，卡片只能以自己的 call id 自称；面板不受影响，因为 host 清单携带标签。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 keyed toolview，其资源释放已由 HMR 安全性测试证明。本包拥有的唯一可变关系，即 per-definition run-state 观察量，只存在于浏览器进程中，Host 不变式服务无法触及；Node 端不发出任何 Cordis 事件，也不持有任何跨插件状态。
