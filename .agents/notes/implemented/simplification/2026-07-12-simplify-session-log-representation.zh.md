# Agent Note: 简化会话日志表示

Status: implemented

[English](2026-07-12-simplify-session-log-representation.md) | 中文

## 问题

会话日志维护着两种表示，其机制复杂度超出了消费方的实际需求：一个伪链表 surface 和自定义的请求头增量。

`SurfaceManager` 同时在数组、seq map 和可变 `prev`/`next` 链接中存储相同顺序。生产代码从不读取任一链接：compact 的工具配对 balance 判定基于按 surface 顺序缓存的各切点 balance。替换已经使用 `indexOf`，因此链接并未使其主导操作成为常数时间。使用线性替换查找的 seq 数组具有相同的渐近替换成本，却只有一种表示需要验证。

请求头子系统实现了一套自定义的系统/工具增量编解码器和传输决策层，尽管其约定声明增量只是编码优化，而非可重建性要求。在每个 agent loop（智能体循环）实例边界保留初始/恢复的完整快照，然后在该实例的组装头发生变化时写入一条规范的完整 `request/header`，即可保留回放能力，同时删除 `SystemDelta`、`ToolsDelta`、往返回退逻辑以及持久化的 `request/header-delta` 变体。编解码器专属的词汇随编解码器一起消失，并非因为其各分支本身无效。

实现保留追加与替换操作的 `sourceEventSeqs`、崩溃修复结果引用的 `tool/call` seq，以及所有 `SessionStartSource` 变体，因为这些字段承担审计/拦截职责，当前没有读取方并不能推翻这一点。

## 决策

`SurfaceManager.nodes` 是由事件序号组成的 `readonly number[]`；公共 `SurfaceNode` 形状、node 链接和 seq-to-node map 均已移除。内部替换 generation 信号保留。session-query 使用的完整 `foldSurface()` 读取会返回相同的数字数组表示和替换元数据，而无需让增量 manager 保留历史。工具配对 balance 和压缩（compaction）使用事件序号与 surface 位置；由 compact 拥有的每个切点的 balance cache 不依赖 node 链接。

请求头只使用规范的完整快照。初始与恢复锚点即使没有变化也仍是完整快照；实例内变化会追加另一个完整 `request/header`，reason 为 `change`；未变的信封显式开启消息序列或跟随 surface 替换时，会追加 reason 为 `series` 的完整快照。普通的仅追加后续 Turn、同一模型消息序列内的后续 Step 与重试沿用最新快照。delta 事件、codec 类型、diff/apply 辅助函数，以及仅供 codec 使用的 `fallback` reason 均已移除。请求重建选择最新快照。

当前 v1 的 seed 与追加校验只接受固定的完整请求头和当前 reason。冻结的 v0-to-v1 边会在构造当前 Session 前，独占负责对历史 `request/header-delta` 与 `fallback` 结构的显式拒绝；可接受的历史规范化仅限另行穷举的无损结构。ACP（Agent Client Protocol）快照 harness 会把合法的会话中途变更表示为固定的完整请求头和完整可读提示词。

## 曾考虑的替代方案

**保留链表节点和紧凑增量以备未来扩展。** 链接可能有助于未来的游标 API，增量在大型工具 schema 仅有少量变化时可以缩减日志。但没有已发布的游标使用这些链接，而完整快照以磁盘空间为代价，显著简化了正确性保障。如果头部体积确实成为问题，可以基于真实 trace 设计压缩方案或经过度量的规范增量方案。

## 验证

单元测试覆盖并锁定有序 surface 的追加/替换行为、工具配对、压缩、完整请求头 fold/记录、请求重建和开发不变量。Seed 验证以及 JSONL 加载测试会在回放前拒绝旧事件。无密钥 ACP 套件按新的表示覆盖记录、刷新、回放、变更后请求头的固定，以及沙箱模式切换 fixture（测试前置数据）。

## 后果

完整请求头会增加日志体积，线性替换查找在极大 surface 上也可能较慢。由于先前实现调用 `indexOf`，替换原本就是线性的；benchmark 推迟到真实 trace 表明更简单的数组成为瓶颈时再进行。当前 v1 只保留一种表示，v0 边则是已发布旧结构的唯一拥有者。作为交换，surface 顺序和请求头状态现在各自只有一种当前表示，删除了链接维护、map、codec 分支、往返 fallback 和针对 delta 的快照规范化。
