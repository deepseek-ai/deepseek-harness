---
description: "领域数据形式（ctx.storageDomain）：面向在存储后端之上选择、挂载或排查经过 schema 校验、发出变更事件的 KV 领域的宿主与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-domain

[English](README.md) | 中文

## 概述

使用本包声明经过 schema 校验的键值领域，并通过 `ctx.storageDomain` 在已配置的存储后端上打开它们。读取同步返回经过校验的内存状态；每次写入在完成前都已达到持久状态，并按顺序发出 `domain/changed`。产品包使用领域句柄，而不直接访问存储后端。这些宿主侧状态不会添加工具、提示词或会话事件，因此模型与 agent loop（智能体循环）无法看到它们。

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

当宿主包需要持久、经过 schema 校验的记录——工作区记录、会话伴随元数据——时使用本包。由所属包声明一次领域；消费方打开它，即可获得同步读取与持久、发出变更事件的写入，而无需触碰任何后端。

### 何时使用

任何必须跨重启保留、并始终符合 schema 的宿主侧数据都适合它：领域数据形式在打开时校验每条已存记录，且每次写入在 resolve 前都已持久。当数据属于会话事件日志时请避免使用它——那是会话持久化 seam 的领域。

### 声明领域

所属包用 `defineDomain` 声明一次领域——名称、版本与 zod 记录 schema——并导出它。名称非法、版本不是非负整数、或全局 schema 接受 `null` 时，`defineDomain` 会在模块加载时明确报错。

```text
// Owning package, once:
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})
```

### 打开并使用领域

消费方通过 `ctx.storageDomain` 打开已声明的领域并持有返回的句柄；读取是同步的，写入是持久的：

```text
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

调用方拥有句柄的生命周期，并在功能关闭时用 `domain.close()` 释放它（通常作为其自身的 `ctx.effect` 资源释放函数）；插件卸载时，设施会关闭仍处于打开状态的领域。

### 把领域路由到后端

哪个后端服务哪个领域由领域插件的配置决定——绝非枢纽。`backend` 指定默认路由；`routes` 按领域名覆盖。路由到未注册后端的领域会在打开时以 `backend-not-found` 明确报错。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backend` | 必填 | 未显式路由的每个领域的默认后端名称 |
| `routes` | `{}` | 逐领域覆盖：领域名称 → 后端名称 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-storage-domain)是所有受支持字段及其 JSDoc 的完整真源。

### 可观察行为与失败

每次写入都要等后端确认已持久化后才完成，并按写入顺序各发出一次 `domain/changed` 事件。失败携带稳定的 `DomainError` 代码：`already-open`（名称已打开或仍在关闭）、`facet-unsupported`（已路由后端不提供 `kv` 分面）、`invalid-record`（已存记录或全局不符合其 schema，并指明表与键）、`missing-key`（对不存在的记录执行 `update`）与 `closed`（关闭后的任何使用）。`version-mismatch` 等后端失败会原样透传。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

领域层是单一实现，而非抽象化的 seam：消费方依赖本包、绝不直接触碰后端，这把所有领域逻辑——schema 校验、写入串行化、变更事件——集中在一处，而不是在每个后端重复一遍。

### 设计理念

- **spec 对象是唯一真源。** `defineDomain` 固定 spec 的字面类型，并在所属包的模块加载时、任何介质被触碰之前校验其字段。记录 schema 使用 zod，因此 `z.infer` 可避免重复定义消费方类型；插件 `Config` 仍由 schemastery 负责。
- **内存具有最终决定权；介质是持久投影。** 读取同步取自经过校验的内存状态。每次写入都在每个领域一条的写入链上排队：先到达后端持久状态，再变更内存，然后发出 `domain/changed`——被拒绝的后端写入不会触碰内存，因此读取永远不会与介质分叉。
- **每个领域一条写入链。** `put`、`delete`、`update` 与 `global.set` 都在其上排队；`update` 的变换在链上自己的槽位运行，因此并发更新绝不会交错。记录是普通不可变数据——返回值就是已存对象本身，绝不能原地修改。
- **写入在提交点之后发出。** `domain/changed` 是通知，不是事务参与者：监听器抛出异常时，系统会隔离该异常并记录警告，而不会让已经持久的写入被拒绝。

### 打开顺序

`DomainFacility.open(spec)` 按严格顺序执行，任一步骤失败都会让整个调用失败：拒绝已打开或仍在关闭的名称（`already-open`）；解析路由（`backend-not-found`）；要求 `kv` 分面（`facet-unsupported`）；打开单元（后端 `version-mismatch`／`malformed-medium` 透传）；加载并根据 spec 的 schema 校验每条已存记录与全局（`invalid-record`）；构造领域。调用方持有句柄；设施会在卸载时关闭任何仍打开的领域，已关闭领域的名称只在资源销毁完成后才能重新打开。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`DomainFacility`、路由、`Config`、数据形式挂载 |
| [`src/spec.ts`](src/spec.ts) | 领域声明：`defineDomain`、`domainTable`、描述符投影 |
| [`src/domain.ts`](src/domain.ts) | 已打开领域的运行时：写入链、表与全局句柄、关闭 |
| [`src/events.ts`](src/events.ts) | `domain/changed` 事件词汇 |
| [`src/error.ts`](src/error.ts) | `DomainError` 代码 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：每条 `domain/changed` 与内存状态一致 |

### 不变式

`storage-domain-invariant` 伴生插件注册这条所属关系：每条 `domain/changed` 事件在发出时都必须与所属领域的权威内存状态一致——出现分叉意味着某条写入路径跳过了写入链或发出了陈旧值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当领域层视角不够用时阅读以下页面：子系统参考是权威约定，Agent Note 记录了设计与延期工作。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——领域约定、后端约定、变更事件与生成的 API。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——领域为何存在、workspace 消费方，以及跨进程变更推送等延期工作。
- [Workspace 子系统](../../../docs/subsystems/workspace.zh.md)——领域数据形式的第一个消费方。

-----

<a id="model-experience"></a>
## 模型体验

### 持久领域状态

#### 模型看到什么

无。本包不注册工具、不注入提示词，也不追加会话事件；它在 `ctx.storageDomain` 后面存储非会话数据，只发出进程内 `domain/changed` 事件。只有消费方通过自身有文档说明的接口渲染该事件时，它才会到达模型。

#### Token 影响

为零：本包的文本不会进入任何模型请求。

#### KV Cache 影响

相互独立：领域读写绝不触碰请求前缀，因此这里没有任何内容能使提供方缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明领域层何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **变更只在单进程内可见**——`domain/changed` 是进程内事件；在跨进程修订模式落地前，第二个主机进程或重新连接的 GUI 无法观察变更（[Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)）。
- **没有跨表事务、二级索引或多段键**——每次写入只触碰一条记录；这些扩展列在 Agent Note 的范围外清单中。
- **没有数据迁移**——领域的已存版本与 spec 不同时，打开操作会被拒绝（`version-mismatch`）；修改 schema 需要手工迁移已存数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
