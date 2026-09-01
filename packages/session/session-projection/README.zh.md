---
description: "面向开发者与维护者的会话投影注册表说明，用于向客户端载体提供日志派生逐会话状态的完整当前值，或维护驱动约定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection

[English](README.md) | 中文

## 概述

`dsh-session-projection` 向客户端载体提供日志派生的逐会话状态的完整当前值——历史尾页与 `session/projection` 推送帧：一个注册表（`ctx.sessionProjections`）把每个已提交会话事件折叠到已注册投影单元并对外提供所得值。领域注册一个纯计算单元（初始状态、对事件的折叠与可选客户端视图）；框架负责订阅、驱动与变更通知，因此领域不持有任何订阅，客户端收到的是成品值，绝不自行折叠事件。每个被提供的值都是经 schema 校验的纯 JSON，逐单元 `stateVersion` 锚定持久缓存的失效。当客户端需要派生的逐会话状态——todo 清单、goal 快照、对话统计——而不想自己折叠原始日志时，选择本包。

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

在客户端载体需要日志派生会话状态的当前值处挂载 `dsh-session-projection`。领域插件注册单元；载体读取快照并订阅变更流；两侧互不相识。

### 何时选择

当领域保存客户端应看到、但不应自行重新派生的状态——todo 清单、goal 快照、对话统计——时选择本包。注册表在已提交事件上主动驱动单元，因此任何已注册单元的值按构造即为当前值。当维护的是无客户端读取的 host-only 记账时跳过：不带 `wire` 块的单元保持 host-only。host 读取方要么在插件 `inject` 中声明 `sessionProjections`，要么在注册表或必需 key 缺席时明确失败。贡献方可以继续通过 `ctx.inject(['sessionProjections'], ...)` 保持可选注册。

### 定义投影单元

领域为每个状态键贡献一个 `ProjectionDefinition`：一个 key、状态 schema、初始状态、同步折叠 `apply(state, event)`、可选的 `wire` 块（把状态投影为客户端视图），以及状态字段或折叠语义变化时递增的 `stateVersion`：

```text
const definition = {
  key: 'todo',
  stateSchema: todoStateSchema,
  stateVersion: 1,
  init: () => ({ items: [] }),
  apply: (state, event) => event.type === 'todo/upsert'
    ? { items: event.data.items }
    : state,
  wire: {
    viewSchema: todoViewSchema,
    view: state => ({ items: state.items }),
  },
}
```

`apply` 必须同步，且对与单元无关的事件必须返回同一个状态引用——引用不变意味着零下游工作。注册表用 `Object.is` 比较相邻的 `wire.view` 原始结果；对象或数组 view 若要在仅内部 state 变化时抑制发布，就必须复用引用，结构相同的新对象仍算变化。携带状态的日志事件必须携带变更后的完整状态，绝不携带裸增量。

### 注册与读取

`register(definition)` 安装单元；注册是挂在调用方 fiber 上的 effect，因此卸载领域即移除其 key。载体用 `snapshot(session)` 对每个客户端可见单元读取一致的同步切面——`{ asOfSeq, values }`，其中 `asOfSeq` 是所有值共同反映到的最后一个事件的 seq——并用 `onChanged(listener)` 订阅逐变更通知。`stateOf(session, key)` 读取一个单元的主机状态，不计算无关视图。

```text
const dispose = ctx.sessionProjections.register(definition)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)
```

### 持久检查点

每个单元的状态都会被检查点化——client-visible 与 host-only 一视同仁——通过 `checkpoint(session)`，同级包 [session-projection-cache](../session-projection-cache/README.zh.md) 持久化这些检查点，使冷读跳过全量日志加载。`restoreFloor` 与 `restore` 在无活动会话的情况下实现读取配方（缓存状态加正向尾部回放）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明驱动机制与单元约定；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

本包是能力 seam 的 Service Definition 与驱动角色：框架负责驱动，领域负责计算。注册表只订阅一次 `session/event`；每个已提交事件都会主动经过每个已注册单元的 `apply`（cell 在首次触达时惰性构建）。第一层 `Object.is` 闸门在 state 引用不变时跳过 view 工作；live drive 的双槽缓存复用前一个原始 view，第二层 `Object.is` 闸门在原始 view 引用不变时抑制发布。载体在切出页面切片的同一 tick 内读取 `snapshot()`，`asOfSeq` 之所以是一个一致切面正系于此；误写成异步的 view 会返回 Promise，并被 `wire.viewSchema.parse` 拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SessionProjectionRegistry` 服务、`ProjectionDefinition`、快照与检查点机制 |
| [`src/types.ts`](src/types.ts) | 可合并扩展的 `SessionProjectionMap` 与 `SessionProjectionStateMap` 类型表 |
| — | 不发布运行时不变式伴生入口；同步纪律由 schema parse 强制。 |

### 驱动与检查点流程

一个已提交事件按注册顺序驱动每个已注册单元；原始 view 通过 `Object.is` 判定为变化的客户端可见单元会以经 schema 校验的视图与致因 seq 通知变更流。live drive 保留前后两个原始 view；snapshot 与冷读仍是彼此独立的完整读取。`checkpoint(session)` 为持久缓存返回每个单元一份独立的 `(key → {ver, seq, val})` 行；`restoreFloor` 把尾部读取锚定在最低可用水位之前一个事件处，使缩短的日志可被检出；`restore` 把持久行在存储后缀上重新折叠，丢弃任何 `ver` 不匹配或声称越过存储末尾的行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从单元约定逐步进入读模型子系统与持久缓存。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——投影单元约定、驱动语义与生成的服务 API。
- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——投影折叠其上的事件日志。
- [会话投影缓存](../session-projection-cache/README.zh.md)——让冷读跳过全量日志加载的持久检查点。
- [会话包映射](../README.zh.md)——相邻的持久化、标题与遥测包。
- [会话投影 RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)——投影与命令日志的设计理由。

-----

<a id="model-experience"></a>
## 模型体验

无——注册表只为已入日志的会话状态提供面向客户端的读模型，不注册任何模型可见内容。

#### KV Cache 影响

无；投影从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明投影注册表在大规模下何时需要特别处理。它们是当前包约束，不是任务积压。

- **每个尾页携带每个 client-visible key**——尚无逐 key 的 opt-out 或惰性 key 请求形状；在值都是 UI 量级的全量状态时可以接受，若某领域的值变大再重议。
- **单元表是进程级的，因此 key 是否存在不能当作逐会话的能力信号**——任何 agent preset 注册的 key 都会出现在每个会话的快照里；客户端必须读值，不能把 key 缺席当作功能缺席。
- **主动驱动逐事件触达每个单元**——按构造开销很低（全量值规则与 state/view 引用闸门），但若出现热点路径，可加按单元的事件类型预过滤。
- **注册表 cell 只活在内存里**——重启后首次触达时靠折叠日志重建；挂载了 `dsh-session-projection-cache` 的组合改由持久行播种该折叠。
- **单元同步纪律只有部分可机械把关**——`wire.viewSchema.parse` 能拒绝返回 Promise 的 view，但阻塞的 `apply`、或读取撕裂的非会话状态的 `apply`，只能靠评审把关。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
