# Agent Note: 区分 Session 事件身份与日志偏移

Status: implemented

[English](2026-08-31-session-sequence-and-log-offset-brands.md) | 中文

## Problem

Session 位置曾用同一个结构化 `number` 类型表达两种不兼容的含义。事件引用指向一条已存在的记录，而前缀长度、下一追加位置或读取切点指向记录间隙，并且可以等于事件总数。因此，编译器会在需要事件身份的位置接受偏移，也无法暴露迁移时漏改的序号字段。

`SessionHeader.seedLength` 还把 v0 存储坐标混入了无须读取正文的 metadata consumer。列表只需要知道 Session 是否有 fork lineage，只有同时持有事件正文的读取方才能解释精确的继承前缀长度。

## Decision

`@deepseek-ai/dsh-brand` 导出编译后消失的数值原语 `BrandedNumber<B>` 与运行时保持原值的 helper `brandNumber()`。`@deepseek-ai/dsh-session` 拥有两个经验证的 brand：`SessionSeq` 指明一条已存在事件，`SessionLogOffset` 指明日志间隙、前缀长度或读取偏移。`SessionSeqCursor = SessionSeq | -1` 表达首条事件之前或之后的闭区间 watermark，`OptionalSessionSeq = SessionSeq | null` 表达允许以缺失为数据的事件身份。

`SessionEvent.seq`、surface 替换端点、provenance 以及 owner payload 中指向 Session 事件的字段使用 `SessionSeq`。`Session.seq`、`Session.firstLiveSeq`、`Session.inheritedEventCount`、带正文读取的偏移与继承前缀切点使用 `SessionLogOffset`。算术结果恢复为普通 number，并通过对应的验证构造函数重新进入任一领域。

逻辑 `SessionHeader` 携带 `isSeeded: boolean`，不携带数值 seed cut。包含正文的存储值和 observation 在 header 旁携带 `inheritedEventCount`；`Session.ownEvents()` 与 `Session.isOwnSeq()` 向普通 consumer 隐藏比较。seeded constructor 必须显式提供 seed 与精确 cut，包括 cut 为零的空 seed，因为 constructor 输入可能在继承前缀之后还包含 child-owned setup event。

v0 JSONL header 保持字节兼容：缺少 `seedLength` 时解码为 `isSeeded: false` 和零 cut，存在零或非零值时解码为 `isSeeded: true` 和对应精确 cut。仅 header 的 listing 只转换字段是否存在。API、SDK、DeepSeek、telemetry、query row 与 JSON 表示继续携带普通 number；由它们各自的 adapter 在值进入同进程 domain code 时完成验证与 brand。

## Admission and ownership

Domain constructor 拒绝负数、小数、非有限值与非安全整数。parser 验证原始 number 一次；brand 不需要运行时 wrapper 时，保留原解析对象。编译期 brand 无法发现外部事件里的未知数值字段；格式迁移仍须获得穷尽的 owner disposition，并拒绝无法安全改写的 schema。

`session/end-seed` 仍是 lifecycle marker，不是继承 cut 的来源。每次 constructor restore 都会追加或保留该 marker，unseeded replay 也一样，因此 projection 与 cold reader 会显式接收 `inheritedEventCount`，而不是扫描日志。

## Alternatives considered

**继续让所有位置都使用 `number`。** 拒绝，因为事件身份、计数与 cursor 已频繁跨越 package 与 persistence seam，意外混用是迁移风险，而不是局部算术便利。

**用同一个 branded Session position 表达身份和偏移。** 拒绝，因为这样仍会在需要已存在事件的位置接受 `eventCount` 或 `fromSeq`，还会迫使 `-1` 与 `null` sentinel 进入互不相关的操作。

**从 `session/end-seed` 推导继承 cut。** 拒绝，因为该 marker 记录 constructor lifecycle，并不只记录 fork lineage，而且 constructor seed 可以在继承前缀之后包含 child-owned event。

## Consequences

携带序号的代码会明确说明一个 number 指向事件还是间隙。仅 header 的 reader 无须打开正文即可取得稳定 lineage metadata，persistence、projection、query 与 authorization path 则保留所需的精确 cut。磁盘 v0 格式与公共数值 wire 不变。

代价是在 durable 与 wire parser 处显式转换，并让含正文 observation 携带独立的精确 cut 字段。Projection cache identity 包含 lineage bit 与精确 cut，因此其可丢弃的 storage domain 会推进，旧 row 按需重建；不持有 cut 的仅 header reader 会跳过 seeded cache hint。turn number、step number、message-list index、workflow member ordinal、token count 与无关数值领域保持普通 number，因为它们不指向 Session 事件。

## Testing

类型断言钉住 `SessionSeq` 与 `SessionLogOffset` 不可互换。运行时 suite 覆盖 constructor 验证、混合继承与 child-owned seed、空 seed、`ownEvents()` 与 `isOwnSeq()`、plain 与 Zstandard 编码中的 v0 JSONL 缺失/零/非零 header、仅 header 的 listing、cold prepare 与 reopen、query 和 projection cut，以及不变的数值 wire 值。
