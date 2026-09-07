---
description: "面向用户与维护者的持久会话存储 seam 说明，用于选择持久化后端、恢复会话，或按共享服务约定构建后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence

[English](README.md) | 中文

## 概述

`dsh-session-persistence` 持久存储会话的事件日志，并通过一个逐会话句柄寻址每个已存储会话：后端无关服务（`ctx.sessionPersistence`）暴露 `create`/`open`/`stat`/`list`，`create`/`open` 返回承载全部日志读写与单写者所有权的 `SessionHandle`。持久化单元就是现有 `SessionEvent` 日志——不存在另一套并行的存储消息类型——不可回放的元数据（格式版本、工作目录、血缘、种子边界）作为 `SessionHeader` 单独传输。后端拥有自己的存储，seam 拥有语义：仅追加的连续日志、以显式 `flush` 持久性屏障托底的尽力而为 append、绝不到达读取方的撕裂物理尾部、失败即关闭的存储记录校验，以及进程内排除第二个写入方。挂载随产品交付的 [JSONL 后端](../session-persistence-jsonl/README.zh.md)（每个会话一份产物），agent-loop 就会持久化并恢复会话，loop 与模型无需知道下面是哪个后端。

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

挂载一个持久化后端即可让会话持久化。后端把自己注册为 `ctx.sessionPersistence`，并把每个已发布会话的实时事件路由进该会话的活跃写句柄；agent-loop——会话在生产环境中的发布点——在发布之前获取每个会话的写句柄，因此组合中的其他部分不变。

### 选择后端

seam 随产品交付 [JSONL](../session-persistence-jsonl/README.zh.md) 后端。它把每个 Session 存为一份仅追加 `.jsonl.zstd` 产物。第三方后端可以直接实现该服务；必须遵守的[后端约定](#understand-the-implementation)见下文。

### 服务提供什么

挂载后端后，五个服务方法寻址已存储会话：

```text
const handle = await ctx.sessionPersistence.create(header)     // store a new session, take write ownership
const handle = await ctx.sessionPersistence.open(id, 'write')  // claim single-writer ownership of an existing session
const reader = await ctx.sessionPersistence.open(id, 'read')   // observe without ownership
const snap = await ctx.sessionPersistence.stat(id)             // header + revision (+ eventCount / sizeBytes) without a log read
const all = await ctx.sessionPersistence.list()                // one snapshot per visible stored session
await ctx.sessionPersistence.flush()                           // backend-wide durability barrier over every active write handle
```

服务级 `flush()` 排空每个活跃写句柄已路由的事件并把其会话实体化，效果与各句柄自己的 `flush` 完全相同；失败按会话聚合为一个 `AggregateError` 而不中途放弃清扫，清扫途中被关闭的句柄视同已 flush，因为 close 本身会持久排空。

每一次日志读写都流经返回的 `SessionHandle`；不存在按 id 寻址的 append 或 load 方法。`handle.read(offset?, length?)` 返回 `{ eventState, events }`：外层 slice 属于调用方，`eventState` 则区分独占的 `detached` event graph 与可能同时保存在 backend cache 中的 `shared-frozen` graph。该状态由生产者建立，slice 即使为空也会保留原状态。两种状态都能直接接管而无需复制；需要修改 event 的 consumer 必须先 clone。Read 绝不包含撕裂尾部，同一句柄上的重复读取绝不会观察到比先前读取更旧的状态，写句柄也能读到自己成功的 append。`handle.append(events)` 追加一个连续批次，其第一个 `seq` 等于已存储 next-seq；完成时的持久化是尽力而为的——批次被接受、有序，并对同一后端实例上的读取可见，只有完成的 `flush` 才承诺它在崩溃后依然存在（交付的 JSONL 后端恰好会立即持久化每个批次）。`handle.flush()` 是持久性屏障，同时把空的已创建会话实体化，使其可被持久列出。`handle.close()` 幂等且不可取消：读句柄释放本地资源；写句柄完成待处理的持久化并释放写所有权。一旦某次 `append` 或 `flush` 完成，其后在同一后端实例上开始的读取——无论经由任何句柄，还是经由 `stat`/`list`——至少能观察到该前缀。

### 所有权与可见性

`create` 与 `open(id, 'write')` 取得进程内单写者所有权：在持有者活跃期间第二次以写模式打开会以 `SessionAlreadyOwnedError` 拒绝，对已占用 id 执行 `create` 会以 `SessionAlreadyExistsError` 拒绝，在 `read` 句柄上执行修改会以 `SessionReadOnlyError` 拒绝——一种句柄类型，运行时拒绝。对已关闭句柄的任何操作会以 `SessionHandleClosedError` 拒绝，`SessionOwnershipLostError` 标记写所有权已永久丢失的写句柄（关闭并重新打开）。已创建的会话自 `create` 完成之刻起即可在本进程内被观察到，而后端可以把物理实体化推迟到第一次 `append` 或 `flush`；其他进程只能看到已实体化的会话，一个在崩溃前从未实体化的会话等于从未存在。

### 实时写路径与关闭排空

实时写路径由后端自持：它一次性安装会话监听器，把每个已发布会话的事件按 id 路由到该会话的活跃写句柄——`session/event` 复制进有界的内部批处理窗口，`session/flush` 是即时的持久性与错误观察屏障，`session/disposed` 执行最终排空并关闭句柄。没有活跃写句柄的已发布会话不做任何持久化。后台写入失败时按序保留其事件、暂停自动路径并记入日志；下一次显式 flush 会重试并响亮地拒绝。`close()` 本身会先经由仍然打开的存储排空路由缓冲区再释放所有权，因此即便根 fiber 的 dispose 并发运行各 fiber 的 disposer，后端 teardown 的关闭清扫也能保证应用关闭不丢数据。

### 恢复与崩溃恢复

持久化返回物理上有效的日志；语义修复属于读方。中途崩溃的会话保留其未闭合的最终轮次——单个轮次可能很大，而这些事件在崩溃前已持久追加；只有从未确认的撕裂尾部中不完整的碎片会被丢弃——从中恢复的完整记录由写路径在句柄的第一次新 append 之前持久重写。恢复（agent-loop）通过其写句柄读取已存储日志，计算 `interruptedTurnClosers`——合成 `tool/result` 错误、任何未闭合的 `step/end`，以及 `turn/end {interrupted}`——并把它们作为普通批次通过同一句柄追加。只读观察方（session-query）仅在内存中用同样的 closer 配平被中断的冷日志。

### 失败与恢复

当前构建无法忠实解读的存储日志会以方向感知的错误被拒绝，绝不错读。`SessionHandle` 只暴露当前逻辑 v1 记录；provider 必须在返回句柄前转换任何受支持的历史存储，随产品交付的 JSONL provider 会通过静态 catalog 迁移已发布 v0。更高格式会要求操作者升级 harness。本构建不认识的事件类型会被拒绝，除非其信封标记为 `ignorable`；已提交前缀中的损坏以 `SessionPersistenceCorruptionError` 拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明 seam 如何实现持久存储以及后端如何接入；可观察约定见[使用本包](#use-this-package)与生成的 [Cordis API](../../../docs/subsystems/persistence.zh.md#cordis-surface)。

### 设计理念

本包是 seam，而不是后端框架：它只导出抽象 `SessionPersistence` 服务、`SessionHandle` 约定、消费方捕获的稳定 error 类、纯函数的存储记录校验辅助（`storage-contract`）以及带品牌类型的 revision——再无其他。每个 provider 拥有自己完整的存储运行时（句柄类、修改排序、单写者记账、实时事件路由、teardown），`tests/` 下的两套共享测试套件——`runPersistenceContract` 与 `runLiveWritePathContract`——钉住每个 provider 都必须一致的可观察行为。有意为之的后果：各 provider 在存储恰好相似之处可以彼此相像，但没有任何实现机制跨越包边界。

### 每个后端必须遵守的不变量

- **仅追加，连续 `seq`。** 已提交事件绝不重写；`append` 的第一个 `seq` 必须等于已存储 next-seq，缺口会被拒绝。
- **撕裂的物理尾部绝不到达读取方。** 它属于一次从未完成的 append；写路径在第一次新 append 之前将其持久截断。
- **无损 JSON 数据。** 批次与 header 经过共享的单遍校验并快照边界（`materializeAppendBatch`/`materializeCreateHeader`）；无法序列化的载荷在调用处被拒绝。
- **持久性。** `append` 尽力而为地持久化；`flush`——逐句柄或服务级——是承诺存储并同时把空会话实体化的屏障。
- **失败即关闭的读取。** `validateStoredEvents` 拒绝未知事件词汇与已废弃的预发布形态；`assertVersion` 拒绝外来格式版本。
- **每个后端实例单写者。** provider 的进程内认领在 `create`/`open('write')` 时取得，在句柄关闭时释放。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `SessionPersistence` 服务与重新导出的 seam 词汇 |
| [`src/handle.ts`](src/handle.ts) | `SessionHandle` 约定：read/append/flush/close 语义与新鲜度规则 |
| [`src/storage-contract.ts`](src/storage-contract.ts) | 共享校验：版本门、失败即关闭词汇表、批次实体化、连续性 |
| [`src/errors.ts`](src/errors.ts) | 稳定的句柄/所有权失败与格式拒绝 |
| [`src/revision.ts`](src/revision.ts) | 带品牌类型的不透明修订值 token |
| — | 不发布运行时不变式伴生入口；持久化正确性需要后端往返与崩溃尾部测试；本包不暴露可持续观察的进程内关系。 |

### 写入路径概览

写入器会话的每个 `session/event` 都复制进该句柄的内部缓冲。第一个待处理事件开启固定批处理窗口；后续事件加入但不重置截止时间。窗口到期后经由句柄的修改链排空待处理前缀；排空期间接纳的事件按顺序合并进下一个链上的批次。`session/flush` 取消等待并排空至完全停稳，随后运行 `handle.flush()`，因此 loop 在下一轮次前把它用作排序与错误观察检查点。被拒绝的后台排空保留其事件并暂停自动计时器；显式 flush、写入器 close 或后端 teardown 会立即重试并响亮地拒绝。构造 seed 事件绝不发出 `session/event`，因此发布前通过句柄追加的 seed 绝不会被重新入队。

### 存储记录校验

seam 的共享辅助函数校验当前逻辑 v1 记录，append 只写当前格式（[理由](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)）。历史解码与不可变后继发布属于各 provider 内部，并在其返回句柄前完成。每个后端都在句柄读取与写 open 预热时运行 `storage-contract` 校验，把未知事件类型作为 `SessionFormatUnsupportedError` 拒绝，把 malformed 当前记录作为 `SessionPersistenceCorruptionError` 拒绝，并在后端为每个会话保留一份产物时附上原始日志的 `SessionLocation`。

</details>
-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享持久性模型逐步进入随产品交付的后端与决策证据。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——完整服务约定、句柄语义、flush 检查点、崩溃恢复与生成的 Cordis API。
- [基于句柄的持久化 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.zh.md)——seam 设计及其所有权模型。
- [JSONL 持久化后端](../session-persistence-jsonl/README.zh.md)——随产品交付、按会话存储文件的后端。
- [会话检查点策略](../session-checkpoint-policy/README.zh.md)——在语义边界上经由 `session/flush` 刷新的插件。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

seam 不添加提示词或 schema。恢复会将已存储的表层事件还原为消息历史；已存储请求 header 重建较早调用，新 loop 则为下一次请求组合当前系统提示词、工具与会话前缀。崩溃修复将没有持久调用的 assistant 请求标记为 `TOOL_NOT_STARTED`；有持久调用但无结果时变为 `TOOL_OUTCOME_UNKNOWN`，其文本允许模型重试只读或幂等工作，但要求验证副作用或询问用户，而不是盲目重试。

#### Token 影响

普通持久化期间为零 token。恢复后会重新计入保留历史的 token 用量，并照常计入当前请求 envelope 的 token 用量；每个已修复调用都会增加一段以引用形式保留的错误文本。

#### KV Cache 影响

持久化不修改实时请求前缀。只有当重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加，不重写较早历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定 seam 保证的终点。它们是当前包约束，不是任务积压。

- **写所有权仅限进程内**——provider 的写入器表只在单个后端实例内排除第二个写入方；持久的跨进程租约是计划在同一句柄形态上叠加的下一层，在它落地之前另一进程不得写入同一会话。
- **在有活跃会话时重载后端插件会使其写入器响亮地失败**——重载后的后端无法服务旧实例签发的句柄；写入会持续失败直到会话重启，没有任何机制静默重新接管日志。
- **只有通过句柄获取的会话才会持久化**——仅靠 `ctx.sessions.create` + `session/flush` 不存储任何内容；agent-loop 是生产环境的获取点，测试通过 `create`/`append`/`close` 播种存储。
- **无删除或保留接口**——剪枝已存储会话属于带外后端维护。
- **`list()` 无分页且无过滤**——它返回每个已存储会话的快照；适合本地存储，大规模时无索引。
- **合成 closer 是唯一崩溃方案**——恢复通过写句柄追加 `interruptedTurnClosers`；没有继续中断轮次而不先关闭它的部分轮次恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
