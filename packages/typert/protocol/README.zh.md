---
description: "共享的 Typert Remote 协议：业务包、生成产物、Host Gateway 与 Client API 使用的装饰器、wire 描述符、编解码器与提供方约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-typert-protocol

[English](README.md) | 中文

## 概述

借助 `dsh-typert-protocol`，业务包可以向 Remote 客户端暴露 Host 方法：用 `@Remote`（作用域接收者用 `@RemoteScope`）标记方法，把服务绑定到 wire 命名空间，并通过可合并扩展的协议映射把 Host 对象与作用域 Context 关联到 wire identity。生成产物、Host Gateway 与 Client API 消费同一套调用描述符、编解码器与提供方约定。调用持有的值把清理责任交给 Gateway，不另增引用计数。本包不注册任何 Cordis 服务，也不运行 TypeScript 分析。

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

本包供向 Remote 客户端暴露 Host 能力的业务包与装配维护者使用。它是一个声明库：标记方法、绑定服务，其余交给生成的流水线与 Gateway。

### 暴露 Host 方法

业务包用 `@Remote`（当接收者来自作用域 Context 时用 `@RemoteScope(key)`）标记一个公开实例方法，所属服务要么继承 `TypertRemoteService`，要么通过 `bindTypertRemote()` 声明 `typertRemote` 绑定：

```text
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class GoalService extends TypertRemoteService {
  @Remote
  async create(agentId: string, objective: string): Promise<GoalResult> {
    ...
  }
}
```

生成会把方法变为服务命名空间下的 wire 端点；Client 通过 `ctx.remote` 以类型化方法调用它（见 [API Gateway 参考](../../../docs/api-gateway.zh.md)）。方法把 `signal: AbortSignal` 声明为最后一个参数即可选择协作式取消——该信号是注入的，绝不会成为 JSON 参数或查找字段。

一元方法可以直接返回 `Uint8Array`，也可以将其放在嵌套对象、数组、元组、可选字段、联合类型和递归类型中。生成器提供可选的结果 codec `encode()` 和 `decode()`：编码仅访问类型可能包含字节的子树，解码则校验还原后的值；Client 声明在每个字节位置使用 `Uint8Array<ArrayBuffer>`，同时保留其他字段类型。纯 JSON 结果不经 Host 字节识别或 Client 解析直接传递。参数、事件与流条目仍仅支持 JSON；不支持运行时对象循环。

流方法（`@Remote({ mode: 'stream' })`）返回 `Iterable`、`AsyncIterable` 或 `RemoteStream<Out, In>`。`In` 声明 Client 可以在同一条逻辑流上回送的项；方法通过 `this.ctx.invocation.uplink<In>()` 读取它们，描述符携带其 codec。`RemoteInvocation` 还给出接收服务 `service`、发起调用的 `peer`（其载体指明的 `PeerScope`）与载体 `signal`；非 Remote 调用派生的 Context 上 `ctx.invocation` 为 `undefined`：树中第一个 `bindTypertRemote()` 绑定（每个 `TypertRemoteService` 构造函数都会建立一个）在根上注册该 accessor。Cordis 的跨副本 `Context.is()` 可识别传给构建产物 Service 的源码 Context，因此混合源码／构建组合仍保留此 accessor 和调用局部的 principal。生成的 Client 流方法返回 `RemoteStreamHandle<Out, In>`：在下行迭代之外提供 `send`、`end` 与 `dispose` 的句柄。上行项在 Host 逐项校验，因为它们来自浏览器；下行项是 Host 方法产出的值，原样透传。

`@Remote` 选项仅包含 `name`、`mode` 与下文所述的 `resources` 读取函数；输入策略由消费方选择，而非方法注解。`method.input(options?: TypertRemoteInputOptions)` 返回缓存的 `TypertRemoteValue<Input>`，唯一选项是 `strict?: boolean`。`method.input()` 与 `{ strict: false }` 保留普通 Remote 处理方式：已声明对象接受并剥离未知字段。`{ strict: true }` 递归拒绝未声明字段，而显式 JSON 值和字典键保持开放，字典值仍按声明校验。两种具名参数封装都拒绝额外参数。选择一个视图（`const input = method.input({ strict: true })`），即可通过 `input.create().parse(raw)` 与 `input.jsonSchema` 取得匹配的解析和投影；这不会改变 Host 分发。[生成器](<../generator/README.zh.md#ordinary-remote-metadata>)负责发布及配套 codec。

普通 `./remote` 产物将 `TYPERT_REMOTE` 导出为 `TypertRemoteInfo`，它扩展可挂载的 `TypertRemoteContribution`。类型化的 `methods[endpoint]` 条目就是 `descriptors` 中同一个直接方法描述符对象，并带有派生的 `input(options?)` 和 `invoke(remote, input, signal?)`。参数文档位于 `parameters[].description`；`result` 是唯一的结果 codec、解析器和可选投影。一元描述符省略 `mode`；流使用 `'stream'`。仅使用 Context 接收器的方法保留在 `descriptors` 和作用域声明中，不进入 `methods`。

已发布的纯入口 `@deepseek-ai/dsh-typert-protocol/remote-info` 提供 `createTypertRemoteInfo(spec, z)`，返回类实例而非构造函数。构造时只保留静态 spec 和调用方传入的 Zod 运行时；首次读取 `descriptors` 或 `methods` 时才构建并缓存两者共享的索引。每种输入策略的视图、解析器及可选 JSON Schema 投影都独立惰性求值并缓存；`method.input().create()` 请求普通解析器。原始 spec 要求 Zod factory，而面向消费方的 `TypertSchema<T>` 仅保证 `parse(value: unknown): T`。JSON Schema 来自生成器投影，而非运行时 `z.toJSONSchema()`。纯叶入口没有运行时导入；Zod 由生成产物提供。读取元数据和 schema 绝不发起网络调用；根入口也重新导出该 factory，但会导入 Cordis。

调用器接收调用方拥有、已挂载且无作用域的 Client Remote，并在调用时解析其命名空间方法。它保留命名空间接收者、可选位置参数空位和 signal，不使用 async 包装，直接转发同一个 `Promise<RemoteResult<DecodedOutput>>` 或完整 `RemoteStreamHandle<Output, Uplink>`。`DecodedOutput` 默认采用原始输出类型；生成器仅为含字节的一元方法指定 `RemoteDecoded<Output>`，避免递归重映射普通 JSON 结果；`result.create().parse()` 保留原始输出类型，不会规范化共享字节缓冲区。任一输入变体或结果不支持 JSON Schema 时，文档与解析能力仍然保留；各变体的 `jsonSchemaError` 说明其投影缺失的原因。Registry 读取方使用同一纯入口提供的 `isTypertRemoteMethod(descriptor)`，将基础描述符收窄为这些直接调用能力。

### 识别调用方并放行非 owner 调用方

`PeerScope.principal` 是进程内 Host 代码创建 Peer 时固定的调用方身份；任何 wire 字段都无法设置它，`PeerScope.signal` 则在 Peer scope 结束时中止。`PrincipalMap` 可合并扩展：每个驱动方声明一个 JSON 条目，带唯一的字面量 `kind` 且不含凭据，因为 principal 可能持久化到会话日志中；内置条目是 `owner: { kind: 'owner' }`。在持久输出上记录调用方的 Remote 方法调用 `principalOf(this.ctx.invocation)`：调用方不是 owner 时它返回该 principal，对 owner 以及在 Remote 调用之外返回 `undefined`；方法只在其有定义时写入该字段。

每个 Remote 方法都受访问控制：由 [`dsh-api-remote-access`](../../api/remote-access/README.zh.md) 判定非 owner 调用方能否在该调用触及的资源上调用它。`TypertResourceMap` 与 `TypertLookupMap` 并列、可合并扩展：拥有身份类型的包以 `TypertResource<Id>` 声明自己的资源种类（`dsh-session` 声明 `session: TypertResource<SessionId>`，`dsh-workspace` 声明 `workspace: TypertResource<WorkspaceId>`）。`RemoteAccessResource` 要么是内置、无身份的 `{ kind: 'global' }`，要么是某个已声明种类加其身份；资源之间相互独立，`global` 上的访问不蕴含任何会话上的访问。运行时由拥有该种类的领域经 `typert.resources.register(kind, { field })` 或 `{ resolve }` 登记默认提取规则，该登记拒绝 `global`。默认 resolver 在 lookup 解析前接收 `{ args, parameters }`：已校验的命名 wire 值，以及包含 `name`、`wire` 的有序参数描述；返回身份，无匹配时返回 `undefined`。领域因此可以区分具名身份参数与无关字符串；lookup provider 与 Host Context adapter 经 `resource` 声明其 wire 身份所属的种类，因此带 Agent 查找参数或 Agent 作用域接收器的方法无需选项即携带 `session` 资源。`@Remote` 与 `@RemoteScope` 的 `resources` 选项把种类映射到一个以方法 wire 参数为自身位置参数的读取函数；这些参数的类型从被装饰的方法推断，查找参数映射为其 wire 类型，因此 `@Remote({ name: 'page', resources: { session: request => request.address.sessionId } })` 可以读取默认规则读不到的字段。读取函数与默认规则都未给出资源的调用触及 `global`；它们必须给出方法访问的全部资源，因为访问控制从不检查被遗漏的资源。`TypertForwardableEventEntry` 中的转发 `emit` 条目可以声明 `resources` 读取函数，其类型由该事件自身的参数决定；未声明的条目触及 `global`。资源解析归 [API Gateway](../../api/gateway/README.zh.md)；判定与拒绝原因归 [`dsh-api-remote-access`](../../api/remote-access/README.zh.md)。

### 把 Host 对象与 Context 关联到 wire identity

复杂的 Host 对象不能直接跨 wire 传输。业务包通过可合并扩展的 `TypertLookupMap` 与 `TypertContextMap` 声明关联。Host Context 适配器拥有稳定 wire 声明，并把 wire identity 解析为活跃 Context。Client Context 适配器需要双向映射，因为作用域调用从 Client Context 发起，而转发的 Host 事件要在 Client 侧解析其显式 wire identity。Host 组合可以覆盖其同步或异步解析器。因策略原因拒绝解析的解析器会抛出带有自身错误码的 `RemoteError`，该码原样到达调用方。

Client Context 解析保持同步。`typertOwnedValue(value, release)` 把不抛异常、幂等的清理交给调用 owner；Gateway 在处理器和回复均结束后调用它。借用的 Context 不需要清理包装层。共享的 `TYPERT_OWNED_VALUE` symbol 与 `isTypertOwnedValue` 识别函数可跨独立打包的提供方与 Gateway 使用；包装层自身不会 retain 资源。

### 报告与读取 Remote 失败

所有 Remote 失败都由一个类承载：`RemoteError`，携带稳定的 `<domain>/<reason>` 码，以及按该码定型的 details。本包声明通用载体码（`gateway/bad-request`、`gateway/cancelled`、`gateway/internal`），并拥有 `RemoteErrorDetailsMap`——可合并扩展的码表，其他每个包都在自己的抛出点旁扩展它：

```text
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'goal/not-found': { readonly goalId: string }
  }
}
throw new RemoteError('goal/not-found', `goal "${id}" does not exist`, { goalId: id })
```

拥有方在失败点直接抛出；没有任何包再写错误类家族或出口映射函数。调用方按 `code` 判别——绝不用 `instanceof`——且 `code` 分支无需 cast 即收窄 `details`，因为 `RemoteFailure` 就是 `RemoteError` 实例按码判别的 union。需要识别跨模块或跨 realm 类副本传来的失败时，基础设施调用 `remoteErrorOf(value)`，它读结构标记而不是原型链。

### 在 Client 侧接收转发的 Host 事件

Host 装配以转发给消费方的 Cordis 事件扩展 `TypertRemoteEventSelection`，从而收窄 `ctx.remote.$on` 的键集。`TypertForwardableEvent` 接受无作用域且返回 `void` 的通知，以及最后一个 `next()` 回调返回事件结果类型的异步作用域 waterfall（瀑布式事件）。`TypertClientEventListener` 从同一条 `Events` 成员派生 Client listener，并保留 signal、可选和只读字段、数组、回调与结果类型。`TypertClientRemote` 只公开 `$mount()` 与 `$on()`；事件传输仍由 Gateway 私有持有。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释声明如何保持与编译器无关，以及每个约定在哪里执行；编程模型已在[使用本包](#use-this-package)中说明。

### 设计理念

本包把严格反射留在编译器中：装饰器初始化器把最小标记保存在 Service 原型上的带版本描述符中。描述符使用稳定的字符串属性名，因此协议包的另一个已安装副本也能读取同一组标记。完整的参数、结果、查找与 schema 反射是 Typert 构建流水线的职责，通过 `InvocationDescriptor` 交付。

### Remote 标记

`@Remote` 与 `@RemoteScope` 调度一个初始化器，把方法名、可选导出名、调用模式与冻结的 `resources` 读取函数追加到原型描述符；`remoteMethods(service)` 校验其版本，并返回与已存描述符分离、按声明顺序排列的快照，供 Gateway 的源码模式回退读取。标记要求名称为字符串的公开、非静态实例方法，同一方法上的冲突标记会被拒绝。

读取函数在创建装饰器时校验，并按每次装饰器应用冻结为一条记录；Gateway 按实现成员名从 `remoteMethods(service)` 读取它们，因此协议包的另一个已安装副本也能读取同一记录。

### 协议映射与描述符

可合并扩展的协议映射在类型系统中保留静态关联，运行时提供方则向 `ctx.typert` 注册解析；映射的名称与形状见 [`src/types.ts`](src/types.ts)。`InvocationDescriptor` 是注册表、Gateway 与 Client Remote 共同消费的共享运行时形式，涵盖直接与 Context 接收者、JSON 与查找参数、作用域投影、上行编解码器、取消、结果编解码器与文档。生成的 `TypertRemoteMethod` 对象直接扩展该描述符。

`RemoteInvocation.uplinkWindow` 可选地描述载体完整帧 inbox 的容量，以及紧凑 JSON 项之外的 UTF-8 封装开销。字段缺省表示载体没有编码帧 inbox 限额；消费者仍负责本地缓存与确认策略。

### Wire 标识文法

每个命名空间、方法、查找与 Context 段都必须满足 `isTypertRemoteSegment()`，生成的名字才能原样跨共享 RPC 载体传输。严格编解码器携带生成的 schema factory；`src-json` 编解码器标识约束更弱的源码启动路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 装饰器、Gateway 绑定、`remoteMethods`、段校验 |
| [`src/principal.ts`](src/principal.ts) | `principalOf`：Remote 调用生产者记录的调用方 principal |
| [`src/remote-access.ts`](src/remote-access.ts) | 基于 `TypertResourceMap` 的 `RemoteAccessResource`、`RemoteAccessResourceKind` 与 `RemoteAccessResourceOf` |
| [`src/json-value.ts`](src/json-value.ts) | 各载体共享的无损 JSON 校验 `isRemoteJsonValue` 与 `isRemoteUplinkItem` |
| [`src/remote-error.ts`](src/remote-error.ts) | `RemoteError` 与结构式识别函数 `remoteErrorOf` |
| [`src/remote-info.ts`](src/remote-info.ts) | 纯惰性 info factory 与直接方法类型守卫 |
| [`src/types.ts`](src/types.ts) | 协议映射、`RemoteErrorDetailsMap`、`RemoteResult`、`RemoteStream`、`RemoteStreamHandle`、`PrincipalMap`、`Principal`、`PeerScope`、`RemoteInvocation`、`InvocationDescriptor`、编解码器、提供方约定、注册表接口、`TypertClientRemote` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从声明逐步进入运行时与调用路径。

- [API Gateway 参考](../../../docs/api-gateway.zh.md)——声明如何成为实际的 Host 到 Client 调用。
- [Typert 子系统参考](../../../docs/subsystems/typert.zh.md)——从协议与 Gateway 类型记录的字面公共约定。
- [Typert 注册表](../registry/README.zh.md)——描述符与提供方在运行时存放的位置。
- [Typert 生成器](../generator/README.zh.md)——生成消费方声明与描述符的包。
- [Remote 调用 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)——Remote 调用背后的架构与传输决策。

-----

<a id="model-experience"></a>
## 模型体验

无，因为与编译器无关的 Remote 协议声明不注册任何面向模型的内容。

#### KV Cache 影响

无直接影响；声明的约定只有在装配将其放入请求时才会触及请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明声明能表示什么；它们是当前包约束，不是任务积压。

- **装饰器标记是最小化的**——标记包含方法名、可选的导出别名、流模式、资源读取函数，以及直接或 Context 接收器选择；参数、结果、查找、schema 与文档元数据需要 Typert 构建流水线。
- **Remote 签名受限**——装饰器只接受具有字符串名称的公开、非静态实例方法，源码模式执行无法表示重载、解构、默认参数或剩余参数签名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
