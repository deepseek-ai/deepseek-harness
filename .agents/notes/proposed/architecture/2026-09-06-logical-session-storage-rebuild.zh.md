# Agent Note: 逻辑会话与存储重建

Status: proposed

[English](2026-09-06-logical-session-storage-rebuild.md) | 中文

## 问题

会话消费方依赖具体事件日志类、实时会话注册表、投影注册表与持久化句柄。这些依赖混合了逻辑会话行为、发布、存储与物理格式职责。因此，新的会话或存储实现会要求修改消费方、agent loop、持久化、查询、遥测与前端代码。

该重构必须先建立一条稳定访问路径，才能安全替换实现。第一个阶段必须让消费方脱离具体 `Session` 类，同时不改变对象身份、事件值、发布顺序、持久化字节或模型输出。

## 提案

使用两个应用协议与一个私有提供方协议。`LogicalSession` 表示一个逻辑会话：一个有身份的事件会话，独立于其事件的存储与发布方式。`SessionService` 创建、打开、发布、查找、fork 并 flush 逻辑会话，而且拥有投影端口注册。`SessionStorage` 是服务背后的物理提供方接口；它拥有持久会话数据、修订、格式迁移、崩溃修复、批处理与跨进程写入器租约。

以堆叠阶段构建该变更。每个阶段要么保持可观察行为，要么明确命名一个行为变化。兼容名称仅在后续阶段仍有真实消费方且具备明确移除条件时保留。

[开发者迁移](2026-09-10-session-developer-transition.zh.md)给出操作伪代码与贡献路径；[能力协议](2026-09-10-session-capability-protocols.zh.md)说明 storage、projection 与 query，并包含整体架构图；[历史数据兼容](2026-09-10-session-data-compatibility.zh.md)说明用户迁移；[FAQ](2026-09-10-session-refactor-faq.zh.md)解释命名和进度。

## 阶段 1：唯一公开逻辑会话接口

阶段 1 是整个重构的入口。它的四个实现子阶段完成后，每个生产消费方都持有 `LogicalSession`。具体 `Session` 类及其静态构造器作为 deprecated 源码兼容入口继续服务外部开发者，现有内存实现仍是消费方持有的会话对象。该阶段改变内部依赖方向，不改变运行时行为。

### 公开模型

`LogicalSession` 暴露生产消费方已经使用的逻辑会话操作。它拥有会话身份、不可变创建元数据、fork 谱系、事件位置、经验证的追加、不可变事件读取、有序 surface，以及派生请求与消息视图。

```text
abstract class LogicalSession {
  abstract readonly header: SessionHeader
  abstract readonly inheritedEventCount: SessionLogOffset
  abstract readonly firstLiveSeq: SessionLogOffset
  abstract get seq(): SessionLogOffset
  abstract get surface(): SessionSurface
  get id(): SessionId

  abstract append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
  ): SessionEvent<T>

  abstract eventAt(seq: SessionSeq): SessionEvent | undefined
  abstract snapshotEvents(from?: SessionLogOffset, toExclusive?: SessionLogOffset): readonly SessionEvent[]
  ownEvents(): readonly SessionEvent[]
  isOwnSeq(seq: SessionSeq): boolean
  abstract requestHeader(): EpochHeader | undefined
  abstract requestContext(): RequestContext | undefined
  abstract deriveMessages(): Message[]
  deriveEventMessage(event: SessionEvent): Message | null
}
```

抽象成员允许另一种实现选择不同的日志表示。具体成员只依赖这些抽象成员，因此所有实现共享身份、所有权与派生视图语义。

实时会话仍来自 `ctx.sessions`。无需发布即可验证、查询或检查日志的代码使用 `createLogicalSession` 或 `restoreLogicalSession`。这些函数返回游离会话，不会注册它们或发出实时会话事件。

### 阶段 1 的子阶段

计划是评审入口。实现子阶段分离接口定义、构造、消费方迁移与兼容性验证，使每次评审只有一个主张。

| 阶段 | 结果 |
| --- | --- |
| 1.1 | 定义所有权模型、不变量、完整阶段 1 设计与后续阶段方向。 |
| 1.2 | 增加 `LogicalSession` 与一个可切换的静态门禁：记录具体类绑定，在切换为拒绝之前以警告报告新增绑定。 |
| 1.3 | 增加游离构造函数，并迁移生产静态构造器调用方。 |
| 1.4 | 将存储、事件、agent、投影与全部生产消费方改为 `LogicalSession`。 |
| 1.5 | 迁移测试，保留 deprecated `Session` 兼容入口，并完成阶段 1。 |

### 各阶段进度

| 阶段 | 状态 |
| --- | --- |
| 1 | 草稿完整。 |
| 2 | 草稿完整。 |
| 3 | 基于阶段 2；实现与远程 CI 完成，保持草稿。 |
| 4–5 | 尚未完成。 |
| 内存 provider 抽取 | 后续把现有实现封装为可替换 provider。 |

### 不变量

阶段 1 保持以下行为。后续阶段也必须保持这些事实，除非其提案明确命名并测试某项变化。

- `append` 保持同步。它先验证再变更，分配连续序号，冻结已接受事件，并在提交后隔离观察者失败。
- `session/created` 保持同步发布否决语义。`session/event`、`session/disposed` 与 `session/flush` 保持现有顺序和参与语义。
- 存储返回的会话对象必须与其注册并提供给监听器的对象完全相同。任何包装层都不得替换该身份。
- 对相同输入日志，会话 header、fork 谱系、`firstLiveSeq`、派生请求状态、消息历史与序列化事件值保持不变。
- 游离构造绝不进入实时注册表或发布实时事件。
- JSONL 字节、格式版本、迁移、崩溃修复、批处理与写入器租约行为保持不变。

### 执行门禁与完成条件

`verify-logical-session-access` 报告所属包之外的生产代码对具体 `Session` 类的绑定。其执行强度可切换：签入默认为 `warn`，此时门禁把每项发现打印为警告、为每项发现写入一条 GitHub Actions `::warning` 注解并以 0 退出，使仍绑定该类的分支在其消费方迁移期间可以合并；`DSH_LOGICAL_SESSION_ACCESS=enforce` 使门禁在单次运行中对任何发现失败，而在没有进行中的分支再绑定该类之后把签入默认改为 `enforce`，门禁即拒绝每一处剩余绑定。该包仅为外部源码兼容保留公开类与静态构造器。仓库生产代码没有允许列表并统一使用 `LogicalSession`；兼容测试持续验证旧导入与构造器，直至后续独立移除决策给出生态证据与发布边界。

当生产代码仅使用公开逻辑会话接口与游离构造函数、deprecated `Session` 入口只有专门兼容测试而无生产消费方、访问门禁没有迁移允许列表、生成的 API 文档已更新，并且快照与 SDK 输出保持不变时，阶段 1 完成。

## 目标架构

阶段 1 建立逻辑访问接口。后续阶段把构造与发布移入 `SessionService`，把持久化拆分为 `SessionStorage` 下的读取器与写入器角色，在逻辑会话背后挂接存储与投影，并删除桥接名称。

```text
consumers ──► LogicalSession
                  │
                  ├── logical events and projections
                  ├── fork, flush, and close
                  └── attached storage reader or writer

composition ──► SessionService ──► LogicalSession implementation
                       │
                       └──────────► SessionStorage implementation
```

该依赖方向是刻意设计。应用组件依赖 `LogicalSession` 与 `SessionService`，而非 `SessionStorage`、内置内存实现、JSONL、投影注册表、迁移、搜索索引或前端状态。`SessionService` 选择并协调物理提供方；每个物理实现向内依赖它实现的私有协议。

### 所有权规则

| 问题 | 所有者 |
| --- | --- |
| 该操作是否读取或变更一个逻辑会话、其日志、header、投影或生命周期？ | `LogicalSession` |
| 该操作是否构造、发布、枚举、fork、flush 或 dispose 实时会话？ | `SessionService` |
| 该操作是否拥有字节、修订、物理布局、迁移、修复、批处理或写入器租约？ | 仅在 `SessionService` 背后使用的 `SessionStorage` 提供方。 |
| 该操作是否精确读取、跨会话过滤、全文检索、trace 或读取统计？ | `SessionQuery`，由 projection/provider 提供可重建读模型。 |

### 后续阶段

| 阶段 | 结果 | 必须保持的兼容边界 |
| --- | --- | --- |
| 2 | `SessionService` 拥有会话构造、发布、查找、fork 协调、flush 与存储挂接。 | 现有事件顺序、种子持久化与关闭时序保持不变。 |
| 3 | `SessionStorageReader` 与 `SessionStorageWriter` 取代联合类型持久化句柄；JSONL 实现该协议。 | 存储字节、修订、迁移预备、批处理与租约保持不变。 |
| 4 | 逻辑会话拥有实时写入器入队与投影读取；后端停止订阅实时会话事件。 | 写入器与监听器失败会被一同等待，并使用已记录的优先级。 |
| 5 | 移除内部桥接别名与派生视图快捷方式；agent loop 只接纳一次未发布的 fork 会话。 | fork 身份、发布交错、清理、快照与 SDK 输出保持验证。 |

持久化策略、迁移编排、遥测、会话加载与前端展示仍是消费方。精确读取、搜索与统计统一通过 `SessionQuery`；title、summary、统计与搜索文档由 `SessionProjectionPort` 生成。

## 兼容性与非目标

该堆叠不改变已发布的 Session JSONL 格式、协议值、TypeScript 或 Python SDK 输出，也不改变模型可见历史。它不增加第二个存储后端或第二种逻辑会话实现。它只建立未来增加任一实现时无需修改消费方的依赖方向。

该提案保留已交付的[基于句柄的持久化决定](../../implemented/architecture/2026-08-27-handle-based-session-persistence.zh.md)、[仅 JSONL 持久化决定](../../implemented/simplification/2026-08-30-jsonl-only-session-persistence.zh.md)、[写入器租约决定](../../implemented/feature/2026-08-31-cross-process-session-write-lease.zh.md)与[只读迁移预备](../../implemented/architecture/2026-09-05-read-only-session-migration-preparation.zh.md)。新协议只重新分配这些职责，不会削弱它们。

## 参考资料

- [会话子系统](../../../../docs/subsystems/session.zh.md)定义已交付的会话 API 与事件语义。
- [会话持久化子系统](../../../../docs/subsystems/persistence.zh.md)定义已交付的持久格式与生命周期。
- [`@deepseek-ai/dsh-session`](../../../../packages/core/session/README.zh.md)拥有会话包约定。
- [`@deepseek-ai/dsh-session-persistence`](../../../../packages/session/session-persistence/README.zh.md)拥有当前持久化服务约定。

## 考虑过的替代方案

**在接口阶段中替换实现。** 拒绝，因为类型迁移与生命周期迁移需要不同证据。阶段 1 在改变依赖方向时保持完全相同的会话对象与行为。

**立即暴露宽泛的服务或存储 facade。** 拒绝，因为基线尚未把每项生命周期与持久化职责分配给唯一所有者。后续阶段只增加具备生产消费方和特征化证据的成员。

**迁移仓库调用方后立即删除 `Session`。** 拒绝，因为这会破坏外部开发者兼容性，却不会进一步改善仓库依赖方向。阶段 1 保留 deprecated 兼容入口，同时由访问检查禁止仓库生产代码使用；移除需要后续独立兼容决策。

**从清单而非已打开会话恢复继承元数据。** 拒绝，因为清单无法提供恢复会话所需的精确继承事件切点。

## 验收条件

- 阶段 1 以 `LogicalSession` 作为推荐会话类型，保留 deprecated `Session` 源码兼容性与会话对象身份，并使可观察行为与序列化输出不变。
- 每个后续阶段都具备一个所有权结果、明确的兼容限制、针对性特征化测试与可独立回退的提交边界。
- 所有生产应用组件只使用 `LogicalSession` 与 `SessionService`；只有服务实现与物理提供方包使用 `SessionStorage` 及其读取器或写入器角色。
- 内置内存会话实现与 JSONL 存储可以成为可替换实现，而无需修改搜索、统计、持久化策略、迁移编排、会话加载或前端消费方。
- 每个阶段都在同一 PR 中更新其所属 Agent Note、子系统参考、包文档、生成目录与所需双语对侧文件。

## 风险

薄抽象可以在保持类型安全的同时隐藏生命周期缺口。尤其在 `SessionService` 拥有发布与挂接之前，替代逻辑会话实现无法参与；同步 disposer 也不得启动无人等待的异步关闭。

如果实现把读取器当作陈旧快照、丢失继承元数据、改变批处理，或在持久性完成之前释放写入器租约，存储分离会丢失保证。约定测试必须覆盖新鲜度、关闭持久性、迁移预备与跨进程所有权。

fork 接纳可能创建重复注册表项，或重排 `session` 与 `agent` 的发布。后续 fork 阶段必须向 agent loop 转移一个未发布会话，保持对象身份，并在设置失败时关闭它。
