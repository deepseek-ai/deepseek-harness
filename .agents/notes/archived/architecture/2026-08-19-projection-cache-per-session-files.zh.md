# Agent Note: 投影缓存改为每会话文件

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-projection-cache-per-session-files.md) | 中文

## Problem

持久投影缓存曾是单个全局 `session_projcache.json`——存储根目录下一个文件里的 `sessions` 表。每次节流检查点都会重写包含所有会话行的整个文件，写放大随会话数量增长；且一个畸形文件会让整个缓存一起失效。

## Decision

缓存打开采用新增 `per-record` 布局的 `session_projcache` 存储域：每个会话一个带版本戳的文档，位于 `<root>/session_projcache/sessions/<id>.json`，介质归存储栈所有——`storage` / `storage-json` / `storage-domain` 与缓存一起落在共享 base 装配里，缓存重新变回纯粹的域消费方。所有随附且基于 base 的 profile 都保持启用缓存，因此会话生产方会记录检查点，不取决于当前应用是否提供列表接口；不使用 base 组合包的 `sdk-minimal` 不在此装配范围内。缓存绝不咨询持久化层：没有 `locate`、不依赖挂载的是哪个后端。

读写共享同一份一致状态：每次读取（`cachedSnapshot`）都是对域内存表的同步查找（零 I/O）；每次写入排进该域的单条写链，先落盘成功才改内存——不再有落后于节流写入的直读磁盘。缓存保留其余全部职责：检查点折叠、写策略（turn/end + dispose 强制点、count/interval 节流）、fail-soft 持久化与列表读。`cachedSnapshot(meta)` 是同步的。缓存不运行冷重折叠阶梯（那需要读取会话日志，属于持久化层的职责）；需要保证冷快照的消费方自行从日志重折叠。json 后端以仅属主权限（`0o700`）创建自己的目录树。

## Consequences

- 每会话写入隔离：每次节流写入只替换该会话的小文档，消除全局写放大。域写链将写入串行化，新切面绝不会先于旧切面落盘；域关闭时会排空在途写入。
- 列表读取是同步内存读；没有记录文档的会话只是缺少投影列。
- ACP、headless、SDK 与 Web 会话都会发布缓存行，供后续消费方使用。确保日志领先的持久性屏障可能按缓存节奏 flush 已覆盖的前缀，并拆分原本会合并的物理 JSONL 行；各 profile 的录制快照会重新 pack 逻辑事件流，因此缓存时序不会决定 fixture 布局。
- per-record 契约把故障范围缩小到单记录：畸形或过期版本的文档在打开时读作"无此记录"，单个坏文件不会拖垮整个缓存；检查点 schema 升级按会话丢弃过期行，而不是拒绝整个域。
- json 后端仅在枚举时没有发现任何新布局文档路径、旧单元名称匹配，且其版本为当前版本或已声明兼容版本时，才从旧整单元缓存引导 per-record 目录树。接受集合之外的版本保持不变，新域为空；存储绝不把域 owner 未批准的版本改标为当前版本。只要存在任意新文档路径，即使文件不可读或版本陈旧，也会对整个单元禁用引导；缺失的会话行从日志重折叠。[跨版本读兼容决策](2026-09-02-projcache-cross-version-read-compat.zh.md)是版本策略的权威说明。
- `session_projcache` 域使用版本 7，并声明版本 3 至 6 在结构上兼容。前代 identity 缺少 Session `formatVersion`，因此不能播种当前投影并会回落冷折叠；当前检查点会用完整 identity 重写它们。格式匹配后，缺失的 lineage 字段归一化为 unseeded 身份，seeded 调用方会拒绝该身份并回落冷折叠。仍然通不过 schema 校验的记录会被备份并跳过；后续每次写入都使用版本 7。
- 缓存记录仍绑定同一日志生命周期：存储的 `{createdAt, cwd, isSeeded, inheritedEventCount}` 身份防止被重建的 id 或不匹配的继承前缀误导。

## Alternatives considered

- **保留全局 sessions 表。** 保留一次加载式列表，但保留了促成此改动的全局写放大与单文件爆炸半径。
- **缓存自持的每会话文件**（`<root>/<session-id>/projection_cache.json`，本改动的第一版）。试过并在评审中回退：缓存手搓了介质——路径、按路径的写链、在途跟踪、仅属主文件权限，以及 sqlite 无路径特判——而且它的列表读每次调用都直读磁盘、写却在节流，读写永不一致。
- **经 `sessionPersistence.locate(meta)` 解析路径**（文件放在会话日志旁）。未采用：缓存得从日志 artifact 路径"猜"日志旁边（`dirname` + 固定文件名），把缓存耦合到持久化服务与后端的布局。
- **把 `per-record` 做成既有单元的一种模式而非独立单元类。** 未采用：两种布局的状态模型本质不同——`single` 内存权威、整文件发布；`per-record` 无状态（目录即状态，`loadAll` 重扫目录树）——所以它们是同一后端下的两个小型独立类，记录键做路径安全校验而非编码。
- **跨未声明单元版本复制旧值。** 未采用：json 后端不知道域的记录 schema，也无法推导会话 lineage 字段。只有当域在 `compatibleVersions` 中明确列出旧版本，且当前 schema 接受该值时，后端才复制旧记录；否则记录保持不变并读作不存在。
