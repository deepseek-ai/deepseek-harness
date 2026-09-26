# Agent Note: 精简未使用的 SessionQuery 便利方法

Status: proposed

[English](2026-09-19-trim-session-query-convenience-api.md) | 中文

## 问题

[`SessionQueryEngine`](../../../../packages/session-query/session-query/src/index.ts) 维护了 `readSession`、`readTitle`、`readTitleSnapshot` 和 `listEvents`，但没有执行这些方法的第一方产品调用方。精确名称和调用点搜索只找到内部委托、测试和生成的发现元数据。当前消费方使用可保留的观测、批量标题、模型可见事件读取和追踪。生成的目录向插件作者展示这些方法，但不执行其中列出的操作。

这些入口增加了回放验证和结果复制路径、包装层、公开类型及入口专属测试。删除它们可以减少需要维护的 API 义务，无须替换共享查询实现。

## 提案

删除这四个方法、不再被引用的 [`SessionLogSnapshot`](../../../../packages/session-query/session-query/src/types.ts) 结果类型和 [`eventRecords`](../../../../packages/session-query/session-query/src/tracing.ts)。删除相关导入及当前文档，包括两个子系统页面中的 `SessionLogSnapshot` 类型等价代码块和说明段落。删除[类型等价 manifest](../../../../scripts/type-equiv.manifest.json) 中手工维护的条目，以及[目录生成器](../../../../scripts/gen-cordis-catalog.ts) 中的 `LINK_MAP` 条目，然后重新生成发现元数据。选定定义在清理导入和元数据之前约占八十行源代码；无须新增替代服务。

保留 `filterEvents` 和 `_filterEvents`，以及语义提取和过滤辅助函数。保留 `observeSession`、`readTitleSnapshots`、`readSurface`、`readEvent`、列举、搜索和追踪。保留共享会话集合解析及其现有所有权和失败行为。

[历史上的统一查询决策](../../archived/architecture/2026-07-23-unified-session-query-service.md) 解释了保留的单服务结构。本提案删除选定的便利操作，不改变该结构。没有活动记录被完全取代；保持归档记录冻结，并从受影响的当前文档链接到这一较窄的决策。

## 考虑过的替代方案

**为外部调用方保留所有已记录的方法。** 这样可以避免已安装插件迁移，但会保留四个没有当前产品调用方的 API。尚未稳定的 API 策略允许在明确迁移代价后有意删除它们。

**同时删除 `filterEvents`。** 不采用，因为其提供方无关的字面子串扫描不同于 FTS 的 token 匹配。[SQLite 查询文档](../../../../packages/session-query/session-query-sqlite/README.zh.md) 明确推荐该操作；删除它会撤销一项独立的查询能力。

## 验收标准

- 从源代码、包 README、子系统声明和生成目录中删除这四个方法及失去引用的定义；保留字面子串查询。
- 通过保留的入口维持实时来源优先、损坏拒绝、取消、结果独立复制、冷读取和批量标题行为。将被删方法测试中的相关断言迁移出去，不删除其共享保证；明确处理 `readSession` 额外执行的回放验证。
- 运行针对查询、SQLite 查询、查询工具及受影响的会话引用的测试，相关无密钥查询录制回放、目录生成、类型检查、lint 和 doc-sync（文档同步门禁）。已发布的 Session 代际文件保持不变。

## 风险

仓库搜索无法枚举已安装或动态编写的插件。这些调用方将失去完整日志和轻量事件记录的便利操作，必须按照保留 API 实际的所有权和错误语义迁移。若出现确实需要某个被删操作的消费方，可以单独重新考虑该操作。
