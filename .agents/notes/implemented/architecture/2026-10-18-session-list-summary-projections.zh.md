# Agent Note: Serve Session-list rows from a summary key set

Status: implemented

[English](2026-10-18-session-list-summary-projections.md) | 中文

## Problem

Session 列表行携带每个已注册的客户端视图。其中四个视图从不被行渲染：整份日志的 turn outline、整份日志的会话统计、当前 todo 清单，以及宿主级的图片上限。outline 随 Session 日志增长，因此列表响应会随语料规模与日志长度增长，而没有一行展示它。从列表省略取值需要一条规则同时守住 wire 与客户端类型：摘要消费方不能取得被省略的键；被省略的值仍要送达打开的 Session；owning package 不得与驱动省略的声明漂移。

## Decision

Session 摘要就是每个已注册客户端视图，减去 `SessionProjectionMap` 条目带摘要排除标记的键。

- [`packages/session/session-projection/src/types.ts`](../../../../packages/session/session-projection/src/types.ts) 声明类型层标记 `SessionProjectionSummaryExcluded<T>`，它基于一个从不导出、运行时从不存在的 unique symbol。`SessionProjectionViewValue<T>` 以分发方式去掉标记，可空条目因此保留 `null`；`SessionProjectionSummaryExcludedKey` 取非空部分判断；`SessionProjectionSummaryValues` 是全部视图值减去这些键。
- 每个 owning package 只包装自己的 map 条目：`turnOutline`（session-turn-outline）、`sessionStats`（session-stats）、`todos`（tool-todo），以及 `imageLimits`（session-controller 的启动常量附件上限，每个 Session 共享）。todo 条目写作 `SessionProjectionSummaryExcluded<TodoItem[]> | null`，因为与 `null` 求交会吞掉 null 成员。
- 注册用普通布尔值承载同一决定：`wire.summary` 表示 Session 摘要是否包含该单元，省略即 `true`。map 条目带标记的 key 声明 `false`，让运行时键集合与客户端视图类型一致。标记本身没有运行时表示 —— `wire.view` 与 `viewSchema` 的签名已用 `SessionProjectionViewValue` 去标记，因此 `register` 里的擦除只是放宽状态类型。
- [`packages/session/session-projection/src/index.ts`](../../../../packages/session/session-projection/src/index.ts) 提供 `summaryKeys(): ReadonlySet<key>`，从实时注册派生，只有新键注册或某键最后一个注册者注销时才重建。`cachedSnapshot`、`viewCheckpoint`、`snapshot` 接受 `ProjectionKeySelection`（`readonly Key[] | ReadonlySet<Key>`），传入 Set 时直接使用。
- [`packages/session/session-projection-cache/src/index.ts`](../../../../packages/session/session-projection-cache/src/index.ts) 原样转发该选择，[`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) 把 `summaryKeys()` 传给 live 与 cold 两个缓存读取面。`cachedPredecessorTitle` 保持只读 title。
- 客户端只有类型变化：`SessionSummary.projectionValues` 收窄为 `Partial<SessionProjectionSummaryValues>`，而 `SessionProjectionSnapshot.values` 保留全部视图值。wire 字段、函数名与 UI 名称均不变；打开的 Session 仍通过 `session/follow`、控制基线与 `session.projections` 收到每个键。

估算效果：当 outline 在投影负载中占主导时，四个键估计占几百个 Session 时列表响应的约三分之二 —— outline 单项约 57%，统计与 todo 合计约 5%，共享的图片上限约 5% —— 占传输压缩后同一响应的约 85%，因为 outline 的唯一文本几乎无法压缩，而其余键可以。

## Alternatives considered

**为每个来源各做一个摘要专用读取面**（checkpoint 行的 `viewSummaryRecord` 与实时 cell 的 `cachedSummarySnapshot`）。否决：摘要键集合会由两个读取面及其调用点各定义一次，而调用方仍可向完整读取面传显式键。派生集合加既有带键读取面只保留一处定义、一条代码路径，且每次读取无需复制键。

**在 session controller 里硬编码被排除键清单。** 否决：清单会与 owning package 漂移，且包改名或新增一个大值时没有任何检查会失败。

**先构建完整块再按键过滤。** 否决：逐行的 state 解析与 view 工作仍会发生，而且 wire 类型会继续声称被排除键存在。

**让每个投影主动选择加入摘要。** 否决：这反转了当前默认，需要改动每个 owning package，并且某包忘记加入时新的大键会被静默地从摘要中漏掉。

**为大投影做按值惰性读取。** 否决：行根本不需要这些值，逐行延迟一个值会引入列表从未有过的请求形状与加载态。

## Consequences

换来的：列表响应不再随 outline 长度或日志数量增长；摘要消费方无法通过派生集合取得被排除的键（完整读取面仍按显式键提供）；从列表行的类型读取被排除键是类型错误。`wire.summary` 是普通布尔值，因此让带标记的键保持 `false` 是注册方自己的责任，而不是编译错误。

列表行携带的是摘要投影，绝不是全量投影：它只承诺摘要键集合，不承诺更多。已连接 Session 的客户端 store 可能因 control/follow 基线持有更多值，但那不属于列表契约，不得从行上读取；打开的 Session 自身的基线保留全部取值。

本次没有升级指南记录该变更。外部可感知的部分在 wire：`session/list` 行不再携带四个键，读取 `projectionValues.turnOutline` 的客户端类型不再编译。迁移方式是改读打开的 Session —— 其 `session/follow` 初始快照、`session/control` 基线或 `session.projections` 读取 —— 它们保留全部投影值；包 README 与子系统页写明了该规则。

付出的：`ProjectionKeySelection` 是新的公开签名类型，`ReadonlySet` 也需加入 catalog 的 foundation 类型；`summaryKeys()` 有两个失效点（新键、最后一个 disposer），未来的注册路径不得漏掉；摘要键集合与单元表一样是进程级的，某个 preset 排除的键对所有 Session 都排除；可空值不能直接标记 —— 它的 `null` 必须留在包装之外。

## Testing

- [`packages/api/session-controller/tests/summary-list.host.spec.ts`](../../../../packages/api/session-controller/tests/summary-list.host.spec.ts)：列表行的键等于注册表完整快照减去被标记的键；`session/follow` 初始快照仍携带它们且值相等；连续两次拉取不会重新加入它们。
- [`packages/session/session-projection/tests/summary.spec.ts`](../../../../packages/session/session-projection/tests/summary.spec.ts)：派生集合、其稳定实例、注册与注销后的重建、经带键读取面的摘要式读取、空摘要集合，以及可空标记。
- [`packages/session/session-projection-cache/tests/cache.spec.ts`](../../../../packages/session/session-projection-cache/tests/cache.spec.ts)：从持久行读取摘要时省略被标记键，且水位只取自被服务的行。
- [`packages/api/session-controller/tests/summary-types.client.spec.ts`](../../../../packages/api/session-controller/tests/summary-types.client.spec.ts)：在 `SessionSummary.projectionValues` 上读取 `turnOutline`、`sessionStats`、`todos` 触发 `@ts-expect-error`，而完整快照仍暴露它们且 `todos` 仍可空。
- [`packages/api/session-controller/tests/manager.client.spec.ts`](../../../../packages/api/session-controller/tests/manager.client.spec.ts)：断线重连刷新会替换行块，残留的被排除键不会存活。
