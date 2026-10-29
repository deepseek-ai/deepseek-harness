---
description: "可选操作卡片的共享 Host 服务：propose_action 工具、卡片状态、用户操作和状态通知，各实验包把自己的卡片种类注册进来。"
kind: "package-reference"
---

# @deepseek-ai/dsh-action-cards

[English](README.md) | 中文

## 概述

实验可以在回答下方提供一个可选操作，例如创建页面，而不必新增自己的工具。模型先加载该实验的 Skill，再调用 `propose_action`；本轮结束后卡片出现在回答下方，用户操作之前不会执行任何事。用户的每次选择都会被记录，并在模型的下一次请求中告知模型。对话中加载卡片 Skill 之前，这个工具不占用任何 token。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[个性化推荐](../personalized-recommendations/README.zh.md) Bundle 会插入本服务及其[浏览器端](../client-ui-action-cards/README.zh.md)。本服务只有一个配置字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `queuedMessageLimit` | `2` | 排队到后续轮次的用户消息达到该数量时，`propose_action` 拒绝调用，因此不会展示卡片。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-action-cards)是可接受字段的完整来源。

### 注册卡片种类

种类所在的包注入 `actionCards`，并在自己的插件中调用 `ctx.actionCards.register(kind)`；该插件卸载时种类随之移除，此后对其卡片的操作会以 unavailable 拒绝，只有“暂不需要”仍可忽略尚未开始的卡片。种类需要给出：动作名、提议该动作的 Skill、被接受的调用结果交给模型的结尾邀请指引、卡片 `details` 的 zod 校验、接受的用户操作及各自需要的共享检查（`global` 表示需要全局 Remote 权限，`writes` 表示只读会话中拒绝）、仍可忽略卡片的已记录阶段、可选的状态说明、状态通知要报告的决定数据字段、可选的 `reconcile`（每次操作前根据会话之外的状态更新卡片的已记录决定），以及处理 `dismiss` 以外所有操作的处理器。处理器用 `ctx.actionCards.record()` 记录每个新决定（该方法拒绝没有种类注册过的动作和推导得出的 `replaced` 阶段），并返回 `accepted`、带当前决定的 `settled`、`refused` 或 `unconfirmed`。

### 卡片规则

- 一轮中第一个被接受的 `propose_action` 调用成为卡片。工具会拒绝同一轮的第二次调用、未注册的动作、本轮没有加载对应种类 Skill 的调用、空白的标题或说明、未通过种类校验的 details、从代码中发起的调用、来自 subagent 的调用，以及排队到后续轮次的用户消息达到 `queuedMessageLimit` 条时的任何调用。
- 任何种类的新卡片都会替换此前所有尚未开始的卡片。替换从日志推导，从不单独记录。
- fork 出的会话从父会话继承的事件不会产生卡片。
- 每次操作（包括“暂不需要”）之前，种类的 `reconcile` 先根据会话之外的状态更新卡片。之后，对尚未开始的卡片，以及处于种类列出阶段的卡片，“暂不需要”会被记录；已忽略、已替换的卡片不再接受任何操作。卡片的种类未注册时，“暂不需要”仍可忽略尚未开始的卡片，其他操作一律以 unavailable 拒绝。
- 同一张卡片上的并发操作共用一次处理。操作要求卡片所在会话的根 Agent 仍然在线。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节——点击展开</summary>

本包默认导出 `actionCards` Remote 服务。它在全局注册一次 `propose_action`，并附带 `when` 条件：在线的根 Agent 自己直接调用 `skill` 加载了已注册种类的 Skill 后，该 Agent 才满足条件，subagent 或代码中发起的加载一律忽略；这个标记保存在内存中，直到 Agent 被释放。调用的 `execute` 检查在线根 Agent、投影累计的排队消息是否达到 `queuedMessageLimit`，并通过轮次边界检查本轮加载过的 Skill，同时在内存中标记本轮已接受的调用；日志中的 `tool/call` 及其成功的 `tool/result` 就是持久的提议。

`actionCards` 会话投影（状态版本 2）把每个 `propose_action` 调用与其成功结果配对，从 `plugin:action-cards/decision` 读取决定，从收件箱拼接事件累计排队到下一轮的消息供工具上限使用，并保留尚未报告的决定，直到 `through` 覆盖它们的状态通知写入日志。投影的客户端视图 `{ proposals, decisions }` 不进入会话摘要。

Remote `act(sessionId, callId, verb, payload?)` 先检查服务所有者、在线根 Agent 和卡片；“暂不需要”在种类未注册时也继续处理，其他操作还需要种类、操作和 Remote 权限。然后同一张卡片共用一次处理。种类的 `reconcile` 先运行，之后再次检查在线根 Agent；已忽略或已替换的卡片原样返回，“暂不需要”被记录，写入类操作在只读会话中被拒绝，其余操作在该 Agent 的发起方作用域内交给种类处理器。`record()` 也接受种类已注销的动作，因为 Cordis 并发释放插件的各个 effect，卸载中的种类仍要记录已开始工作的结果。一个 `agent/pre-step` 监听器在后续监听器准备好本步之后追加状态通知。

| 源码 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、工具、种类注册表、Remote 操作与状态通知 |
| [`src/projection.ts`](src/projection.ts) | 会话投影 |
| [`src/types.ts`](src/types.ts) | 提议、决定、视图与结果类型 |
| [`tests/`](tests/) | 激活、校验、投影、操作与通知测试 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [操作卡片显示](../client-ui-action-cards/README.zh.md) — 浏览器端卡片框架、种类正文与过程行。
- [个性化页面](../creation-recommendations/README.zh.md)和[插件推荐](../plugin-recommendations/README.zh.md) — 随产品提供的卡片种类。
- [工具](../../core/tools/README.zh.md) — 条件注册与每步准入。
- [会话投影](../../session/session-projection/README.zh.md) — 浏览器读取的卡片状态。

<a id="model-experience"></a>
## 模型体验

### 卡片工具

#### 模型看到什么

[`propose_action` 声明](../../../docs/tool-catalog.zh.md#deepseek-aidsh-action-cards)只对在本会话中自己直接调用加载过已注册种类 Skill 的在线根 Agent 出现，从下一步开始，持续到该 Agent 被释放。subagent 看不到它；PTC 预设的 Skill 加载由代码发起，也看不到它，因此不会展示卡片。种类的 Skill 给出动作名和 `details` 的字段。被接受的调用返回 `Card shown below your answer. Do not restate it. <invitation>`，其中 `<invitation>` 是种类给出的一两句指引，说明如何用用户的语言邀请用户使用卡片，因此模型只会在卡片已经存在之后写邀请。被拒绝的调用不带邀请，只返回原因，例如 `Load skill <skill> first, then call propose_action.`、`One card per turn; the earlier card stands.`、`The user has queued more messages; show no card and answer briefly.`、`Cards are offered in the main conversation only.`、`Unknown action "<action>". Registered actions: <actions>.`（最后一个种类注销后列表为 `none`），或未通过校验的 `details` 字段。

#### Token 影响

加载卡片 Skill 之前，工具不增加任何 token。加载之后，该 Agent 的每次请求都会声明它：574 个字符的 JSON，按 token 计量器每 4 个字符计 1 个 token 约 144 个 token。出一张卡片多一次模型往返（最终回答前的这次调用）以及一条工具结果：49 个字符的前缀加上种类的邀请。个性化页面的结果为 305 个字符，按同样的比例约 77 个 token。

#### KV Cache 影响

在声明支持工具更新的路由上（例如 DeepSeek-V4.1-Flash），激活只追加内容：条件变为真时，循环记录一次请求头变化和一条 `tool-addition` 开发者消息，这些路由以延迟加载声明的形式在该位置引用新定义，因此已缓存的前缀保持不变。不支持工具更新的路由从这一步起在声明列表中收到该工具，请求前缀因此改变一次。Agent 被释放后激活随之失效；重新打开的会话要再次加载卡片 Skill 才会再次声明该工具，并依次记录一次移除和一次添加。

### 卡片状态通知

#### 模型看到什么

记录决定之后，下一次请求会带一条 `action-cards` 通知：下方的开头段落、所涉及各种类的说明句、`Continue with the user’s current request.`，以及一个 JSON 数组，列出发生变化的卡片的 `action`、`callId`、`title`、`phase` 和种类要报告的数据字段。

##### 通知开头

```markdown
Latest status of action cards from user actions and background work. These are status facts, not a request to start or retry work. Use these receipts instead of the earlier proposal when describing progress.
```

#### Token 影响

有新决定之后的每次请求带一条通知，大小取决于发生变化的卡片；没有变化的卡片不增加内容，同一张卡片的多次决定只报告最新一次。

#### KV Cache 影响

通知追加在本次请求其他新上下文之后，从不改写之前的消息。通知既不会开始新轮次，也不会唤醒空闲的对话。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 激活按在线 Agent 记在内存中，因此会话重新打开后，要再次加载卡片 Skill 工具才会再次出现。
- PTC 预设不会展示卡片：从代码中发起的 Skill 加载和调用既不会激活工具，也到达不了工具，因为日志把它们记为程序派发而不是工具调用。
- 卡片只在主对话中提供。subagent（包括 Creator 子 Agent）加载 Skill 不会激活任何东西，其调用也会被拒绝，因为只有在线的根 Agent 才能对卡片进行操作。
- 所有种类合计每轮只展示一张卡片。任何种类的新卡片都会替换此前所有尚未开始的卡片，因此第二个种类的卡片会替换第一个种类尚未开始的卡片。
- 用户操作的拒绝原因有意设计为普通字符串：服务定义 `closing`、`not-live-root`、`unknown`、`unavailable`、`access-denied` 和 `read-only`，各种类可以添加自己的原因，浏览器端正文为已知原因显示文案，其余按 unavailable 处理。
- 每个种类在两端各自校验 `details`：Host 端的 schema 在模型提议时和每次操作前校验，浏览器端正文用自己的 schema 校验，因此两个 schema 要一起修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
