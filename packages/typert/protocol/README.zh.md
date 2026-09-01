---
description: "共享的 Typert Remote 协议：业务包、生成产物、Host Gateway 与 Client API 使用的装饰器、wire 描述符、编解码器与提供方约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-typert-protocol

[English](README.md) | 中文

## 概述

借助 `dsh-typert-protocol`，业务包可以向 Remote 客户端暴露 Host 方法：用 `@Remote`（作用域接收者用 `@RemoteScope`）标记方法，把服务绑定到 wire 命名空间，并通过可合并扩展的协议映射把 Host 对象与作用域 Context 关联到 wire identity。生成产物、Host Gateway 与 Client API 消费同一套调用描述符、编解码器与提供方约定，因此一套声明在每个 face 上保持一致。本包不注册任何 Cordis 服务，也不运行 TypeScript 分析；它只声明类型与装饰器标记。

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

### 把 Host 对象与 Context 关联到 wire identity

复杂的 Host 对象不能直接跨 wire 传输。业务包通过可合并扩展的 `TypertLookupMap` 与 `TypertContextMap` 声明关联。Host 与 Client Context adapter 都把 `Context` 映射为 wire identity，也把该 identity 映射回 `Context`；Host adapter 还拥有稳定 wire 声明。Host 组合可以覆盖其同步或异步 resolver。因策略而拒绝的 resolver 抛出带自有码的 `RemoteError`，该码原样到达调用方。

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

Host 装配以转发给消费端的 Cordis 事件扩展 `TypertRemoteEventSelection`，从而收窄 `ctx.remote.$on` 的键集。`TypertForwardableEvent` 接受无作用域且返回 `void` 的通知，以及最后一个 `next()` 回调返回事件结果类型的异步作用域 waterfall。`TypertClientEventListener` 从同一条 `Events` 成员派生 Client listener，并保留 signal、可选和只读字段、数组、回调与结果类型。`TypertClientRemote` 只公开 `$mount()` 与 `$on()`；事件传输仍由 Gateway 私有持有。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释声明如何保持与编译器无关，以及每个约定在哪里执行；编程模型已在[使用本包](#use-this-package)中说明。

### 设计理念

本包把严格反射留在编译器中：装饰器初始化器把最小标记保存在 Service 原型上的带版本描述符中。描述符使用稳定的字符串属性名，因此协议包的另一个已安装副本也能读取同一组标记。完整的参数、结果、查找与 schema 反射是 Typert 构建流水线的职责，通过 `InvocationDescriptor` 交付。

### Remote 标记

`@Remote` 与 `@RemoteScope` 调度一个初始化器，把方法名、可选导出名与调用模式追加到原型描述符；`remoteMethods(service)` 校验其版本，并返回与已存描述符分离、按声明顺序排列的快照，供 Gateway 的源码模式回退读取。标记要求公开、非静态、具名字符串的实例方法，同一方法上的冲突标记会被拒绝。

### 协议映射与描述符

可合并扩展的协议映射在类型系统中保留静态关联，运行时提供方则向 `ctx.typert` 注册解析；映射的名称与形状见 [`src/types.ts`](src/types.ts)。`InvocationDescriptor` 是注册表、Gateway 与 Client Remote 共同消费的共享运行时形式，涵盖直接与 Context 接收者、JSON 与查找参数、作用域投影、取消与结果编解码器。

### Wire 标识文法

每个命名空间、方法、查找与 Context 段都必须满足 `isTypertRemoteSegment()`，生成的名字才能原样跨共享 RPC 载体传输。严格编解码器携带生成的 schema；`src-json` 编解码器标识约束更弱的源码启动路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 装饰器、Gateway 绑定、`remoteMethods`、段校验 |
| [`src/remote-error.ts`](src/remote-error.ts) | `RemoteError` 与结构式识别函数 `remoteErrorOf` |
| [`src/types.ts`](src/types.ts) | 协议映射、`RemoteErrorDetailsMap`、`RemoteResult`、`InvocationDescriptor`、编解码器、提供方约定、注册表接口、`TypertClientRemote` |
| — | 不发布运行时不变量伴生入口；decorator 只保留私有不可变声明，binding 也是冻结值，没有可供交叉核对的独立事件流。 |

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

- **装饰器标记是最小化的**——标记只包含方法名与直接调用或 Context 调用模式；参数、结果、查找与 schema 反射需要 Typert 构建流水线。
- **Remote 签名受限**——装饰器只接受具有字符串名称的公开、非静态实例方法，源码模式执行无法表示重载、解构、默认参数或剩余参数签名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
