---
description: "面向插件作者与维护者的作用域注册库，用于构建按 agent 或按分组隔离贡献的注册表或事件表面。"
kind: "package-library"
---

# @deepseek-ai/dsh-scope

[English](README.md) | 中文

## 概述

零依赖的 `dsh-scope` 库让注册拥有按 agent 归属的家。用 `createScope(ctx, key)` 创建带标签的上下文，通过它进行的每项注册只在一个作用域内可见，并随该作用域 dispose（资源释放）而撤销；用 `scopeOf(ctx)` 读取上下文的作用域标签；用 `scopeTarget(base, key)` 把带作用域的事件路由到键相同的监听器，同时让无标签监听器保持全局可见。键可以构成父链：子作用域看得见祖先的各层（近者遮蔽远者），标签为祖先的监听器能收到子孙键的事件——反向永不成立。该机制与键的具体含义无关：agent loop（智能体循环）为每个存活的 agent 创建一个作用域，agent preset 的常驻挂载则是其 agent 们的父作用域，但底层包无需依赖两者即可使用。构建必须按 agent 或按分组隔离贡献的注册表或事件表面时，请选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

插件作者使用 `dsh-scope` 为单个 agent（或单个分组）提供独立的注册世界。core 分组中的注册表都构建在它之上——通过 `agent.ctx` 注册的工具只对该 agent 可见——同样的原语也服务于任何自定义注册表或带作用域的事件。

### 创建作用域

`createScope(ctx, key)` 在 `ctx` 的 fiber 下创建作用域：其 `ctx` 携带作用域标签，通过它进行的每项注册既具备作用域可见性，也服从作用域生命周期。`dispose()` 撤销通过该作用域进行的每项注册；`rawDispose` 是确切 Cordis disposer，用于把 teardown 嵌套进有序组合 effect。

```text
const scope = createScope(ctx, agent)
scope.ctx.on('agent/status', ({ agent, status }) => track(agent, status))
// later:
await scope.dispose()   // unwinds every registration made through scope.ctx
```

### 路由带作用域的事件

`scopeTarget(base, key)` 构造带作用域事件分发所用的不透明载体。无标签监听器保持全局；标签为 `key` 的监听器接收该键及其后代的事件。载体只携带路由状态——真实主体由事件参数携带。

### 构建带作用域的注册表层

注册表作者使用 `ScopedLayers`、`NamedEntries` 与 `AnonymousEntries` 持有一个立即构造的全局层加惰性创建的精确作用域层：读取从不创建层，`merge()` 沿作用域链物化按插入序的具名遮蔽，`effect()` 从同一上下文推导可见性与所有权。只有当整个聚合为空时才回收作用域层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

注册上下文同时决定可见性与所有权：通过带作用域上下文进行的注册在该作用域内可见、并随其 dispose，从而防止贡献在一个作用域中可见、却随另一个作用域拆除。该原语用于路由受信任的同进程插件；它不是沙箱或权限边界。交出带作用域的上下文，也会交出创建该上下文的插件的服务解析范围（解析沿创建者 fiber 的依赖链行进），因此作用域应由具备这些带作用域注册所需依赖的插件来创建。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createScope`、`scopeOf`、`scopeTarget`、`bindScopeParent`/`scopeParentOf`/`scopeChainOf`、载体标记 |
| [`src/store.ts`](src/store.ts) | `ScopedLayers`、`NamedEntries`、`AnonymousEntries`、`ScopeLayer` |
| [`src/invariant.ts`](src/invariant.ts) | 基于生成的作用域事件映射的不变式配套 |
| [`src/scoped-events.generated.ts`](src/scoped-events.generated.ts) | 已声明带作用域事件的生成解析器映射 |

### 父链

一个关系支撑两个方向：注册视图沿链**向下**继承（子作用域看得见祖先的各层），事件放行沿链**向上**扩展（标签为祖先的监听器收到分发到后代键的事件）。绑定仅此一次——已有父级的键直接抛错，只有返回的绑定句柄才能重新绑定——且每次链接都拒绝闭环。`scopeChainOf` 返回 `[key, parent, …]`，最近者在前。

### 事件筛选

`scopeTarget` 把基对象的现有 `Context.filter` 与作用域谓词组合起来：无标签监听器放行；有标签监听器仅当标签为分发键或其祖先时放行；`key === undefined` 只放行无标签监听器。带 `{ global: true }` 的监听器绕过筛选。`Scoped<T>` brand 要求带作用域事件以载体作为 `this` 类型，因此用裸主体分发会产生编译错误。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域与设计原理时再阅读以下页面。

- [作用域注册子系统](../../../docs/subsystems/scope.zh.md)——身份、载体与层类型。
- [agent 作用域上下文 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.zh.md)——安全非目标与上下文设计。
- [agent 作用域 runtime 设计 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.zh.md)——循环如何构建按 agent 的作用域。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该原语何时需要特别留意。它们是当前包约束，不是任务积压。

- **只有感知作用域的表层才会隔离状态**：注册表必须按 `scopeOf()` 归档，事件必须通过 `scopeTarget()` 分发；仅仅通过带作用域的上下文调用任意 Cordis 服务，并不会改变该服务仍为上下文全局这一事实。
- **一个上下文只携带一个最近的作用域键**：层级关系存在于键级父关系中而非上下文标签里；嵌套作用域上下文仍遮蔽为单一标签，多成员策略集仍不受支持。
- **服务可达性来自作用域创建者**：交出 `Scope.ctx` 也会交出创建插件注入的服务范围，因此，若作用域创建者提供的服务范围较宽，持有者之后也无法将其收窄。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
