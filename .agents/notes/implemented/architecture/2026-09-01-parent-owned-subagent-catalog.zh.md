# Agent Note: parent 自有的 subagent 目录事件

Status: implemented

[English](2026-09-01-parent-owned-subagent-catalog.md) | 中文

## 问题

直接 child discovery 曾从全局 Session 语料与每个入选 child 的日志重建目录。创建过程已经知道直接 parent、child id、mode 与 label，因此仓库范围枚举和 child 日志读取重复推导了已有归属的事实，并让浏览器刷新成本取决于无关 Session。

child descriptor 对恢复与 composition 仍然必要，但它不能作为 discovery 来源，因为读取方必须先找到并打开 child 才能读取 descriptor。fork 还有独立要求：从 parent 日志播种的副本不能继承原 Session 的 child。

## 决策

共享 activation 入口、外部执行所有权，以及调用方与父级之间的结果投递选择由[统一 subagent activation](../simplification/2026-09-17-unified-subagent-activations.zh.md) 决策拥有。本记录保留下述独立理由。

父级 Session 的必读 `subagent/catalog` 事件是发现直接子级的持久化权威。每个本地子级都会进入目录，与结果接收方无关；外部子级仅在 parent 投递时进入目录。工作流成员记录描述执行进度，不替代本地 Session 发现。每个事件包含 `childId`、`childCreatedAt`、mode 与按 mode 区分的 label。本地子级使用 `continuable`；外部执行使用 `external`，不能作为本地 Session 打开。历史 `one-shot` 与 `unknown` 条目仍可读取。无效的自身事实（包括不支持的载荷版本）会使投影恢复失败，因为静默丢弃必读事实将返回不完整的 catalog。

创建只发布成功事实。本地 activation 先接纳初始提示词，再追加 catalog 事件。外部 activation 在提供方启动后、返回回执前追加事件。准入或发布失败会释放未发布的执行；不存在补偿 catalog 事件或回滚协议。

child header 与 `subagent/descriptor` 继续拥有恢复与 composition 权威。Activation 与精确 parent 关系继续拥有授权与投递权威。mode 与 label 只快照一次，同一份分离值写入 parent catalog fact 与 child descriptor。

注册的 `subagentCatalog` projection 物化 parent fact。它将存储、追加、迭代和检查点校验交给 [`dsh-chunked-list`](../../../../packages/util/chunked-list/README.zh.md)，后者以每块 64 项的持久 stack 保存事实，因此 append 最多复制 head chunk，以有界 O(1) 工作完成。materialization 从旧到新访问 chunk，对 D 条事实以 O(D) 时间保留父目录事件顺序。并发创建按目录成功追加的顺序排列，与 child 时间戳和 id 无关。projection checkpoint 以 O(D) 克隆 state；projection-cache 继续异步写入，并使用既有创建、turn-end 与 disposal 强制点。

工具库拥有 chunk 布局与共享容量常量；catalog 拥有事件校验、fork 过滤和行转换。catalog 投影状态版本 6 接受外部成员，因此投影注册表会从 Session 事件重建不兼容缓存。载荷 v0 与 v1 保持不变；v2 记录外部执行。

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

Session observation 与 client snapshot 通过 `projections.values.subagentCatalog` 暴露直接子级列表。目录状态变化时，projection change feed 发布完整列表。每次 view 的成本为 O(D)，因此 D 次创建可能累计产生 O(D²) 的 view 工作量；这沿用现有 projection 机制。`listChildren()` 通过一次 live-preferred Session observation 读取父 projection；后代枚举按目录顺序递归调用同一读取函数。可达目录事实提供身份和成员关系，无需全局 Session 扫描或独立的子身份缓存路径。不可读分支保留为诊断；未进入目录的 Session 不在发现范围内。[Web projection 消费说明](../../../../packages/client/ui-subagent/README.zh.md) 说明浏览器加载与同步。

[创建元数据排除说明](../../../../packages/subagent/subagent/README.zh.md) 说明目录事实为何不包含模型配置。
