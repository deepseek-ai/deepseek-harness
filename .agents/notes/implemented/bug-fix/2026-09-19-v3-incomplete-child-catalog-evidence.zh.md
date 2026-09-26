# Agent Note: 保留子目录证据不完整的 V3 Session

Status: implemented

[English](2026-09-19-v3-incomplete-child-catalog-evidence.md) | 中文

## Problem

有效 V3 子日志可能没有自身 descriptor、descriptor 版本不受支持，或存在多个 descriptor。其 header 仍能确定身份及父子关系。要求一个受支持的 descriptor 才迁移父日志，会让不可获得的发现字段阻止读取原本可读的历史。

## Decision

V3→V4 迁移仅在恰好一个受支持的自身子 descriptor 提供发现字段时，追加完整的缺失父目录项。其他 descriptor 数量和不支持的版本通过[逐会话目录准备](2026-09-19-session-local-subagent-migration.zh.md)保留模式未知的成员关系。已有父目录项和子事件保持不变。这取代[相邻迁移决策](../architecture/2026-08-31-released-session-format-migrations.zh.md)中对缺失证据的拒绝。

JSONL 错误传播规则由[逐会话目录准备](2026-09-19-session-local-subagent-migration.zh.md)部分取代；转换器仍校验已提供事实及冲突。已知子创建时间必须匹配已有父目录项。只有恰好一个受支持的自身 descriptor 时才检查 mode／label 和 descriptor 字段。JSONL 隔离无效 descriptor 字段和损坏子正文，并保留已知 header 身份；不可读或不支持的 header 不参与发现。来源修订变化仍拒绝发布。

## Alternatives considered

**拒绝整个父 Session。** 发现元数据不足以成为禁止读取有效父历史的理由。

**选择首个或末个 descriptor。** [`foldSubagentDescriptor()`](../../../../packages/subagent/subagent/src/descriptor.ts) 依据建立提供方恰好写入一次的规则取首个；[身份投影](../../../../packages/subagent/subagent/src/projection.ts)取末个以覆盖继承身份。多个自身记录违反该规则。补填要求一个自身记录，而不在这两种消费者策略之间做选择。

**推断缺失字段。** 推断的 mode 或 label 会在没有证据的情况下成为持久目录事实。

## Consequences

历史子会话具有可读 header 但没有可用 descriptor 时，在父直属子目录中保留未知模式成员关系。已有目录项仍可见。V4 后继发布后，打开它不重新扫描历史子日志；自动补齐后续模式不属于本迁移。准备过程仍在发布前重新检查子修订，因此新出现的证据不能静默绕过来源一致性检查。

单元、JSONL 读写和 Preview 打包测试覆盖不可用证据、源字节不变、条目保留、身份冲突以及发布前的证据变化。
