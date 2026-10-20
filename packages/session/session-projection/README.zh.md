---
description: "面向开发者与维护者的会话投影注册表说明，用于向客户端载体提供日志派生逐会话状态的完整当前值，或维护驱动约定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection

[English](README.md) | 中文

## 概述

当客户端需要当前的逐会话状态（例如待办事项、目标或对话统计）而不应自行重放原始事件日志时，使用 `dsh-session-projection`。领域根据已提交的会话事件定义同步投影，客户端则通过快照与变更通知接收经过 schema 校验的完整 JSON 值。快照标明所有返回值共同反映到的最后一个事件，因此载体可以把状态与对应的历史切面配对。投影状态可以通过检查点加快冷读，而仅供 host 使用的投影不会暴露给客户端。

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

当领域保存客户端应看到、但不应自行重新派生的状态——todo 清单、goal 快照、对话统计——时选择本包。注册表在已提交事件上主动驱动单元，因此任何已注册单元的值按构造即为当前值。不带 `wire` 块的单元将状态保留在 host。领域所有者在插件依赖中声明 `sessionProjections`，并等待注册完成后才提供同步服务方法。其他插件通过所属服务调用这些方法。

### 定义投影单元

领域为每个状态键贡献一个 `ProjectionDefinition`：一个 key、状态 schema、初始状态、同步折叠 `apply(state, event)`、可选的 `wire` 块（把状态投影为客户端视图），以及状态字段或折叠语义变化时递增的 `stateVersion`：

```text
const definition = {
  key: 'todo',
  stateSchema: todoStateSchema,
  stateVersion: 1,
  init: (_header, _inheritedEventCount) => ({ items: [] }),
  apply: (state, event) => event.type === 'todo/upsert'
    ? { items: event.data.items }
    : state,
  wire: {
    viewSchema: todoViewSchema,
    view: state => ({ items: state.items }),
  },
}
```

`init(header, inheritedEventCount)` 同时接收轻量元数据与精确的 fork 继承切点；它不得从 `firstLiveSeq` 或 `session/end-seed` 推断该切点。`apply` 必须同步，且对与单元无关的事件必须返回同一个状态引用——引用不变意味着零下游工作。注册表用 `Object.is` 比较相邻的 `wire.view` 原始结果；对象或数组 view 若要在仅内部 state 变化时抑制发布，就必须复用引用，结构相同的新对象仍算变化。携带状态的日志事件必须携带变更后的完整状态，绝不携带裸增量。

### 注册与读取

`await register(definition)` 从 `stateSchema` 推导宿主状态类型，安装单元，并返回提供同步 `stateOf(session)` 读取和 `dispose(): Promise<void>` 的 handle。等待 `dispose()` 完成即可释放注册；重复调用是安全的。具有相同 key 和 `stateVersion` 的注册方共享 cell；版本不兼容或非法时注册会拒绝。注册归调用方 fiber 所有。最后一个注册方注销后，单元退出全局事件驱动、快照、检查点和变更通知。已有 handle 仍可读取：它保留原有单元，按需折叠新增的 Session 事件，即使同一 key 后来注册了其他版本也不受影响。读取 handle 不会初始化无关单元，也不会重新注册。载体用 `snapshot(session)` 读取一致的客户端视图切面，用 `onChanged(listener)` 订阅已注册单元的变更。

```text
const todoProjectionHandle = await ctx.sessionProjections.register(definition)
const state = todoProjectionHandle.stateOf(session)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)
```

持有投影状态的领域将 `sessionProjections` 声明为 Cordis 服务依赖，并在内部保留句柄。消费方注入该领域服务并使用其方法，例如 `ctx.agents.turnBoundaryOf(session)`，无需导入定义或保留投影读取句柄。可选贡献方可以在 `ctx.inject(['sessionProjections'], …)` 下注册。载体使用 `ctx.get('sessionProjections')`，注册表缺席时省略自己的块或帧。

<a id="deprecated-plugin-compatibility"></a>
### 已弃用的插件兼容接口

`register(definition)` 的公开返回类型保持为 `Promise<ProjectionHandle<S>>`，但运行时值是可调用的 thenable，并非原生 `Promise`（`typeof` 为 `"function"`，`instanceof Promise` 为 false）。等待它会得到保留的句柄，调用它则通过原有 Cordis effect disposer 释放注册。调用返回值的用法已弃用；新代码使用 `handle.dispose()`。API 要求原生 Promise 或把函数视为回调时，包括 Vitest 的 Promise 断言，使用 `Promise.resolve(registration)`。参见[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/session-projection-handles/guide.zh.md)。

旧的同步 `return register(...)`、`ctx.effect(() => register(...))` 和同步生成器 yield 保留原有清理所有权。通过异步函数返回注册值时，thenable 会被吸收为句柄，Cordis 会以 `Invalid effect` 拒绝它。在异步生成器中 yield 注册值同样只会得到句柄：该 effect 在释放时以 `Invalid effect` 失败，且从不接管该注册；插件保持激活，其 fiber 在卸载时释放该注册。异步插件和 effect 等待注册完成后返回 `void`；所属 fiber 会自动释放注册。

旧的 `stateOf(session, key)` 已弃用，返回类型为 `unknown`。读取已注册的键时，它会将所有已注册单元的状态计算到 Session 当前游标，不生成无关的客户端视图。未注册或已完全释放的键返回 `undefined`，保留的句柄则仍可读取。兼容范围限于运行时调用；TypeScript 消费方仍需迁移类型声明。

每个 registry 实例对每个键的首次旧式 `stateOf(session, key)` 读取输出一次 `ctx.logger.warn` 弃用警告。注册、调用其返回值、句柄方法和 owner 清理不产生警告。

定义同步安装，句柄交付保持异步。注册错误使返回值拒绝。当前宏任务及其微任务结束前没有调用方观察该拒绝时，registry 将其记录为错误，而不留下未处理的拒绝，插件保持激活；发生键冲突后，其按键读取返回另一注册方的状态；owner 已不在加载或激活状态的拒绝会被丢弃。新插件在提供读取操作前等待注册完成。同步 `try/catch` 无法捕获异步注册错误。

### 持久检查点

系统通过 `checkpoint(session)` 为每个单元的状态创建检查点，client-visible 与 host-only 一视同仁；同级包 [session-projection-cache](../session-projection-cache/README.zh.md) 持久化这些检查点，使冷读跳过全量日志加载。检查点水位使用 `SessionSeqCursor`（空日志为 `-1`），回放起点使用 `SessionLogOffset`；`restoreFloor` 与 `restore` 实现读取流程，且不会混淆已有事件与日志间隙。

### Session 摘要

Session 摘要包含每个已注册客户端视图，但排除 `SessionProjectionMap` 条目（非空值）带 `SessionProjectionSummaryExcluded<T>` 标记的 key。`summaryKeys()` 返回该集合，从实时注册派生；在注册或注销改变 key 表之前，它保持同一实例。摘要消费方把它传给既有的带 key 读取面 —— 实时 cell 用 `cachedSnapshot(session, keys)`，checkpoint 行用 `viewCheckpoint(rows, keys)`，持久化缓存用 `cachedSnapshot(header, keys)` —— 这些读取面把 Set 视为已选好的集合，因此不存在摘要专用读取面、每次读取无需复制，集合也只有一处定义。由于集合由注册表派生，摘要消费方无法通过该集合请求被排除的 key；完整读取面仍会按显式命名的 key 提供值，打开的 Session 因此保留全部取值。列表行携带的是摘要投影，绝不是全量投影。

标记决定客户端视图类型，`wire.summary` 决定运行时键集合，省略即 `true`。map 条目带标记的 key 应声明 `wire.summary: false` 以保持一致；该字段就是普通布尔值，而不是类型层的互锁。可空条目把 `null` 放在包装之外（`SessionProjectionSummaryExcluded<TodoItem[]> | null`），以便首次写入前的值仍可表达。当前被标记的 key 是 `turnOutline`、`sessionStats`、`todos` 和 `imageLimits`：outline 随整份日志增长，列表行不渲染统计或 todo 清单，而图片上限是每个 Session 共享的同一个宿主级启动常量。

摘要服务于 Session 列表行，列表无需打开 Session。`@` 引用同样以列表方式枚举 Session，但只通过带 key 的 `snapshot(session, keys)` 与 `cachedSnapshot(header, keys)` 读取其 `title` 和 `subagent` 标签 key。`snapshot`、`cachedSnapshot` 和 `viewCheckpoint` 在不传 key 子集时仍返回每个 wire key，因此打开的 Session 仍会收到全部投影值。

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
| [`src/types.ts`](src/types.ts) | 可合并扩展的 客户端 `SessionProjectionMap` 类型表，以及摘要排除标记及其派生的视图与摘要类型 |

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

- **只有带 key 子集的读取才省略 key；尾页仍携带每个客户端可见 key，也不存在惰性逐值请求**——摘要只省略那些 `SessionProjectionMap` 条目带有 `SessionProjectionSummaryExcluded<T>` 且注册声明了 `wire.summary: false` 的 key。该 opt-out 按 key 生效，不按值生效：没有任何读取会延后加载单个大值。
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
