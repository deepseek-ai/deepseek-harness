# Agent Note: 恢复选择器只折叠标题

Status: implemented

[English](2026-07-31-resume-selector-batch-projection.md) | 中文

## 问题

打开 TUI `/resume` 选择器时，会在一个无界 `Promise.all` 中对每个列出的会话调用一次 `sessionQuery.readSession()`。每次调用都会在 `SessionCorpus.load()` 内部重新列出整个持久化存储（O(N²) 次列表查询）、读取并解压完整日志、通过 `Session` 构造函数对每个事件做回放验证，并将 header 和事件深克隆多达三次——而这一切只为推导一行选择器条目的标题、最近活动时间、最后一个 `turn/end` 标签、提供方/模型路由和目标阶段。在真实存储上（185 个会话、压缩后 87 MB、约 35.3 万个事件），选择器需要数十秒才能打开，且开销随日志总大小而非会话数量增长。

## 决策

选择器行除标题外不折叠任何内容，行内其余信息全部来自元数据：

- 标题来自投影系统：`session-title` 已注册 `title` 投影单元，因此实时行读取注册表快照，持久化行读取持久 checkpoint 行（`sessionProjectionCache.cachedSnapshot`，每会话一次文件读取），只有没有可用 checkpoint 的行才付出一次 `coldSnapshot`——checkpoint 加 `readFrom` 尾部折叠，并写回使下次扫描每会话一次文件读取。冷读取受 TUI `resumeScanConcurrency` 配置约束。未挂载缓存的组合回退到一次对日志的有界 `readTitleSnapshots` 批量读取；两条路径都把单行失败隔离为禁用的「Unreadable session」回退。
- 活动时间戳从不读取日志：live Session 取内存中最后一个事件的时间；持久化 Session 对可选 `sessionPersistence.locate()` 命名的产物做 stat（mtime），当 provider 定位不到逐 Session 产物或 stat 失败时回退到 header 的创建时间。任何追加都会移动 mtime，因此仅仅一次 pickup 边界也会让浏览过的 Session 上浮——这是元数据时间戳的代价，予以接受。
- 行内不再有最后轮次标签、提供方/模型路由和目标阶段列。路由可用性改由 Enter 时的预检强制：预检通过 `readSession` 完整读取并回放验证选中的那一份日志后才移交。

选择器 overlay 在 `/resume` 分发时同步打开，早于扫描结算：`undefined` 候选集渲染「Loading sessions…」加载占位符，选择器从第一帧起就拥有终端输入，Enter 提示会话仍在加载，Escape 取消。关闭 overlay 会通过查询方法接受的 `AbortSignal` 中止扫描；忽略信号的后端的迟到结算由陈旧性检查丢弃。扫描完成后通过 `setCandidates`（同时清除陈旧的仍在加载错误）换入行数据，不替换 overlay；排在正在关闭的前任之后的排队激活会在构造时直接收到已扫描的集合；列表查询、标题与 mtime 共用同一个 catch，因此任何扫描失败都会关闭 overlay 并报告通知，而不会让加载占位符悬置。

session-query 与 session-persistence 的任何接口都未改变。随附的 TUI 组合新增投影注册表、storage 与投影缓存行（镜像 web overlay，共用同一 `storages` 根，因此任一界面写入的 checkpoint 都服务两者）；对既有存储的首次扫描仍会各读取一次日志以播种 checkpoint，之后的每次扫描都只读元数据。

## 备选方案

**通过通用批量投影（`projectSessions`）保留每行的路由/轮次/目标列。** 先实现后否决：它仍在每次 `/resume` 时解压并解析全部日志，浏览开销依旧是 O(日志总字节数)，且为单一消费方扩大了 session-query 公开 API。该公开约定已回退；`readTitleSnapshots` 继续使用内部 `projectMany`，保持不变。

**只修复 `SessionCorpus.load()` 内部的 O(N²) 列表查询。** 作为主要修复被否决：在大日志上，按候选行执行的完整解压、回放验证和三重克隆才是主要开销。`load()` 中的冗余预列表查询仍是一个候选清理项，但涉及错误语义。

**通过 `list()`/`SessionRecord` 暴露最后修改时间。** 从 seam 角度最干净，但要触碰持久化约定、provider 和查询记录类型，而 TUI 已能从已存日志的文件元数据得到同样的信息。若出现第二个需要元数据活动时间的消费方再引入。

**专门的持久化标题索引或 TUI 本地标题缓存。** 否决：session-projection 缓存本身就是自有的持久 checkpoint 系统，并已带失效约定（`stateVersion`、身份绑定、日志收缩锚定）；挂载它优于再造一套并行缓存。

## 后果

打开 `/resume` 只执行一次列表查询、每个持久化行一次 stat，标题读取在 checkpoint 就绪后只触碰 checkpoint 行和日志尾部——O(会话数) 的元数据开销，而非 O(日志总字节数)；无缓存的回退路径仍是一次有界标题扫描。行内只显示标题、时间戳、状态和 id；路由问题以 Enter 时预检错误的形式出现，而不再是禁用行；回放会失败的会话由预检而非列表阶段拦截。浏览后放弃的会话会因 pickup 的 mtime 上浮。TUI 测试中的伪造 `sessionQuery` 服务在 `listSessions`/`readSession` 之外提供 `readTitleSnapshots`，测试 harness 会转发可选的 `locate`。由于选择器立即接管焦点，启动第二次扫描需要先关闭当前 overlay——扫描期间输入的第二个 `/resume` 会落入搜索字段，这正是预期的输入捕获行为。
