# Agent Note: One Remote failure vocabulary for ctx.remote

Status: implemented

[English](2026-08-28-ctx-remote-failure-vocabulary.md) | 中文

## Problem

每个 Remote owner 包各自维护一套失败面：一个 `XxxErrorDetailsMap` 接口、由它派生的 `XxxError` union，以及一个出口映射函数，把域内错误类（`UnknownPresetError`、`PresetMountError`、`SessionTitleInvalidError` 等）翻译成 wire 失败值。`@deepseek-ai/dsh-typert-protocol` 同时携带两个失败类——owner 主动上报用 `TypertRemoteFailure`，lookup resolver 产生的用 `TypertLookupFailure`——而 `@deepseek-ai/dsh-client-connection` 又保留了第二份 typed 视图 `RpcErrorDetailsMap`，把 `agent-preset-not-found`、`session-not-found` 这类域码硬编码进载体层。

于是一个码同时存在三处：owner 的表、载体的 typed 视图、以及消费方为窄化而写的 union 或 cast（`result.error as SessionError`）。新增一个域码要改三处，跨域转述一个别人的码则要把对方的码复制进自己的表——`SessionErrorDetailsMap` 就收编了 `agent-preset-*`、`subagent-*`、`workspace-not-found` 五个他域码。

失败信息也在两处被压平。Gateway 自己的 17 个装配失败（未挂载的方法、歧义 endpoint、lookup provider 不匹配、结果未过 codec 等）一律以 `code: 'internal'` 上 wire，client 无法把装配 bug 与业务拒绝区分开；owner 又出于防御把无关异常预折成自己的域码，于是一个真正的 Host bug 会以一个看起来合理的域失败到达调用方。

Host 固定事实同样绕过了 `ctx.remote`：Host home 取自 `(ctx.get('connection') as ConnectionHandle).generation.getSnapshot()?.host.home`，任何只需要一条固定事实的页面都得注入载体并理解它的 generation store。

## Decision

`@deepseek-ai/dsh-typert-protocol` 导出唯一的失败类 `RemoteError<Code>`：一个真 `Error`，带只读 `code` 与 `details`、结构标记 `isDSHRemoteError`，以及标准 `ErrorOptions`（`cause` 只在进程内有效）。码与 details 的对应关系收进一张 merge-extensible 的 `RemoteErrorDetailsMap`；`RemoteFailure` 是按码分布的实例 union，`RemoteResult<T>` 形状不变。

```text
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  readonly isDSHRemoteError: true = true
  constructor(readonly code: Code, message: string,
    readonly details: RemoteErrorDetailsMap[Code], options?: ErrorOptions)
}
export type RemoteFailure = { [C in RemoteErrorCode]: RemoteError<C> }[RemoteErrorCode]
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }
```

失败点直接 `throw new RemoteError(code, message, details)`。域内不再建错误类家族，也不再写出口映射函数；只有「把任意 provider 异常归类」这一种场景保留一个 `catch`，并在其中 `throw new RemoteError(code, messageOf(error), details, { cause: error })`。进程内仍需消费的既有异常类（`ApiSessionCwdConflict` 等）保留为不导出的私有类，在出口一行转成 `RemoteError`。

码是 `<语义域>/<理由>` 形式的字符串：`session/not-found`、`gateway/cancelled`、`workspace/invalid-path`、`agent-preset/locked`。前缀与 wire namespace 同风格，读者从码本身就能看出它属于谁，跨域转述时也不再需要一个别扭的无前缀名。

## Code ownership

一个码只有一个声明处，落点由「谁生产它」和「声明对谁可达」共同决定——声明合并只在增补文件进入当前 program 时生效，所以正家必须是每个生产者都能看见的包：

- **载体码**：`gateway/bad-request`、`gateway/cancelled`、`gateway/internal` 由 protocol 声明，人人可达。
- **Gateway 装配码**：17 个 `gateway/*` 由 `packages/api/gateway/src/remote-error-codes.ts` 声明，details 统一为 `TypertGatewayFaultDetails { endpoint, field? }`；该模块 face-neutral，Host 与 Client 两面各自 import，因此两个 program 看到同一批条目。
- **跨包共产**：两个及以上不同包抛同一个码时，声明落到双方都已依赖的最低层。`session/not-found` 落 `@deepseek-ai/dsh-session`（session-controller 与 workspace-controller 都依赖它），`workspace/not-found` 落 `@deepseek-ai/dsh-workspace`（session-controller 与 workspace-controller 之间没有依赖边，能力包是唯一共同下层）。
- **单一生产者**：只有一个包抛的码落生产者包。`subagent/not-found` 与 `agent-preset/conflict` 因此落 session-controller——全仓只有它抛这两个码，subagent 与 agent-presets 的码表里都没有它们。

共享的是校验逻辑，不是码。`session/invalid-time-zone` 与 `subagent/invalid-time-zone` 是两个域各自声明、各自抛出的两个码，两个端点共用 `@deepseek-ai/dsh-util-time` 的 `canonicalClientTimeZone()` 做规范化；client 对这个码没有分支语义，拆码的成本是零，而合成一个码就会重新制造可达性问题。

## Discrimination by code

判别一律读 `code`，从不用 `instanceof`。Client 与 Host 是两个独立打包的 program，worker 传输还会把页面侧再分一次包，因此同一个类会存在多份副本，跨副本的原型链身份不成立。机制层用 protocol 的 `remoteErrorOf(value)` 读结构标记加一个字符串 `code`，Gateway client face 另外导出 `isRemoteFailure(error)` 供消费方在 catch 里判别；两者都只看这两个字段、不看类——连 `instanceof Error` 都不要求，因为另一个 realm 抛出的 Error 同样通不过它。

业务代码通常连这两个函数都不需要：`RemoteResult` 的 `ok: false` 分支已经是类型化的 `RemoteFailure`，`if (result.error.code === 'session/not-found')` 就把 `details` 窄化到该码的形状，无需 cast。需要向上抛的站点直接 `throw result.error`——它是真 `Error`，栈与 `message` 都成立。

client 面不构造 `RemoteError`：唯一例外是 Gateway 的 client face 本身，它在 `invoke()` 里按 wire 数据重建实例、在流边界把载体 throw 折进同一词汇。测试替身要构造失败值时从 `@deepseek-ai/dsh-client-test-runtime` 取 `RemoteError`，而不是让 client 包值引入 protocol。断言用 `toMatchObject` 判 code（必要时加 details 字段）：`RemoteError` 是 `Error`，own key 集合与旧字面量不同，`toEqual` 会失败。

## Fixed Host facts

`ctx.remote.$host` 暴露两条固定事实：`home: string | undefined` 与 `isLoopback: boolean`。它是 Client Remote service 上的 getter，读的是 service 构造期取得的 connection 句柄——`home` 来自 generation 快照的 ready frame（ready 之前是 `undefined`），`isLoopback` 来自载体。没有 store、没有订阅、没有 generation 计数器。

重连后的刷新走既有信号：Client Remote 在连上时 emit `connection/reset`，需要重取的消费方监听它或各域自己的 remote event，而不是让 `$host` 变成一个可订阅对象。因此消费方不再注入 `connection`：`@deepseek-ai/dsh-client-connection` 的消费白名单收缩到 hmr、frontend-static、bundle/web-app、session-log-export、webworker-runtime、gateway 与 api-remotes 装配。

## What the wire carries

envelope 不变：wire 上仍是 `{ code, message, details }` 数据，`RemoteError` 是两端各自的进程内载体。Host 侧 `rpcFailure()` 收敛为两分支——结构识别出的 `RemoteError` 原样编码，其余折成 `gateway/internal`；载体信号取消也走同一词汇（`RemoteInvocationCancelled` 类整体删除，四个 throw 点改抛 `RemoteError('gateway/cancelled', …)`）。

三条 wire 可见行为随之确定。Gateway 的 17 个装配码按语义上 wire，client 因此能把「方法未挂载」与「业务拒绝」分开处理。owner 不预折无关异常：未归类的 throw 交给 Gateway 折一次 `gateway/internal`，诊断串保留在 `message` 里。client 一元调用被调用方 abort 时答 `gateway/cancelled`，即使本地 throw 抢在 wire 往返之前赢得竞争，也与 Host 会给出的码一致。

载体层只保留开放的 wire 形状。`@deepseek-ai/dsh-client-connection` 的 `ConnectionRpcFailure`/`ConnectionRpcResult` 不含任何域码知识，其 `transportError()` 产出 `gateway/internal`；typed 视图的正家从此只有 protocol 的 `RemoteFailure`。

## Alternatives considered

**每域一套 `RemoteFault` 错误类家族。** 让每个域（或每个码）有自己的 `Error` 子类，看起来更 OO，但它把「码」这一条信息拆成了类身份加字段两处，跨 realm 又只能退回判字段——于是类身份成为纯粹的负担：每个域要维护子类、导出它、在文档里解释它，而消费方仍然只能判 code。单类加一张码表把这份重量换成了一行声明。

**在调用点加 `attempt` / `unwrap` / `remoteFailureOf` 包装函数。** 包装能让调用点少写一个 `if`，但它把 `RemoteResult` 这个 canonical 形状变成了「先过一层库函数」，两种风格会长期并存；`unwrap` 还会把「失败是正常结果」重新变成异常流，与 Remote 面不 reject 的契约背道而驰。被保留的 `remoteErrorOf` 只服务机制层与测试断言，业务代码拿到的要么是已类型化的 `result.error`、要么是自己抛的，不需要它。

**`host/updated` 事件加订阅式 `$host` store。** 订阅能在 Host home 变化时自动刷新，但 home 与 isLoopback 在一条连接内是固定事实，为它引入 store、generation 与订阅生命周期，等于让每个只想读一次的页面都承担一套状态管理。重连是已有信号（`connection/reset`），业务失效走各域 remote event，固定事实保持普通值读取。

**把不上 wire 的本地失败也纳入码表。** 例如 ui-goal 的 `no-current-goal`：它从不跨进程，纳入码表会让共享词汇混入只有一个 client 包关心的条目，还会误导读者以为它有 wire 语义。本地失败保持各自的本地类型，码表只描述 Remote 词汇。

## Consequences

新增一个域码是一处 declaration merging 加一个 throw：不再有映射函数、错误类、载体 typed 视图三处联动。代价是落点需要判断——正家必须对每个生产者可达，而这条判断只有在真的出现第二个生产者时才显现；`workspace/not-found` 就是这样从 workspace-controller 迁到能力包的，并为此给 `@deepseek-ai/dsh-workspace` 加了一条 type-only 的 protocol 依赖。

码字符串带前缀后，wire 字符串整体变化，connection fixture 内嵌的码、host 与 client 两侧断言、spec 本地 declare 一次性同步。发布前阶段接受这次一波切；发布后同样的改名需要一个兼容期。

`details` 的类型由码决定，因此码与 details 的搭配错误在编译期就被拒。反面是每个抛点都要给全 details 的必填字段：protocol 把 `gateway/bad-request` 的 `issues` 设为可选，正是为了让没有 codec issues 的业务校验点仍然只写 `{}`。

`RemoteError` 是 `Error`，所以它进任何日志与 `errorChain()` 都保留 `message` 与 `cause`；但 `cause` 只在进程内成立，wire 上只有 `code`、`message`、`details` 三个字段。跨 realm 的判别永远读结构标记，任何新增的传输（worker、bundle 分片）都必须把标记或等价的 marker 帧带过去，否则失败值会退化为普通 `Error`。

Remote 方法的消费端签名统一为 `Promise<RemoteResult<T>>`，与[方法调用面](2026-08-02-typert-remote-method-calls.zh.md)描述的生成投影一致；一元调用的迁移账本见[一元端点迁移](../../archived/architecture/2026-08-10-unary-apiproxy-remote-migration.md)。
