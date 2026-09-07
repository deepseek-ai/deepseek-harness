# Agent Note: 拆分会话投影状态与客户端视图

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-session-projection-state-and-client-views.md) | 中文

## 问题

投影注册表会持久化各单元的内部折叠状态，却没有运行时 schema；与此同时，`SessionProjectionMap` 描述的是 `view` 返回的客户端值。这使恢复出的状态未经校验，也让同一张类型表看似同时描述两种可能不同的值。host 消费方还需要读取当前折叠状态，但不应为此序列化全部已注册客户端视图，也不应把内部状态暴露到客户端协议。

## 决策

`SessionProjectionStateMap` 是 host 折叠状态的 merge-extensible 类型表。每个 `ProjectionDefinition` key 都属于此表并提供 `stateSchema`；缓存行只有通过校验后才能为折叠提供初始状态。`SessionProjectionMap` 保留原有名称和语义，继续作为唯一的客户端可见全量值类型表，因此 `title: string | null` 等既有客户端数据结构保持不变。

如果一个单元的 key 也存在于 `SessionProjectionMap`，该单元就提供 `wire.viewSchema` 与 `wire.view`。每个单元的状态都会写入检查点——client-visible 与 host-only 一视同仁；`persist` 选择项已移除，任何单元都不能悄悄跳过持久化缓存。快照 API 只枚举带 `wire` 的定义，因此漏传受众标记也无法让内部状态进入 API 载荷。host 代码通过 `stateOf(session, key)` 读取一份当前状态；返回的是借用引用，不得修改。

## 结果

投影状态和客户端值分别获得类型与校验，同时不引入第二套客户端 DTO 词汇。单元可以保留更丰富的 host 状态，并暴露紧凑或兼容既有结构的客户端值。畸形缓存状态不能为 `viewCheckpoint` 提供数据；恢复会拒绝畸形状态，并由缓存既有的全量读取回退从日志重建。host 消费方可以用同一套增量折叠替换私有日志扫描，而载体快照无法枚举 host-only 状态。

原始 [session-projection 提案](../../proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)已记录这次拆分。既有的 [subagent 身份投影](2026-08-06-subagent-list-identity-projection.zh.md)与[投影化 token 用量](2026-07-29-projected-token-usage-and-request-context.zh.md)决策仍然有效；其中的领域折叠迁入状态表，不改变面向用户的值。

## 考虑过的替代方案

- **把既有类型表改名为状态表，再引入新的客户端类型表**——不予采用，因为这会改变已经确立的客户端类型名称，并导致不必要的客户端载荷迁移。
- **继续用一张类型表同时描述状态与客户端值**——不予采用，因为这样无法准确表达更丰富的折叠状态和保持兼容的客户端值。
- **host-only 单元按需选择持久化**——不予采用：`persist` 标志会让单元悄悄跳过持久化缓存，而省下的（每会话一行小记录）永远不值得这种不对称或它带来的 stateVersion 困惑。每个单元的状态统一写入检查点。
- **让 `stateOf` 返回状态副本**——不予采用，因为每次 host 读取都克隆会增加工作，却没有保护任何边界；该方法为同进程类型化调用方明确规定只读借用引用义务。
