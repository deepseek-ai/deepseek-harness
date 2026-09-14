# Agent Note: 规范的 V3 Session 事件信封

Status: implemented

[English](2026-09-06-v3-canonical-session-envelopes.md) | 中文

## 问题

一个 Session 事件会经过内存、持久化与浏览器协议读取器。如果其类型允许缺少位置声明或携带无关 surface 元数据，读取器就可能静默遗漏消息，或对哪些字段影响重建产生分歧。替换端点的多种拼写与空请求头可选字段，也使不同存储记录能够描述同一请求。相互矛盾的工具失败元数据会让模型历史与诊断报告不同结果。

## 决策

Session 格式 V3 使用一种规范事件信封。每个 `system/message`、`user/message`、`assistant/message` 与 `tool/result` 都要求 `surfaceOp`。已知仅日志事件仅允许 `type`、`seq`、`time`、`data` 与可选的 `ignorable: true`；其 TypeScript 变体将两个 surface 元数据字段声明为可选 `never`。原生未知或已退役的可忽略信封（包括其元数据）保持不透明。assistant 消息嵌入精确提供方 stream，且只有此类消息禁止 `sourceEventSeqs`。system、user 与 tool 消息可以引用非空、唯一的较早来源序号集合。

`SurfaceOp` 恰好为 `'append'` 或 `{ op: 'replace', startSeq, endSeq }`，端点使用 `SessionSeq`，不接受别名或额外键。两个端点都早于替换事件，并按当前 surface 顺序而非数值序号顺序标识闭区间。Session 接纳还验证当前成员关系、端点顺序、完整引用覆盖与仅修改内容的单节点工具结果替换。`shadowedRange.start/end` 等压缩（compaction）载荷字段与折叠结果字段保留各自名称；这不是对载荷进行递归重命名。

当前接纳拒绝任何 `request/header.header.system` 以及恰好为空的 `tools: []` 或 `adapterDefaults: {}`。系统提示词属于 `system/message`；`request/header` 仍是请求非历史状态的快照。写入方省略两个空可选字段。仅含空白的系统内容、`config.stop: []`、嵌套 header/source/data 扩展与嵌套工具 schema 值保持原样。带有 `data.error` 的 `tool/result` 要求 `message.content[0].isError === true`；失败结果不必携带错误身份。当前读取与迁移均不会根据矛盾元数据推断错误结果。

### 校验所有权

[核心 Session](../../../../packages/core/session/src/surface.ts)负责事件本地的位置、请求头空字段与工具错误规则，其 surface 管理器负责需要事件日志的关系。seed、append 与恢复会在接纳事件前应用这些规则。它们不会为插件自有载荷创建通用 schema，也不会提前展开嵌入式提供方 stream。

通用 Gateway 客户端返回未经校验的原始输出。因此，现有 [SessionEventStream](../../../../packages/api/session-controller/src/client/transport.ts) 会在发布前检查 follow 快照、实时持久条目与历史页。其私有[协议事件检查器](../../../../packages/api/session-controller/src/client/session-wire-event.ts)验证精确信封，并将事件本地规则委托给可在浏览器中使用的核心校验器。它不添加通用 Gateway schema，也不校验无关插件载荷。surface 成员关系与来源是否存在仍由 Host 负责，因为浏览器窗口可能未包含较早事件。

### 已发布 V2 到 V3 的转换

[V2 到 V3 规范](../../../../packages/session/session-format-v2-to-v3/README.zh.md#v2-to-v3-specification)负责完整历史转换、[规范化规则](../../../../packages/session/session-format-v2-to-v3/README.zh.md#canonical-envelopes)及[原生准入与恢复](../../../../packages/session/session-format-v2-to-v3/README.zh.md#native-v3-admission)。将这些规则集中在一起，可以避免把保持事件数量的规范化步骤误认为恒等迁移。冻结的关系校验使用私有视图而非运行时别名；原始 V3 产物仍具权威性。

## 曾考虑的替代方案

**将缺失的位置默认为 append。** 这会凭空添加存储记录中不存在的模型历史决策，并接纳无效 V2 产物。要求位置声明，使所有读取器必须依据同一证据。

**当前读取器接受两种替换拼写。** 这会保留两种持久表示，并使校验取决于接收记录的读取器。只有相邻迁移边解释已发布的键；当前读取器只接受 V3 键。

**规范化所有空值或修复工具结果。** 空 stop 列表、空白与插件载荷可能有意义。删除它们或根据诊断设置 `isError` 会改变已记录事实。迁移边只执行具名且保持语义的转换，并拒绝矛盾。

**复制历史校验器或直接向其传入 V3 事件。** 复制会重复关系语义；直接复用则会接受旧信封拼写，并误解系统节点与修复身份。严格的 V3 校验加组合后的私有视图，可以在不扩大当前接纳范围的前提下复用冻结关系。

## 后果

类型化事件、持久化与浏览器历史对必填位置和事件本地失败语义保持一致。畸形记录在投影前失败，而不会从模型历史中消失。迁移放弃对矛盾记录的尽力恢复；[已发布格式的发布策略](2026-08-31-released-session-format-migrations.zh.md)保证保留的源代次不被修改。

本决策部分取代[会话 surface](2026-06-18-session-surface.zh.md)与[可重建请求](2026-07-05-reconstructable-requests.zh.md)说明中的信封表示细节。它们继续负责有序投影与已记录请求的所有权。[系统提示词 surface 节点决策](2026-09-02-system-prompt-as-surface-node.zh.md)保留提示所有权、受保护头节点语义与迁移依据。[V2 嵌入式 stream 决策](2026-09-01-v2-embedded-assistant-streams.zh.md)继续负责尝试结算、精确 stream 证据与改变事件数量的迁移；V3 保留这些决策。

## 验证

[核心接纳测试](../../../../packages/core/session/tests/canonical-envelopes.spec.ts)固定无效 seed/append/restore 记录、类型化 surface 变体、可选失败身份与拒绝后派生状态不变。[浏览器传输测试](../../../../packages/api/session-controller/tests/transport.client.spec.ts)检验发布前的严格 follow/page 接纳。[迁移测试](../../../../packages/session/session-format-v2-to-v3/tests/canonical-envelopes.spec.ts)覆盖转换与恢复；冻结的相邻迁移边测试保留历史语义。必需覆盖还包括编解码器接纳、空白与空 stop 列表保留、不透明载荷保留，以及按合法 surface 顺序排列但数值递减的替换端点。
