---
description: "面向用户与维护者的凭据 seam：在不把机密值写进配置的前提下解析、描述或存储凭据——引用值与持久化记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials

[English](README.md) | 中文

## 概述

`dsh-credentials` 通过让 settings 与 `cordis.yml` 引用 `DEEPSEEK_API_KEY` 等密钥名称，使机密值留在配置之外。它还存储持久化的按插件组织的凭据记录，包括授权 grant 与提供方环境值。轮换后的已存储密钥会作用于下一次请求，无需重启或修改配置。配置界面可以报告密钥或记录是否已设置、来自哪里及能否写入，而不会暴露值。空密钥值视为不存在，而空记录仍表示一项有意存储的凭据。

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

本包是产品中负责存储与查询机密值的部分：密钥只存一次、处处按名引用，并可在任意时刻读取、检查或移除。它还保存持久化的凭据记录，让插件可以为自身 id 存储、更新或移除它持有的凭据。产品的默认组合已包含凭据存储；自定义组合只需加载本地存储包并给出文件路径。

### 何时使用

只要配置需要与机密值绝缘，就使用凭据存储：需要同步、共享或渲染进配置界面的设置文件，或希望在不改配置的情况下轮换密钥的团队。当插件必须保存没有单一环境变量的凭据——登录流程产生的授权 grant，或提供方环境值——并希望配置界面能列出用户获得了哪些授权时，请使用记录。配置界面能显示某个密钥或记录是否已设置、来自哪里、能否修改——但绝不显示值本身。如果只需要一个固定的环境变量，直接读该变量即可，无需存储。

### 加入你的组合

加载本地存储包并给出文档路径：

```yaml
- name: '@deepseek-ai/dsh-credentials-local'
  config:
    path: /absolute/path/to/.credentials.yaml
```

本地存储 README 拥有完整配置面；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-credentials-local)是穷尽式字段清单。

### 存储、检查与移除密钥

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')          // POSIX shell identifier, branded
const hit = await ctx.credentials.resolve(ref)         // { value, source } | undefined
const info = await ctx.credentials.describe(ref)       // { configured, source?, writable } — never the value
await ctx.credentials.set(ref, 'sk-…')                 // rejects while a read-only source shadows the ref
await ctx.credentials.unset(ref)                       // no-op when absent; same shadowing rule
```

用 `set` 存储密钥、用 `unset` 移除、用 `describe` 检查状态、在操作需要时用 `resolve` 读取当前值。`describe` 报告密钥是否已设置、来自哪里、能否写入——它绝不返回值。

### 存储、更新与移除记录

插件按 `<scope>/<id>` 寻址每条记录——自身注册名加一个自选 id，例如提供方路由键——并读取、修改或移除它所持有的内容：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const key = credentialKey('llm-pi-ai', 'openai-codex')   // <owner>/<id>, branded
const hit = await ctx.credentials.readRecord(key)        // CredentialRecord | undefined
await ctx.credentials.describeRecord(key)                // { configured, kind?, writable } — never the value
await ctx.credentials.listRecords()                      // [{ key, kind }] — never values
await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: '…' } }))
await ctx.credentials.deleteRecord(key)                  // no-op when absent
```

`modifyRecord` 是唯一写路径：它让你的变更函数看到写入取得独占那一刻的记录，返回 `undefined` 则保持原状。记录没有空值规则——一条既无 key 也无环境值的记录，陈述的是其拥有者确认了 ambient 认证——配置界面还可以枚举每条记录，显示你获得了哪些授权，并找出已卸载插件留下的记录。

### 在配置中使用密钥

settings 分节或 `cordis.yml` 条目按名引用密钥，而不是包含密钥本身——例如 LLM（大语言模型）适配器接受 `apiKeyEnv`：

```yaml
apiKeyEnv: DEEPSEEK_API_KEY
```

需要该密钥的请求使用它当前存储的值，因此轮换密钥会作用于紧随其后的下一次请求——无需重启，无需改配置。

### 可能出错的地方

- **启动环境提供的密钥无法被覆盖**——`DEEPSEEK_API_KEY=… dsh`（或 CI 机密、容器 `-e`）在本轮运行中优先，并被报告为只读；请先在启动 shell 中清除该变量，再存储其他值。
- **空值无法存储**——存储空字符串会被拒绝；请改为移除密钥。
- **密钥值绝不会出现在配置界面或诊断信息中**——界面只显示密钥是否已设置、来自哪里、能否修改；值本身留在存储中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一条准则，四个推论：

- **配置只携带引用，绝不携带机密。** settings 分节或 `cordis.yml` 条目点名一个凭据；引用背后的值存放在提供方处。设置文档可以放心同步、放心渲染，`describe()` 无需持有值就能回答，轮换机密不触碰任何配置文件。
- **消费方按操作解析。** 解析是一次按调用读取，无跨操作缓存；这次读取正是热更新机制。
- **空的存储值等于不存在。** `resolve` 跳过它，`describe` 报告未配置——空白永远不会伪装成已配置的机密。
- **记录是持久化的，存在即事实。** 记录按 `<scope>/<id>` 存储并跨重启保留；空值规则不适用，因此一条既无 key 也无环境值的 `api-key` 记录是有意陈述，而不是空白。
- **监听器失败受到隔离。** `notifyUpdated` 扇出 `credentials/reference-updated`，保证每个监听器都会运行；同步抛出与异步拒绝都会被记录，不改变已提交操作的结果，`INVARIANT` 编码的失败除外——它们在所有监听器运行完毕后重新抛出。

### credentials/reference-updated 事件

`credentials/reference-updated (ref)` 在提供方管理的来源发生已提交变更后触发——`set`、`unset` 或在存储中观察到的外部编辑。进程环境变量的变化不可观测，永不触发。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新「已配置」徽标。

`credentials/record-updated (key)` 在存储记录发生已提交变更后触发——一次确实写入的 `modifyRecord`、一次确实移除的 `deleteRecord`，或在存储中观察到的外部编辑。它保持独立事件，因为两个键文法互斥：一个监听器若在同一事件上同时收到两个空间，将无法分辨主体属于哪一边。

### 记录写入与读取路径

`modifyRecord` 是唯一写路径，因为正确的写入依赖当前值：刷新 token 是「读—决定—替换」，变更函数看到的是写入取得独占那一刻的记录——返回 `undefined` 则保持原状。独占在支持它的底层存储上跨进程成立，这正是防止两个进程同时轮换一个 refresh token、丢掉先写那一个的机制。读取与引用一侧对称，但绝不分层：没有任何东西能遮蔽记录，`grant` 的 payload 会原样返回给其拥有者，因为只有拥有它的插件能解释它。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：`credentialRef`/`credentialKey` 品牌、`ResolvedCredential`/`CredentialRecordInfo`、覆盖两个键空间的抽象提供方、带失败隔离的扇出 |
| [`src/types.ts`](src/types.ts) | 客户端安全类型面：`CredentialRef` 与 `CredentialKey` 品牌、存储记录联合类型、`CredentialInfo` 引用视图、`credentials/reference-updated` 与 `credentials/record-updated` 事件声明 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：`credentials/reference-updated` 只在凭据服务存活时触发 |

### 客户端安全类型

`./types` 子路径出口把事件声明与其点名的 `CredentialRef`、`CredentialKey` 品牌、存储记录联合类型，以及配置界面读取的 `CredentialInfo` 引用视图放在一起，包根继续 re-export 它们。于是 Host 编译面之外的消费方读到的正是 Host 发射的那一份签名，而不必再写一遍。

### 生命周期

服务是提供方注册的 Cordis `Service`：释放挂载 fiber 会移除 `ctx.credentials`。不变式伴生插件检查 `credentials/reference-updated` 绝不在服务未存活时触发——释放后仍有发射意味着提供方把工作泄漏到了 teardown 完全停稳之后。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统词汇逐步进入随附存储与能力架构。

- [凭据子系统参考](../../../docs/subsystems/credentials.zh.md)——`CredentialRef`/`CredentialKey`、按操作解析、对 UI 安全的信息、提供方层与生成的 Cordis 接口面。
- [本地凭据存储](../credentials-local/README.zh.md)——默认本机存储：密钥与记录存放在哪里、环境层如何排序。
- [能力 seam](../../../docs/capability-seams.zh.md)——本包遵循的 Service Definition / Service Provider / Consumer 拆分。

-----

<a id="model-experience"></a>
## 模型体验

经由消费方适配器间接生效：适配器解析每个凭据引用，并拥有值所授权的全部模型可见用途。

#### KV Cache 影响

无直接失效；解析出的值绝不进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **引用不提供枚举**——seam 只回答被问到的引用；配置界面从 settings schema 得知引用集合，对这一半做 `list()` 没有当前消费方。记录则可以枚举，因为没有可用于发现记录的 schema。
- **引用限定为环境变量形状**——单一扁平的 POSIX 标识符命名空间，因为引用同时就是它借以解析的环境变量名。记录使用更丰富的 `<owner>/<id>` 寻址。
- **进程环境变化不可见**——无法为启动 shell 中改变的变量发出通知；界面只能在自身导航时重新读取 `describe()`。
- **记录的拥有者就是它的 scope，而没有任何环节核验该 scope 是否已挂载**——seam 存下被交予的内容，并报告它存了什么；识别遗留记录需要调用方将 `listRecords()` 的结果与拥有该 scope 的注册表关联起来，seam 自身没有可供核对的注册表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

该 seam 的接口为 keyring、辅助命令与 KMS 后端提供方预留了扩展空间；远端设置提供方永远不必携带机密。目前没有任何一种随附，也没有当前消费方需要它们。

</details>
