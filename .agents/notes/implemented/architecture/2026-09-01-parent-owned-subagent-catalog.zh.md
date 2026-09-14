# Agent Note: parent 自有的 subagent 目录事件

Status: implemented

[English](2026-09-01-parent-owned-subagent-catalog.md) | 中文

## 问题

直接 child discovery 曾从全局 Session 语料与每个入选 child 的日志重建目录。创建过程已经知道直接 parent、child id、mode 与 label，因此仓库范围枚举和 child 日志读取重复推导了已有归属的事实，并让浏览器刷新成本取决于无关 Session。

child descriptor 对恢复与 composition 仍然必要，但它不能作为 discovery 来源，因为读取方必须先找到并打开 child 才能读取 descriptor。fork 还有独立要求：从 parent 日志播种的副本不能继承原 Session 的 child。

## 决策

parent Session 的 required `subagent/catalog` 事件是直接 child discovery 的持久化权威。每个事件都是一条成功创建事实，包含 `childId`、`childCreatedAt`、mode 与按 mode 区分的 label。没有本地 Session 的远程 one-shot run 不进入该目录。无效的自身 fact（包括不支持的 payload 版本）会使 projection 恢复失败，因为静默丢弃 required fact 会返回不完整的目录。

创建只发布成功事实。one-shot run 在 provider 返回本地 child 后、run 到达调用方前追加目录事件。continuable run 先准入初始 prompt，再追加目录事件，最后返回 child id。准入或目录追加失败时，创建失败并释放 activation；不存在补偿目录事件或 rollback 协议。

child header 与 `subagent/descriptor` 继续拥有恢复与 composition 权威。Activation 与精确 parent 关系继续拥有授权与投递权威。mode 与 label 只快照一次，同一份分离值写入 parent catalog fact 与 child descriptor。

注册的 `subagentCatalog` projection 物化 parent fact。它将存储、追加、迭代和检查点校验交给 [`dsh-chunked-list`](../../../../packages/util/chunked-list/README.zh.md)，后者以每块 64 项的持久 stack 保存事实，因此 append 最多复制 head chunk，以有界 O(1) 工作完成。materialization 从旧到新访问 chunk，对 D 条事实以 O(D) 时间保留父目录事件顺序。并发创建按目录成功追加的顺序排列，与 child 时间戳和 id 无关。projection checkpoint 以 O(D) 克隆 state；projection-cache 继续异步写入，并使用既有创建、turn-end 与 disposal 强制点。

工具库拥有分块布局及其共享容量常量；目录拥有事件校验、fork 过滤和目录行转换。目录 projection state 版本 2 保存通用块值，因此 projection registry 从 Session 事件重建不兼容的缓存。Session 事件载荷和公开目录行保持各自格式。

fork 隔离使用 projection 初始化时提供的精确 `Session.inheritedEventCount`。fold 忽略该 offset 之前的 `subagent/catalog` 事件。state 保存 inherited offset，但不保存每条 event seq，因为接受判定已在 fold 时完成。

Headless 快照采集按父目录顺序分配同父子级的 fixture 角色，不依赖子级创建时间戳：provider 启动可能在较新的 Session 之后发布较旧的 Session。采集过程原样保留每份日志。

snapshot normalizer 会把 `childCreatedAt` 归零，因为它来自 process clock。事件顺序与来源事件引用保持不变：相邻 fact 也可能来自顺序创建，因此相邻关系不能证明可交换性。

即使 replay 输入保留历史 Session generation，当前 writer 的快照预期也包含 catalog 事实。比较保留 catalog 及其来源事件引用；历史 replay 文件保持不变。

## 考虑过的替代方案

**扁平不可变数组。** 用 `[...facts, fact]` append 会复制 D 个 fact，因此创建是 O(D)。修改共享数组会违反 projection state ownership 与 checkpoint 安全。

**每 fact 一个 node 的 linked list。** 它提供 O(1) append 与 O(D) read，但持久 projection checkpoint 会形成 D 层 JSON 嵌套。每块 64 项保留渐进复杂度，同时降低嵌套深度。

**独立的 host state 观察输出。** 返回内部 projection state 会重复已有观察结果机制，并复制与子级发现无关的状态。目录视图通过既有的类型化 projection map 提供直接子级列表。

**持久 SQLite child index。** index 会为 parent Session 日志中已有顺序的 fact 增加另一套写路径、reconciliation protocol、schema 与 corruption surface。

**补偿失败事件。** 在初始 prompt 准入前记录 catalog membership 会引入第二种 operation、配对规则、rollback 清理与 client reconciliation。把成功事实推迟到准入完成后即可删除该协议。

## 后果

Session 观察和客户端快照通过 `projections.values.subagentCatalog` 暴露直接子级列表。目录状态变化时，projection 变更通知发布完整列表。每次视图计算成本为 O(D)，因此 D 次创建的累计视图工作量可能为 O(D²)；这沿用既有 projection 机制。直接子级和后代列表仍使用 Session 语料库与子级身份 projection。

不认识该 required event 的 backend 会按既有 Session event 机制拒绝日志。目录投影不通过扫描旧子级日志来重建缺失的父级事实。
