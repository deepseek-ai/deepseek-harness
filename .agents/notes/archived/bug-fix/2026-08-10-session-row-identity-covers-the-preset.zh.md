# Agent Note: 会话行的标识判定纳入 preset

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-session-row-identity-covers-the-preset.md) | 中文

## 问题

`SessionManager.buildListSnapshot` 按值对列表行做记忆化：一次 wire 刷新会铸造全新的 summary 对象，因此与缓存项相等的行会被替换为缓存实例，下游每一个 `SessionListItem` memo 才能持续命中。它声明的约定是「每个字段都相同就复用缓存对象」，而那段比较是手写枚举字段的，其中没有 `agentPreset`。

一次已确认的 preset 切换恰好只移动这一个字段。`noteAgentPreset` 把它 upsert 进去，`applyMutation` 合并它——该合并有意不采用 mutation 的 `updatedAt`，因此切换后的行与它的缓存孪生只在 preset 上不同，别处一致。于是标识判定认为这一行没变，永久地提供了过期实例：manager 自己的 summaries 是 `minimal`，而所有读取投影快照的一方继续读到 `standard`。

hero 上的 chip 正是其中一个读取方，而且它在发出任何请求之前会拿这次选择和那一行比较。切回会话创建时的那个 preset，在它看来就是「已经是这个 preset 了」，于是丢弃 stage、根本不发 RPC——chip 的标签变了，组成没变。一个会话可以从创建时的 preset 切走一次，然后再也切不回来。

## 决策

标识判定把 `agentPreset` 与其余 summary 字段一起比较，这本就是「每个字段都相同」所声称的内容。其他一概不动：记忆化、合并、chip 的 no-op 检查各自都是对的——只要它们读到的那一行是对的。

## 考虑过的替代方案

**让 chip 改为直接读宿主，而不是读列表行。** 这样能绕开过期的行，但会话头部的标签同样以这一行为准，过期状态会在最显眼的界面里留下来；而且将来任何 `SessionSummary.agentPreset` 的读取方都会继承同一个陷阱。

**去掉行标识记忆化，每次快照都重建行。** 这能整类消除「漏字段」缺陷，代价却正是这个 memo 存在的理由：一次 wire 刷新会为每一行铸造新对象，于是每次刷新都要重渲染整个会话列表。

**改成结构化比较，而不是逐字段枚举。** 通用的深比较不能盲目加：行上带有 `projectionValues`，它的引用标识本身就是「投影 store 重新发布了」这一有意为之的信号，把它折进值比较，要么每个投影 tick 都重渲染，要么把一次真实变化掩盖掉。

## 后果

会话行携带的每个字段现在都参与行标识，因此读取 `SessionSummary.agentPreset` 的界面会在宿主确认后立刻看到切换，会话头部标签也包含在内。该判定仍是手写枚举，所以将来给 `SessionSummary` 新增字段时必须同步加进来；`sessions-service` 的投影测试为下一个这样的字段点明了失效形态，而不只是钉住这一次。

## 测试

`sessions-service.spec.ts` 传入一个空白行、记录一次切换，并断言投影快照报告的是新 preset——在旧判定下它会失败，因为这一行别处都没变。`agent-preset-selection` web e2e 先向下切再向上切，断言宿主认可第二次切换、`/` 目录随之回来；没有这次修复，第二次切换根本到不了宿主。

## 相关内容

同一条 e2e 也覆盖[目录失效的修复](2026-08-10-slash-catalog-follows-preset-switch.zh.md)——正是它让菜单在切换真正落地之后跟随任一方向的切换。
