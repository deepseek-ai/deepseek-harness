---
description: "Cordis 动态插件浏览器面说明，供选择、组合或排查面板、工具卡片与 @pluginId 输入的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cordis

[English](README.md) | 中文

## 概述

`dsh-client-ui-cordis` 给 web 客户端提供动态 Cordis 包的浏览器面：一个覆盖整个框架的面板，操作 host 持有的全部定义；会话里渲染 `cordis_define`、`cordis_run`、`cordis_stop` 与 `cordis_undefine` 调用的工具卡片；以及一个补全本会话已定义插件的 `@pluginId` 输入源。面板做成全局是刻意的——模型驱动的 run 阻塞在人的审批上，而无论当前在看哪个会话，这个审批都必须可达。本包不撰写任何模型可见的内容：它所操作的一切都来自浏览器 runner 与 host 的清单，卡片渲染的是会话已经记录下的 call 与 result 内容。

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

在同时挂载了浏览器 runner 与 host runner 的 web 客户端中组合本包，它会加上面板、工具卡片与 `@` 补全。人便拥有执行完整生命周期所需的一切：批准或拒绝模型的 run 请求、运行、停止或移除任意定义，并在同一行上看到包的实时状态变化。

### 面板显示什么

一个 `sidebar.footer.action` 席位显示角标，计数在跑数加待确认数；点开后列出每个定义及其运行控件。列表从不按会话过滤：当前会话的行置顶成组，其他会话的行仍在下方列出。行来自 host 的当前清单，并在公告改变「有哪些定义」时更新。上一次读取覆盖不到的待审批 run 请求仍然有行，直接用请求自带的会话、标签、用途与标识渲染。每一行显示两个独立事实——host 在跑什么与本页装载了什么——因此刷新后的页面会先给「装回本页」、再给全局 stop，而纯 host 定义的行如实读作运行中、只给 stop。该行还会把本页最后一次渲染失败就地显示，与装载失败共用同一个位置：一个是「它从来没装上」，另一个是「它装上了、然后抛了」。

### 工具卡片显示什么

`cordis_define` 卡片是一份记录：模型写下的 name 与 purpose、它写的源码，以及该定义是否在跑——没有开关、没有审批，只有一句指向面板的指引。`cordis_run` 卡片显示模式、插件、包与运行标识、结果，并在包注册了业务视图时经 `tool.view.cordis` 槽位提供它。`cordis_stop` 与 `cordis_undefine` 渲染紧凑的动作行。所有卡片都渲染会话记录下的 call 与 result，因此 replay 显示同一张卡。

### @pluginId 输入源

在输入框里键入 `@` 会给出当前会话已定义的插件；选中一个会输出 `@pluginId`，工具包把它变成一条钉住的引用上下文给模型。

### 需要规划的边界

定义以进程为本：刷新后的页面手上什么都没有，直到有人再次运行某个包；面板在每次公告时重读清单。审批按设计是框架级的，所以某个标签页里的人可以批准模型为另一个标签页正在看的会话所发起的 run；首个应答生效，其余收敛。

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
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：槽位注册、清单接线、`@pluginId` 输入源 |
| [`src/client/CordisPanel.tsx`](src/client/CordisPanel.tsx) | 全局面板及其运行控件 |
| [`src/client/CordisDefineRow.tsx`](src/client/CordisDefineRow.tsx) | 只读的 `cordis_define` 卡片 |
| [`src/client/CordisRunRow.tsx`](src/client/CordisRunRow.tsx) | `cordis_run` 卡片及其业务视图席位 |
| [`src/client/CordisActionRow.tsx`](src/client/CordisActionRow.tsx) | `cordis_stop`／`cordis_undefine` 行 |
| [`src/client/card-model.ts`](src/client/card-model.ts) | 从冻结 call/result 切片派生的可回放视图模型 |
| [`src/client/inventory.ts`](src/client/inventory.ts) | 单飞清单读取及其重连处理 |
| [`src/client/status.ts`](src/client/status.ts) | 基于清单与本页 live set 的可见状态读数 |
| [`src/client/slots.ts`](src/client/slots.ts) | 注入面与包自有的 `tool.view.cordis` 槽位声明 |
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
- [工具包](../tool-cordis/README.zh.md)——调用被这些卡片渲染的模型侧工具。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.dynamicCordisRunner` API 与转发的 `cordis/*` 事件。
- [slots 子系统](../../../docs/subsystems/slots.zh.md)——槽位注册的浏览器 UI 如何归其包所有。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由这些界面驱动的 run 与 stop 动词——run 走浏览器侧 runner 的编排，stop 与 remove 走 host 的动词，与模型的 `cordis_run` / `cordis_stop` 工具是同一批 host 动词。因此正在运行的定义随后贡献了什么是 runner 的效果，而本包不产生任何模型可见输入：它只渲染已落日志的 call 与 result 切片和一次 host 清单读取，不加 prompt 内容、不写会话事件，并刻意不为「有人批准 / 拒绝 / 运行 / 停止」留下会话日志痕迹。

#### KV Cache 影响

无：没有任何 prompt 输入源自这里，应答一次 run 请求既不延长也不改写历史尾部。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明这些界面何时需要特别小心。它们是当前包约束，不是任务积压。

- **已展开的面板看不到「不广播任何东西」的注册表变化**——`cordis_define`，以及对一个并未在运行的定义执行 undefine，都会改变注册表却不发出下发公告；因此跨过这类变化时，已展开的面板会保留旧行，直到收起再展开。run 请求是例外：它阻塞模型，所以它既自己渲染出行，也触发一次读取。
- **只有请求、没有清单的行可应答但不可操作**——它只提供批准与拒绝，因为 run／stop 控件需要那次读取尚未送达的注册表行。
- **行可能消失一次读取的时长**——活动的 orchestrating 臂带会话但刻意不带标签，因此一个已批准、但注册表读取尚未落地的请求，在读取落地前没有行；实践中读取在请求到达时即已触发。
- **渲染失败是本页自己的读数，而且它来得太晚、赶不上 run 的回执**——面板显示的是 runner 在本页看到的最后一次崩溃，所以一个在本标签页渲染正常的包，即使正在另一个标签页里崩溃，这里也什么都不显示；模型只能靠主动去问（`cordis_inspect_self`）才知道，而不是从它已经发出的那次调用里得知。
- **某一页的装载失败对其他页不可见**——host 以首个装载回报结算一次 dispatch，因此在另一页确认之后浏览器半才失败的页面，在其他页上仍会读作运行中。
- **任何页面都可以应答任何请求**——审批按设计是框架级的，所以某个标签页里的人可以批准模型为另一个标签页正在看的会话所发起的 run；收窄「谁有权应答」延后。
- **call head 掉出事件窗的卡片会丢掉标签**——define 卡片的 name 与 purpose 取自调用参数，因此会话长到把它们截断时，卡片只能以自己的 call id 自称；面板不受影响，因为 host 清单携带标签。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 keyed toolview，HMR 测试覆盖释放；per-definition run-state 只存在于浏览器进程，Host 不变式无法观察。
