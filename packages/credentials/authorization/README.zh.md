---
description: "面向用户与维护者的授权 flow 注册表：获取配置无法提供的凭据，因为拿到它需要与人对话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-authorization

[English](README.md) | 中文

## 概述

`dsh-authorization` 让配置 UI 或其他调用方通过人引导的登录、输入码或回答问题来获取凭据。每次尝试只把 notice 与 prompt 发送到发起它的界面。只有新凭据已存储时，它才报告 `authorized`；拒绝或撤销会报告 `cancelled`，而故障仍作为错误。当凭据无法通过配置提供时选择它。它需要凭据存储和一个定义可用授权方法的集成；本包自身不提供特定提供方的授权方法。

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

本包是产品中负责获取「必须由人交出来」的凭据的部分：插件注册一个知道如何取得自己那份凭据的 flow，任何界面都能发起尝试并向人展示该做什么。常用路径是显式的——为你插件持有的每个凭据注册一个 flow，然后从人正看着的那个界面发起尝试。

### 何时使用

只要凭据只能通过与人对话获得——OAuth 式登录、一次性码、选一个账号——且无法存入配置，就使用它。如果凭据是部署方可以提供的一个固定密钥，请改用凭据 seam 存储它。无头或 ACP（Agent Client Protocol）组合也可以安全挂载本包：它本身不提供任何 flow，因此除非插件注册了 flow，否则不会要求人登录。

### 注册 flow

你的插件为它持有的每个凭据声明一个 flow，以该 flow 写入的 `<scope>/<id>` 凭据记录为键——scope 点名你的插件，id 点名它拥有的一条凭据：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context
declare const exchangeCode: (code: string, signal: AbortSignal) => Promise<{ token: string }>

const key = credentialKey('llm-pi-ai', 'openai-codex') // <scope>/<id> — your plugin / this credential

const dispose = ctx.authorization.registerFlow({
  key,
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
  async run(session: AuthorizationSession) {
    session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
    const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
    const { token } = await exchangeCode(code, session.signal)
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { token } }))
  },
})

ctx.authorization.list()          // every registered flow, with inFlight
ctx.authorization.describe(key)   // the entry above, or undefined
dispose()                         // unregister; withdraws any running attempt
```

flow 声明它写入的凭据记录、面向用户的标签以及它提供的登录方法，最优先者在前。`run()` 通过会话与人对话——单向 notice 与 flow 无法自行回答的问题——并且必须在返回前通过 `ctx.credentials` 提交记录：seam 会拒绝未提交就返回的 flow。`list()` 与 `describe()` 让界面展示可授权的内容以及是否有尝试在运行；`dispose()` 注销该 flow 并撤销仍在运行中的尝试。

### 发起一次尝试

每个凭据同时只允许一次尝试。交互随请求传入而非存放在注册表中，因此提问恰好抵达发问的那个页面；无头调用方传入一个直接拒绝的交互实现。当记录在尝试期间被提交并被观察到时，`begin()` 报告 `{ status: 'authorized' }`；当人拒绝或调用方撤销时，报告 `{ status: 'cancelled' }`。`cancel(key)` 从第二次调用撤销正在运行的尝试，服务于那种用第二次调用来响应「取消」按钮、却不持有第一次调用 signal 的请求/响应式传输。

### 可能出错的地方

- **没有 flow 的凭据是惰性的**——对没有任何 flow 认领的键调用 `begin()` 会抛出 `NO_FLOW`；被卸载插件遗留的记录可以删除，但无法重新授权。
- **每个凭据同时只允许一次尝试**——已有尝试在运行时再次 `begin()` 会抛出 `ALREADY_IN_FLIGHT`；entry 上的 `inFlight` 让界面预先禁用按钮。
- **未提交就返回的 flow 会被拒绝**——抛出 `NOT_COMMITTED`，因此 `authorized` 永远意味着记录真的已存储。
- **点名 flow 未提供的方法会抛出 `UNKNOWN_METHOD`**——不点名则运行 flow 的第一个方法。
- **「不」是一种结果，不是故障**——被拒绝的 prompt 让尝试以 `cancelled` 结算，与撤销的 signal 完全一致；其余任何失败都以抛出的错误抵达调用方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本 seam 背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **seam 拥有对话，从不拥有协议。** 知道如何取得自己那份凭据的插件，以它写入的记录为键注册一个 flow；第二种授权协议以另一个 flow 的形式到来，而不是另一个 seam，能渲染一个 flow 的界面就能渲染全部 flow。
- **写入由 flow 拥有。** `run()` 返回即表示记录已通过 `ctx.credentials` 提交；seam 核实的是它在尝试期间观察到的提交——只看记录存在与否，会让重新授权把陈旧记录冒充成新鲜的——并拒绝未提交就返回的 flow。让提交发生在 flow 内部，才能使一个通过自有存储适配器持久化的库保持为唯一写入方，而不是把凭据复制出来再写第二遍。
- **交互随请求传入，而非注册表。** 发起授权的一方才是能与人对话的一方，因此提问恰好抵达发问的那个界面，无头调用方则传入一个直接拒绝的交互实现。这样既不存在「环境提供方缺席」的问题，也不会有某个提问该归两个已打开页面中哪一个的疑问。
- **人的「不」是一种结果，不是故障。** 选择拒绝的交互实现以 `AuthorizationDeclinedError` 拒绝其 prompt，尝试以 `cancelled` 结算，与撤销的 signal 完全一致；其余任何 prompt 拒绝仍是抵达调用方的 flow 故障。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：flow 注册表、每键单尝试生命周期、交互路由、提交确认 |
| [`src/types.ts`](src/types.ts) | 跨进程安全的词汇：方法、notice、prompt、结果、entry |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：`authorization/settled` 点名的键必已释放 |

### 生命周期

每个键同时只允许一次尝试。`begin()` 校验键与方法、拒绝繁忙键的第二次尝试，并用一个 `AuthorizationSession` 运行 flow——它携带所选方法、取消 signal 以及路由到请求交互的 `notify`/`prompt` 回调。被撤销的尝试会立即结算，即使 flow 从未响应它的 signal——被遗弃的运行任其自行结束，而它若仍设法提交了一条记录，那也是一条人确实授权过的记录。键在 `authorization/settled` 触发之前释放，因此以启动下一次尝试来响应的监听器不会被拒绝；监听器失败按凭据 seam 的规则就地遏制。

### 交互词汇

notice 是单向的，且从不携带机密：一条消息，以及可选的「人需要打开的页面」与「需要在该页面输入的码」。prompt 是 flow 无法自行回答的问题——`text`、`secret` 或 `select`——其中 `secret` 与 `text` 的差别仅在呈现方式。prompt 自带 signal，使得让手输码与浏览器回调赛跑的 flow 可以在尝试继续的同时撤下落败的那个问题；撤销整次尝试则用请求的 signal。这套词汇刻意小于任何单个提供方的词汇：它描述的是界面必须渲染什么，因此能渲染一个 flow 的界面就能渲染全部 flow。

### 提交确认

尝试期间，seam 监听该 flow 键上的 `credentials/record-updated`，`run()` 返回后再重读 `describeRecord`——确认提交确实发生在当下，因为在重新授权时记录早已存在，只看存在与否会让陈旧凭据冒充新鲜授权。未提交就返回的 flow，或删除记录而非提交的 flow，会抛出 `NOT_COMMITTED`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享凭据词汇逐步进入 flow 写入的记录存储，以及本 seam 背后的决策证据。

- [凭据子系统参考](../../../docs/subsystems/credentials.zh.md)——两个键空间与两个 seam 的生成 Cordis 接口面。
- [凭据包映射](../README.zh.md)——凭据引用、本地存储与授权三个包。
- [凭据引用 seam](../credentials/README.zh.md)——每个 flow 都经由它提交的记录存储。
- [能力 seam](../../../docs/capability-seams.zh.md)——本 seam 遵循的 Service Definition / Service Provider / Consumer 拆分。
- [凭据记录与授权 flow](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)——记录半侧与本 seam 背后的理由与决策。

-----

<a id="model-experience"></a>
## 模型体验

无，因为授权是配置期与人的对话，flow、notice 与 prompt 都不会抵达模型请求。

#### KV Cache 影响

不失效；任何授权状态都不会进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **flow 不可恢复**——一次尝试只存活于发起它的进程中，因此登录途中刷新浏览器会丢弃它，人需要重来；可持久的尝试需要一个本 seam 并不具备的存储。
- **没有吊销**——登出即 `ctx.credentials.deleteRecord(key)`，它只遗忘本地记录而不通知签发方；需要服务端吊销的提供方没有可声明之处。
- **没有 flow 的键是惰性的**——seam 只报告已注册的内容，因此被卸载插件遗留的记录可以删除但无法重新授权；识别这种孤儿记录由调用方负责，与 `listRecords()` 的情况相同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

上文限制点名的开放方向——可恢复的尝试、服务端吊销、孤儿记录发现——每一项落地前都需要各自的设计与存储。不变式伴生插件是唯一承重的运行时检查：结算时键必须已释放，因为卡死的键与繁忙的键无法区分，只有重启才能释放它。

</details>
