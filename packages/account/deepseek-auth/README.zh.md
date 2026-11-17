---
description: "面向调用 DeepSeek API 的插件的 DeepSeek 请求鉴权：一个服务在 API 密钥与账号登录之间选择，把凭据绑定到它所属的部署，并释放请求头。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-auth

[English](README.md) | 中文

## 概述

`dsh-deepseek-auth` 通过 `ctx.deepseekAuth` 为发往 DeepSeek API 的请求鉴权。消费方给出其 API 接受的凭据种类（API 密钥、账号登录，或两者）以及其设置选择的计费方式。服务排定种类的顺序，把每一种绑定到其凭据所属的部署，并释放第一个持有凭据的种类的请求头。DeepSeek 模型路由、Search 与 Fetch API、Messages 搜索都使用它。它不存储任何东西：密钥来自凭据存储或启动环境，登录凭据来自账号服务。

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

调用 DeepSeek API 的插件向本服务索取一次请求的凭据。请求由插件自己发送，失败的措辞也由插件自己决定。

### 何时使用

Host 插件发往 DeepSeek 部署的每一个请求都使用它。凡是挂载了 DeepSeek 模型路由或 DeepSeek Web 提供方的组合都要挂载它，这些插件依赖它。它不需要配置。凭据服务和账号服务已挂载时它会读取它们，两者都没有时也能工作。

### 为请求鉴权

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-auth'

declare const ctx: Context
declare const route: string | undefined // provider route of the conversation's latest model request
declare const signal: AbortSignal

const authorization = await ctx.deepseekAuth.authorize({
  consumer: 'my-plugin',
  accepts: ['account', 'api-key'],
  billing: 'auto',
  route,
  destination: { path: '/v1/tools/search' },
}, signal)
if (authorization === undefined) throw new Error('no DeepSeek credential is configured')
await fetch(authorization.endpoint, { method: 'POST', headers: authorization.headers, signal })
```

`accepts` 列出目标 API 接受的种类，不在其中的种类不会被尝试。某个 API 开始接受另一种凭据时，它的消费方把该种类加入 `accepts`，其余不变。`billing` 取 `api-key`、`account` 或 `auto`，`auto` 跟随会话的模型路由：

| `billing` | 会话的模型路由 | 依次尝试的种类 |
|---|---|---|
| `api-key` | 任意 | API 密钥 |
| `account` | 任意 | 账号登录 |
| `auto` | 为账号登录登记的路由，即 `deepseek-account` | 账号登录，然后 API 密钥 |
| `auto` | 为 API 密钥登记的路由，即 `deepseek-official` | API 密钥 |
| `auto` | 其他任何路由，或不在会话中 | API 密钥，然后账号登录 |

只有注册某条路由的插件已挂载并登记了它，该路由才属于前两行 `auto`。记录在 `deepseek-account` 或 `deepseek-official` 上的会话，在对应插件未挂载时按最后一行处理。

`destination` 是拼接到所选种类部署 origin 之后的路径，或一个绝对 `url`。只有当绝对 URL 位于某种类部署的 origin 之下且不内嵌凭据时，该种类才为它服务，因此密钥不会被发往其他 origin。

一次授权携带 `kind`、`endpoint` 和请求 `headers`。API 密钥以 `Authorization: Bearer` 发送，除非 `apiKeyHeaders` 指定 `x-api-key` 或两者；账号登录凭据放在账号服务选定的请求头里。`reject()` 只在账号登录时存在，用于在目标返回 HTTP 401 后作废该凭据。`revoked` 同样只在账号登录时存在，账号退出登录时中止：消费方结束它鉴权的请求，并把这次结束报告为自身的失败，而不是调用方的取消。

`candidates(request)` 以相同顺序返回相同的种类，但不读取凭据。每个候选用 `configured()` 回答就绪检查，用 `resolve(signal)` 给出凭据，并给出 `endpoint`，API 密钥还给出供诊断使用的 `reference`。`routeKind(route)` 给出已挂载的模型路由插件在该路由 id 下登记的种类，其他路由一律为 `undefined`。

### 每种凭据及其部署的来源

| 种类 | 其模型路由已挂载 | 未挂载 |
|---|---|---|
| API 密钥 | `deepseek-official` 路由设置里的密钥引用和 base URL，即 Models 页面编辑的那份 | `DEEPSEEK_API_KEY`，发往 `https://api.deepseek.com` |
| 账号登录 | 账号服务的凭据，发往 `deepseek-account` 路由 base URL 的 origin | 账号服务的凭据，发往 `DEEPSEEK_BASE_URL` 所指的 origin，默认为官方 API |

模型路由插件在 `ctx.effect()` 内登记它注册的提供方路由和自己的设置：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-auth'

declare const ctx: Context
declare const settings: () => { baseURL: string; apiKeyEnv: string }

ctx.effect(() => ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => {
  const { baseURL, apiKeyEnv } = settings()
  return { baseURL, reference: credentialRef(apiKeyEnv), owner: 'llm-deepseek' }
}))
```

服务对每个请求调用这个函数，所以设置的改动在下一个请求生效。连接存在期间，`auto` 计费按所登记的种类排定该路由上会话的顺序。请求可以在 `connections` 里携带某一种类自己的连接，它取代已登记的或默认的连接：模型路由传入它为一次模型请求捕获的那一代配置，拥有自己端点和密钥的消费方传入这两项。

密钥在凭据服务已挂载时经由它读取，否则经由启动环境读取，规则由 [`dsh-credentials`](../../credentials/credentials/README.zh.md) 为引用定义。

### 可能出错的地方

- 没有候选持有凭据时，`authorize()` 返回 `undefined`。失败的措辞由消费方决定；`candidates()` 提供要指出的种类和密钥引用。
- 空白的或含有 HTTP 请求头无法携带的字符的 API 密钥，以 `DeepSeekAuthError`（代码 `INVALID_CREDENTIAL`）失败。消息指出属主和要修正的引用，不包含密钥。
- 连接无法解析的种类（路由设置抛出、base URL 无法解析，或 `DEEPSEEK_BASE_URL` 不是 HTTP(S) URL）在 `candidates()` 中表现为未解析条目。`authorize()` 在此以代码 `UNRESOLVED_CONNECTION` 停止，不再尝试后面的种类。
- 对同一种类第二次 `connect()` 抛出 `DUPLICATE_CONNECTION`。
- 凭据存储的失败向上传播。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策；可观察的行为见[使用本包](#use-this-package)。

### 设计理念

- **消费方声明其 API 接受什么，服务负责选择。** DeepSeek 逐个为它的 API 增加账号鉴权。消费方的 `accepts` 列表是记录某个 API 接受什么的唯一位置，所以 API 新增一种凭据时，扩充这个列表就是全部改动。
- **凭据绑定到它的部署。** 每个种类同一时间只有一个部署，凭据只释放给该部署 origin 之下的目标。
- **模型路由也是消费方。** 路由插件登记自己的设置，并和其他消费方一样索取授权，因此传输层和模型服务不带任何凭据接口。
- **服务不依赖任何消费方。** 它读取凭据存储和账号服务，自身不写任何模型路由的名字：每个路由插件在登记时传入自己的路由 id，`auto` 计费把会话的路由与已登记的 id 比较。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：连接、计费顺序、目标绑定、API 密钥来源与账号来源、`DeepSeekAuthError` |
| [`src/types.ts`](src/types.ts) | 请求、连接、候选与授权的类型 |

### 生命周期

服务只保存模型路由插件登记的连接，每个 disposer 移除一个。请求之间不保留其他任何东西：每次 `candidates()` 调用都重新读取已登记的设置，每次 `resolve()` 都重新读取凭据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [账号包映射](../README.zh.md)——账号服务与本服务。
- [DeepSeek 账号子系统](../../../docs/subsystems/account.zh.md)——账号登录以及本服务释放的请求凭据。
- [凭据引用 seam](../../credentials/credentials/README.zh.md)——密钥引用如何读取与检查。
- [DeepSeek 请求鉴权](../../../.agents/notes/implemented/architecture/2026-11-10-deepseek-request-authentication.zh.md)——决策及被否决的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务向 Host 插件释放请求头，不向模型请求的内容贡献任何东西。模型读到的失败文案由它的消费方措辞。

#### KV Cache 影响

不失效；没有凭据进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包在何时不适用或需要特别注意。它们是当前的包约束，不是任务积压。

- **每个种类一个部署**——第二条带有自己密钥和端点的 `deepseek-official` 式路由无法登记；需要另一把密钥的消费方在请求里传入自己的连接。
- **路由只在其插件已登记时才算 DeepSeek 路由**——记录在 `deepseek-account` 或 `deepseek-official` 上的会话，在对应插件未挂载时按其他路由的顺序处理（先 API 密钥，后账号登录）；经由其他提供方插件访问的 DeepSeek 模型也是如此。
- **不校验凭据**——`configured()` 只报告是否存在，所以错误的密钥在目标拒绝它之前都算已配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题和尚未确定的方向。它明确不具权威性——已交付的行为、限制和已接受的理由见上文各节、包代码和链接的 Agent Note。

`/v1/tools/` 下的语音和文档 API 目前只接受 API 密钥。它们的消费方声明 `accepts: ['api-key']`，待服务端接受账号登录后再加入 `account`。

</details>
