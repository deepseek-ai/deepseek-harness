---
description: "可选操作卡片的共享 Host 服务：从回答里的 action-card 代码块读出的卡片、卡片状态、用户操作和状态通知，各功能包把自己的卡片种类注册进来。"
kind: "package-reference"
---

# @deepseek-ai/dsh-action-cards

[English](README.md) | 中文

## 概述

功能可以在回答下方提供一个可选操作，例如创建页面，而不必新增工具。模型先加载该功能的 Skill，再在回答末尾写一个注明动作的 `action-card` 代码块；[浏览器端](../../client/ui-action-cards/README.zh.md)把代码块隐藏起来，本轮结束后卡片出现在回答下方，用户操作之前不会执行任何事。用户的每次选择都会被记录，并在模型的下一次请求中告知模型。

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

Web 组合（[`dsh-web-app`](../../bundle/web-app/README.zh.md)）在每个 Web 和桌面端 profile 中挂载本服务及其[浏览器端](../../client/ui-action-cards/README.zh.md)，以及[个性化页面](../../extensions/creation-recommendations/README.zh.md)和[插件推荐](../../extensions/plugin-recommendations/README.zh.md)两个种类。本服务有一个配置字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 在之后的 Skill 目录中列出各卡片种类通过 `skillProvider` 注册的 Skill，对所有种类生效，不只是两个推荐种类。“设置 → 通用设置 → 个性化推荐”无需重启即可修改。关闭后，这些 Skill 既不列出也不能加载；模型仍写出的代码块（例如本会话早先已加载过 Skill）照常成为卡片，已经显示的卡片也仍可操作。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-action-cards)是可接受字段的完整来源。

### 注册卡片种类

种类所在的包注入 `actionCards`，在自己的插件中调用 `ctx.actionCards.register(kind)`，并用 `ctx.skills.registerProvider(ctx.actionCards.skillProvider(candidate, get))` 注册 Skill，由 `enabled` 开关控制；该插件卸载时种类随之移除，此后对其卡片的操作会以 unavailable 拒绝，只有“暂不需要”仍可忽略尚未开始的卡片。种类自己的 Skill 告诉模型何时提供卡片以及代码块里写什么。种类需要给出：动作名、卡片 `details` 的 zod 校验、接受的用户操作及各自需要的共享检查（`global` 表示需要全局 Remote 权限，`writes` 表示只读会话中拒绝）、仍可忽略卡片的已记录阶段、可选的状态说明、状态通知要报告的决定数据字段、可选的 `reconcile`（每次操作前根据会话之外的状态更新卡片的已记录决定），以及处理 `dismiss` 以外所有操作的处理器。处理器用 `ctx.actionCards.record()` 记录每个新决定（该方法拒绝没有种类注册过的动作），并返回 `accepted`、带当前决定的 `settled`、`refused` 或 `unconfirmed`。

### 卡片规则

- 卡片是语言为 `action-card` 的围栏代码块，内容是一个 JSON 对象，包含 `action`、`title`、`brief` 和对象类型的 `details`。围栏前最多有 3 个空格，或最多 3 个空格加一个列表项标记的代码块才算数；引用块里的、缩进 4 格及以上的，以及其他围栏代码块里的代码块不提供卡片。一轮中第一个能解析的这种代码块成为卡片，以所在助手消息的 id 作为卡片 id。同一轮之后的代码块、思考内容里的代码块、被打断的回答里的代码块、标题或说明为空的代码块，以及 subagent 会话里的所有代码块都不会产生卡片，也不会告知模型。
- 收下卡片时不检查种类：动作没有种类注册、或 `details` 未通过种类校验的卡片照样出现，除“暂不需要”外的操作一律以 unavailable 拒绝。
- 不同轮次的卡片各自可用，每张卡片的状态由其自身 ID 对应的决定记录确定。
- fork 出的会话从父会话继承的事件不会产生卡片。
- 每次操作（包括“暂不需要”）之前，种类的 `reconcile` 先根据会话之外的状态更新卡片。之后，对尚未开始的卡片，以及处于种类列出阶段的卡片，“暂不需要”会被记录；已忽略的卡片不再接受任何操作。卡片的种类未注册时，“暂不需要”仍可忽略尚未开始的卡片，其他操作一律以 unavailable 拒绝。
- 同一张卡片上的并发操作共用一次处理。操作要求调用者是卡片所在 Session 的精确在线 Agent 实例，且 `origin` 不是 `subagent`。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节——点击展开</summary>

本包默认导出 `actionCards` Remote 服务，不注册任何工具。日志里的回答就是持久的提议：`actionCards` 会话投影（状态版本 4）用 [`src/fence.ts`](src/fence.ts) 读取每条 `assistant/message` 的文字块，按 CommonMark 的围栏规则找出顶层和列表项里的围栏代码块，并按 Chat 客户端分派代码块的方式匹配语言，收下本轮第一个合格的代码块。投影还从 `action-cards/decision` 事件和早期版本写下的 `plugin:action-cards/decision` 记录读取决定，并保留尚未报告的决定，直到 `through` 覆盖它们的状态通知写入日志。会话头的 `origin` 标出 subagent 会话，其投影不收任何卡片。投影的客户端视图 `{ proposals, decisions }` 不进入会话摘要。`skillProvider()` 的目录在 `enabled` 打开时列出种类的 Skill。开关变化时，`loader/volatile-update` 监听器让这些目录失效。

Remote `act(sessionId, cardId, verb, payload?)` 先检查服务所有者、在线根 Agent 和卡片；“暂不需要”在种类未注册时也继续处理，其他操作还需要种类、操作和 Remote 权限。然后同一张卡片共用一次处理。种类的 `reconcile` 先运行，之后再次检查在线根 Agent；已忽略的卡片原样返回，“暂不需要”被记录，写入类操作在只读会话中被拒绝，其余操作在该 Agent 的发起方作用域内交给种类处理器。`record()` 也接受种类已注销的动作，因为 Cordis 并发释放插件的各个 effect，卸载中的种类仍要记录已开始工作的结果。一个 `agent/pre-step` 监听器在后续监听器准备好本步之后追加状态通知。

| 源码 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、种类注册表、Remote 操作与状态通知 |
| [`src/projection.ts`](src/projection.ts) | 会话投影 |
| [`src/fence.ts`](src/fence.ts) | 从回答文字中读取 `action-card` 代码块 |
| [`src/types.ts`](src/types.ts) | 卡片 id、代码块语言、提议、决定、视图与结果类型 |
| [`tests/`](tests/) | 代码块读取、投影、操作与通知测试 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [操作卡片显示](../../client/ui-action-cards/README.zh.md) — 浏览器端卡片框架、种类正文与隐藏的代码块。
- [个性化页面](../../extensions/creation-recommendations/README.zh.md)和[插件推荐](../../extensions/plugin-recommendations/README.zh.md) — 随产品提供的卡片种类。
- [Chat](../../client/ui-chat/README.zh.md) — 浏览器端借以隐藏代码块的 Markdown 围栏插槽。
- [会话投影](../../session/session-projection/README.zh.md) — 浏览器读取的卡片状态。

<a id="model-experience"></a>
## 模型体验

### 卡片代码块

#### 模型看到什么

没有工具。种类的 Skill 通过已有的 `skill` 工具加载，告诉模型何时提供卡片、`details` 有哪些字段，以及写在代码块之前的邀请句；模型随后在最终回答末尾写一个 `action-card` 代码块。代码块留在日志里的回答中，之后的请求把它当作普通回答文字带上。代码块有没有成为卡片，不会告知模型。

#### Token 影响

一张卡片不增加请求、工具声明或工具结果。它的代码块是最终回答的一部分：回放中的插件推荐代码块 237 个字符，个性化页面代码块 525 个字符，按 token 计量器每 4 个字符计 1 个 token 约 59 和 131 个 token。

#### KV Cache 影响

无。代码块是回答文字，请求前缀既不增加也不减少内容。

### 卡片状态通知

#### 模型看到什么

记录决定之后，下一次请求会带一条 `action-cards` 通知：下方的开头段落、所涉及各种类的说明句、`Continue with the user’s current request.`，以及一个 JSON 数组，列出发生变化的卡片的 `action`、`title`、`phase` 和种类要报告的数据字段。

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

- 代码块没有产生卡片时模型不会知道：格式错误的代码块、同一轮的第二个代码块或 subagent 的代码块都不显示任何东西，而回答里可能已经邀请用户点卡片。
- Host 逐行查找代码块，只认字面上就是 `action-card` 的语言，而 Chat 客户端会隐藏它渲染出的每一个 `action-card` 代码块。引用块里的代码块、嵌套列表项里缩进 4 格及以上的代码块、语言用转义或字符引用写成的代码块会被隐藏，但不提供卡片；HTML 块或 `$$`、`\[ … \]` 数学块里的代码块会提供卡片，但其文字仍然可见。各 Skill 要求在回答末尾写一个顶层代码块。
- 用已移除的 `propose_action` 工具录下的会话，这些调用不再显示卡片；用 `callId` 指代卡片的决定记录会被跳过。
- 卡片只在主对话中提供。subagent 会话（包括 Creator 子 Agent 的会话）不收任何卡片，因为只有在线的根 Agent 才能对卡片进行操作。
- 用户操作的拒绝原因有意设计为普通字符串：服务定义 `closing`、`not-live-root`、`unknown`、`unavailable`、`access-denied` 和 `read-only`，各种类可以添加自己的原因，浏览器端正文为已知原因显示文案，其余按 unavailable 处理。
- 每个种类在两端各自校验 `details`：Host 端的 schema 在每次操作前校验，浏览器端正文用自己的 schema 校验，因此两个 schema 要一起修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
