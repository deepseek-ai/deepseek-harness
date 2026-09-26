# Agent Note: Projection cache 只读面按 lifecycle 身份匹配，客户端 store 区分 cached 与 sequenced 行

Status: implemented

[English](2026-09-19-projection-cache-listing-identity-and-cached-rows.md) | 中文

## Problem

Host 进程重启后，所有 fork 出来的会话（`SessionHeader.isSeeded === true`）在侧边栏列表里没有 title，`@` 引用补全只显示会话 id，列表排序退化到创建时间。打开一次之后恢复。2026-09-19 的一台开发机上，241 条 projcache 记录里有 44 条 seeded，44 条的 `title` 行全部合法，列表一次都没读到。

这不是缓存损坏，也不是版本失配。projcache 记录的 domain version 是 7，`identity.formatVersion` 是 4，两者分别是缓存自身的磁盘格式代际和 fold 所依据的 Session 日志格式代际，都是当前值。问题在读取路径。

### 机制

缓存记录（记录格式与前代恢复见 [投影缓存前代恢复与 Session 格式绑定](2026-09-02-projcache-cross-version-read-compat.zh.md)）绑定一份 lifecycle identity：`formatVersion + createdAt + cwd + isSeeded + inheritedEventCount`，`identityMatches` 做全等匹配。其中 `inheritedEventCount`（fork 继承的事件前缀长度，下称 cut）从 #3346 起不再出现在逻辑 header 里：header 只保留 `isSeeded` 这一位，精确 cut 跟随正文。Session 格式 v2 起（#3398），物理 header 行也不再存 `seedLength`，reader 从正文里 `session/end-seed {inherited: true}` 标记的 seq 推出 cut。

于是 header-only 的读取拿不到 cut：JSONL 后端 `fromHeaderLine` 对 header-only 读取硬编码 `inheritedEventCount: 0`，`SessionPersistenceSnapshot` 只有 header、revision 和可选的 eventCount。Session 列表与引用消费者都因此加了同一个守卫：

| 消费者 | 守卫 | 兜底 | 后果 |
|---|---|---|---|
| `packages/api/session-controller/src/list.ts` `projectionsFor` | `header.isSeeded ? undefined : cachedSnapshot(header, 0) ?? cachedPredecessorTitle(header, 0)` | 无 | 无 title，无 `sessionListMetadata`，blank 判定退到 `false`，排序退到 `createdAt` |
| `packages/context/session-reference/src/index.ts` `projectedLabels` | 同 | 无 | `@` 补全按 id 显示，搜不到 title |

守卫存在时（#3346，2026-09-01），`list.ts` 还有 `probeSmallCold`：缓存 miss 且日志文件不超过 `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024` 字节时读正文补全。它的目的是识别 blank 会话，只覆盖不到 1KB 的日志，对正常 fork 从未生效。#3400（2026-09-03）删掉它，列表回到纯元数据加缓存。#4320（2026-09-19）把 fork 变成一等功能（`packages/core/session/src/fork.ts`，任意 seq fork），每个 fork 都是 `isSeeded: true` 加精确 cut，seeded 会话数量从个位数变成几十条，重启后全部冷，问题集中显形。

### 缓存的两种用途与校验位置

`SessionProjectionCache` 的读写面和调用方：

| 面 | 对记录做什么 | 写回 | 调用方 |
|---|---|---|---|
| `write(session)` | 三个强制点加节流写 checkpoint | 有 | 缓存内部监听 |
| `hydratePrepared(session, events)` | 把 `rows` 当 fold 起点，从 `row.seq + 1` 继续 apply，结果进 live cell | 后续 checkpoint 写回 | `session-query/src/observation.ts` |
| `coldSnapshot(meta, cut, events)` | fold 起点加回写 | 有 | 无生产调用方 |
| `cachedSnapshot(meta, cut, keys?)` | `viewCheckpoint`：每行过 `ver` 和 `stateSchema`，`view` 后返回 | 无 | `list.ts`、`session-reference` |
| `cachedPredecessorTitle(meta, cut)` | 同上，只看 `title`，允许更旧的 `formatVersion` | 无 | `list.ts` |

身份校验全部在缓存内部（`recordFor` → `identityMatches`；`viewCheckpoint` 逐行校验 `ver` 与 schema）。`list.ts` 自己不校验，只是给不出 cut 时不调。

spec.ts 与 README 描述身份检查的目的时用的都是同一个动词：防止 "seed state folded from an unrelated log"、"cannot seed the caller"。它防的是 fold 面。只读面从未做过 seed。

### 客户端 store 无法保证建连数据覆盖提示

客户端每个会话只有一个 `ProjectionValueStore`（`manager.projectionStores`；合并规则原记录于 [Session observation 与 projection 所有的客户端状态](2026-08-25-session-observations-and-projection-owned-client-state.zh.md)），列表下发的 block、打开会话的 history 首页基线、control 基线、推送 frame、rename 结果全部写进同一个对象，`useProjection` 读的也是它。所有写入者平等，只有一条 higher-seq-wins 规则：`apply` 在 `seq <= row.seq` 时丢弃新值，`seed` 清理没带的键时只清 `row.seq <= cut` 的行。一个 seq 相等或偏高的列表提示会在会话打开后原样留在格子里。列表提示的 seq 来自磁盘记录，crash-repair 截断日志后它可以数字上高于建连 cursor，而那正是缓存错、建连对的情形。对提示做 seq 比较是用错了工具。

## Decision

### 缓存分成两个读面，cut 只在 fold 面比对

| 面 | 身份 | 谁能提供 | 方法 |
|---|---|---|---|
| 只读面 | lifecycle 身份：`formatVersion + createdAt + cwd + isSeeded`，全部来自 header | 任何 header-only 调用方 | `cachedSnapshot(header, keys?)`、`cachedPredecessorTitle(header)` |
| fold 面 | lifecycle 身份加 `inheritedEventCount` | 握有 Session 或正文的调用方 | `recordFor` 所服务的 `hydratePrepared`、`write`、`coldSnapshot` |

只读面的两个方法不再接受 cut 参数。`inheritedEventCount` 继续写入记录，fold 面继续全等比对它；"不同 fork cut 的记录不能互相当种子"这条原始设计预期不变。

只读面返回的 block 里，`asOfSeq` 是所服务各行中最低的水位，也就是存储记录自己的位置。header 既作证不了 cut，也作证不了这个水位与当前日志的可比性，所以可比性不由这个数字表达：Session list 给每条摘要的 `projections` block（`SessionProjectionHints`）加独立字段 `kind`，冷会话从 projcache 看出来的 block 标 `cached`，活会话由 Host live registry 算出的 block 标 `sequenced`。两个字段各管各的：`kind` 说明 `asOfSeq` 属于哪个序列空间，`asOfSeq` 是那个空间里的水位。

### 只读面为什么可以不比 cut

- 在同一个 `formatVersion` 下，一条日志的 cut 由 `(id, createdAt, cwd, isSeeded)` 唯一决定：fork 创建时写死，只有改变事件基数的格式迁移能改它，而那种迁移必然改 `formatVersion`。cut 是 lifecycle 的派生事实，不是独立坐标。
- 只读面今天实际发生的是：unseeded 传常量 0（构造上恒真），seeded 直接不调。cut 在只读面上从未和任何真实事实比过。拿掉它，拒绝集合一个都不变：另一个 lifecycle 的记录（四字段任一不同）照样被拒；unseeded 结果相同；seeded 从不可寻址变成可寻址。
- 只读面没有 seed、没有写回，输出是存储记录的纯函数，cut 不参与计算，也不流向任何地方。
- 唯一多出来的暴露面：一份四字段全同、只有 cut 不同的记录。系统自身产生不出它，只有手工复制会话目录再改文件才行。就算出现，后果是列表显示它的值直到会话被打开，仍然不进任何 fold。

### 消费者

| 位置 | 改法 |
|---|---|
| `list.ts` `projectionsFor` | 删 `isSeeded` 分支和 `SessionLogOffset(0)`，冷会话统一 `cachedSnapshot(header) ?? cachedPredecessorTitle(header)` |
| `session-reference` `projectedLabels` | 同一症状，同一改法 |

### 客户端 store 区分 cached 与 sequenced 行

`ProjectionValueStore` 的行分两类，按"这个值有没有本连接可比的 seq"命名：

| 行 | 含义 | 携带 |
|---|---|---|
| `cached` | 从持久化 checkpoint 只读看出来的值，没有 Session 参与，seq 与本连接不可比 | 只有 `value` |
| `sequenced` | 本连接内由 Host 对该 Session 算出的值，seq 在同一空间可比 | `value` 加 `seq` |

规则：

| 写入 | 遇到 `cached` 行 | 遇到 `sequenced` 行 |
|---|---|---|
| `applyCached(values)` | 覆盖 | 忽略 |
| `seed(baseline)` | 整表丢弃 `cached` 行，再按 block 写入；block 没带的键按 `seq <= cut` 清理 | higher-seq-wins |
| `apply(key, value, seq)` | 覆盖 | higher-seq-wins |

seq 比较只在同一条 Host 连接内发生：`handleConnected` 先整表 `clear()`，再由列表重新写 cached、打开会话重新 seed。从 cached 到 sequenced 是无条件替换，不看 seq。

写入口归类：

| 入口 | 行类型 |
|---|---|
| `session.list` 响应里每条摘要的 `projections` block（`manager.refreshList`） | 按 block 的 `kind`：冷会话 `cached`，活会话 `sequenced` |
| `api-session/added` 摘要的 `projections` block（`manager.handleSessionAdded`） | 按 block 的 `kind`；该摘要来自活会话，实际为 `sequenced` |
| history 首页 `projections`（`session.ts` 的 `projections.seed`） | sequenced |
| control 基线，仅活会话（`manager.replaceControlBaseline`） | sequenced |
| `refreshProjections` 的 `session.projections` 结果（正文观察） | sequenced |
| 推送 frame（`manager` 处理 `projection` frame） | sequenced |
| rename 成功后的 `title`（`session.ts`） | sequenced |

`seed` 与 `apply` 签名不变。客户端按 `kind` 分流：`sequenced` block 逐键 `apply`，`cached` block 走 `applyCached`，不读它的 `asOfSeq`。

### 不动的部分

- Session 格式、物理 header 行、`fromHeaderLine`、persistence、`SessionPersistenceSnapshot`。
- hydration 与 checkpoint 写路径，`recordFor` 的五字段全等。
- `coldSnapshot` 保留，不因没有生产调用方而删除。
- 老记录（domain v4/v5，缺 `isSeeded` 与 `inheritedEventCount`）对 seeded 会话继续 miss，等会话打开后被 v7 记录改写。
- 列表下发全部带 wire 视图的行（`contextBreakdown`、`turnOutline` 等）这一点不在本次范围。

### 最坏情形推演

1. 列表用了一份错误记录，侧边栏显示错 title，格子里是 cached 行。
2. 点进会话，首页基线到达前一瞬仍是错值。这是任何预填充都有的窗口。
3. 首页基线 `seed`：所有 cached 行先被无条件丢弃，再按 block 写入。错值零残留，与 seq 大小无关。
4. 之后列表刷新，cached 写入遇到 sequenced 行直接忽略，错值不会被刷回来。

## Alternatives considered

**把 cut 写回物理 header 行。** header-only 读取能直接拿到 cut，只读面无需改身份。代价是 Session 格式再升一版，V4 刚落地；并且要推翻 #3346"精确 cut 不伪装成 body-free metadata"的决定。否决：不为此改 header。

**由 persistence 或 session-query 维护每个会话 cut 的索引。** 新增一套 durable 索引及其一致性维护，只为服务一个展示读取。否决。

**恢复有界正文探测。** #3400 删掉的 `probeSmallCold` 思路，或由客户端对可见 seeded 会话异步 `refreshProjections`。违背列表零 I/O 原则，且历史阈值 1KB 说明它从未覆盖过正常 fork。否决。

**只用 `asOfSeq: -1` 哨兵，不给 store 分层。** 服务端一处改动即可让提示在 seq 规则下永远落败。但它靠约定成立：一旦提示 seq 与基线 cut 相等或偏高（crash-repair 截断），`apply` 保留旧行，错值存活到下一帧。用户要求建连数据无条件覆盖提示，规则要写进 store 而不是靠 seq 约定模拟。

**用 `asOfSeq: -1` 表达 cached，客户端按哨兵分流。** 只读面统一输出 `-1`，客户端把所有列表 block 当 cached。否决：一个字段同时承担两个含义，另一个含义只能靠约定推断；活会话的列表 block 带本连接可比的真实 seq，一律当 cached 就把它们也降级了，PR 评审复现了延迟到达、cut 更低的 control 基线覆盖更新列表值的回归。改为独立字段 `kind`，`asOfSeq` 保持各自来源的水位。

**把 cut 从缓存身份里彻底删掉。** fold 面需要它：`restore` 从缓存行状态继续 apply，`schedule`、`subagentCatalog`、`permissions.seeded` 与 owned/inherited 归属都编码了 cut，错误会被写回并持久化。否决。

**行类型命名 `hint` / `authoritative`。** 说的是可信度，而规则依据的是 seq 可比性。改为 `cached` / `sequenced`，名字直接说明规则用到的性质。

## Consequences

买到的：

- 重启后 fork 会话在侧边栏立即有 title、`sessionListMetadata`（blank、lastPromptAt）和其余带 wire 的缓存值，排序按最后一次提问时间。
- `@` 补全对 fork 按 title 显示和搜索。
- 建连后的数据无条件替换列表提示，不再依赖 seq 大小。
- 缓存身份的两级含义有了名字：lifecycle 身份回答"是不是同一份日志"，fold 身份回答"能不能当续算起点"。

付出的：

- `cachedSnapshot` 与 `cachedPredecessorTitle` 签名变化，Session 列表与引用调用方使用仅需 header 的签名。
- `SessionProjectionHints` 新增必填字段 `kind`，所有产出列表摘要的地方和构造摘要的测试夹具都要带上。
- 手工构造的同四字段、不同 cut 的记录会在列表上显示到会话被打开为止。
- 基线没带的键连提示一起清掉：某个 Host 未挂载 `schedule` 时，打开会话后列表提示过的 schedule 标记消失。按"建连数据是真值"这是正确行为。
- 老记录对 seeded 会话仍然 miss，直到打开重写。

## Testing

- `session-projection-cache/tests/cache.spec.ts`：seeded 冷 header 通过 `cachedSnapshot(header)` 取到全部版本匹配的行，`asOfSeq` 为行水位；unseeded header 对同一 id 的 seeded 记录被拒；`coldSnapshot` 对 cut 一致的记录从行续算、对 cut 不一致的记录整段重新 fold，对 unseeded 且 cut 非 0 的调用抛错；`cachedPredecessorTitle(header)` 对 seeded 的更旧 `formatVersion` 记录只给 `title`；不同 watermark 的多行合成一个 block，`asOfSeq` 取最低行。
- `session-projection-cache/tests/fixtures.spec.ts`：归档的 v3 到 v6 记录继续只透出 predecessor title；无 lineage 字段的归档对 seeded 调用方继续 miss。
- `api/session-controller/tests/session-cold.host.spec.ts`：seeded 冷会话摘要携带 `kind: 'cached'`、`title` 与 `sessionListMetadata`，`updatedAt` 取 `lastPromptAt`，缓存确实被查询，正文没有被读。
- `api/session-controller/tests/session-projections.host.spec.ts`：用 `sessions.fork` 造一个真实 fork 并写入 projcache，销毁整个 Context 后在同一存储根上重启 Host，只凭 header 通过 `session.list` 读到 `kind: 'cached'` 的 `title` 与 `sessionListMetadata`，`inspect` / `open` 一次都没被调用。
- `api/session-controller/tests/projection-store.client.spec.ts`：`applyCached` 只填空位、不覆盖 sequenced 行；任何 sequenced 写入（包括 cursor `-1` 的 frame 和 cut 更低的基线）替换 cached 行；基线先丢弃全部 cached 行再清理没带的键；面订阅在 cached 填充与丢弃时都收到通知。manager 路径：`cached` 列表 block 的水位再高，也被 cut 更低的 control 基线替换，之后的列表刷新拿不回来；`sequenced` 列表 block 按 higher-seq-wins，cut 更低的延迟基线既不覆盖也不清掉它，更高 seq 的 frame 仍能推进它。
- `api/session-controller/tests/manager.client.spec.ts`：`api-session/added` 的 `cached` block 被同 cursor 的 control 基线替换；`cached` 列表 block 不覆盖已有的 sequenced title。
- `api/session-controller/tests/inbox-projection.client.spec.ts`：不变，活会话的 `sequenced` 列表 block 仍压过延迟到达、cut 更低的 control 基线。
- `context/session-reference/tests/session-reference.spec.ts`：seeded 冷会话按缓存 title 标注并可按 title 搜到，没有缓存记录的会话仍按 id 标注，两者都不读日志。
