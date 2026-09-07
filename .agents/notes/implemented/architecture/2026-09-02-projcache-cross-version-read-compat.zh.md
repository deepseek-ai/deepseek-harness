# Agent Note: 投影缓存前代恢复与 Session 格式绑定（session_projcache v3-v6 → v7）

Status: implemented

[English](2026-09-02-projcache-cross-version-read-compat.md) | 中文

## 问题

`session_projcache` 存储域演进过多代磁盘结构。升级后的 DSH_HOME 暴露了三类风险：

- **v3 单文件 home 升级后启动硬失败**：per-record 布局的 legacy bootstrap 迁移旧单文件时不检查其 `unit.version`，把旧记录原样打上当前版本戳写入新树；domain 层开域时逐条 zod 校验，旧记录缺新增必填字段 → `invalid-record` → 整个域拒开 → 插件树加载失败。且 bootstrap 先写盘后校验，**首次启动即把坏文档永久写入新树**（"投毒"）——此后每次启动新树非空、连 legacy 路径都不再走，home 持续不可用。
- **v4 per-record home 升级后列表丢标题**：v4 文档被版本戳检查静默丢弃（per-record 契约），SessionList 是零 I/O 纯缓存读，miss 后整行不带投影；标题要等每个会话被逐个重新打开后才恢复。
- **Session 格式递增可能复用按旧事件语义折叠的结果**：版本 3 至 6 不记录 Session 格式代。若把缺失代视为当前代，缓存行就能绕过有界历史规范化或改变基数的迁移。

缓存域自身的契约是"过期或不可读的缓存只付出更长的尾部重放，绝不给出错值、绝不拒载"——硬失败与整体丢弃都违背该契约的前半句或产品预期。

## 磁盘结构代际

| domain version | 携带发布 | 布局 | 磁盘形态 | identity 字段 | 行字段 |
|---|---|---|---|---|---|
| 3 | 0.1.1-rc.2 | single | 单文件 `storages/session_projcache.json`（`{unit:{name,version}, global, tables}`） | `createdAt`, `cwd?` | `ver`, `seq`, `val` |
| 4 | 0.1.2-alpha.3 | per-record | 每会话一份 `storages/session_projcache/sessions/<sessionId>.json`（`{version, record}`） | `createdAt`, `cwd?` | 同上 |
| 5 | 0.1.2-alpha.4 | per-record | 同 v4 | + `isSeeded`（v5 首发必填；现为 optional）、`inheritedEventCount`（同前） | 同上（`seq` 数值语义与 v4 相同，仅类型加 brand） |
| 6 | v1 之前的 mainline | per-record | 同 v5 | 同 v5 | 同上 |
| 7 | 当前版本 | per-record | 同 v5 | + `formatVersion`；当前写入也要求两个 lineage 字段 | 同上 |

v4→v5 的唯一实质差异是 identity 新增两个 lineage 字段；v6 只改变写入版本戳。这些前代的行内 `ver/seq/val` 表示一致，`seq` 的数值含义未变（[2026-08-31 seq/offset brands note](../../archived/architecture/2026-08-31-session-sequence-and-log-offset-brands.md) 明确 on-disk 数值不变）。v3→v4 是布局迁移，记录内容结构一致。v7 把 Session 格式代加入缓存 identity，因为无法从 domain 版本戳推导行语义。

另有一种衍生形态：跑过一次 v5 版本的 v3 home（投毒态）——新树里存在**版本戳为 5 但内容是 v3 记录**（缺 lineage 字段）的文档。

## 决策

声明式读兼容——读容忍 owner 背书过的旧版本，写恒戳当前版本：

1. **`DomainSpec.compatibleVersions`（新增，可选）**：域 owner 声明"这些旧版本的存量记录在当前记录 schema 下也可读"（典型手段：新增字段标 optional）。`defineDomain` 校验各项为小于当前 version 的非负整数；`descriptorOf` 透传到后端 `KvUnitDescriptor`。
2. **json 后端 per-record 读**：接受"当前版本 ∪ compatibleVersions"内的版本戳，集合外照旧视为 foreign 丢弃；**写路径永远戳当前版本**（读到旧记录后的下一次 checkpoint 自然把它推进到当前版本）。single 布局维持 exact-version 不变。
3. **legacy bootstrap 版本把关（bug 修复本体）**：旧单文件的 `unit.version` 必须落在接受集合内才迁移，否则视为空 unit 留在原地——为 owner 未背书的记录打当前版本戳，会把"可丢弃的过期缓存"变成 domain 层的 schema 硬失败。
4. **projcache 域声明 `version: 7, compatibleVersions: [3, 4, 5, 6]`**；存储 schema 中的格式与 lineage identity 字段均为 optional，使 owner 背书的前代记录可以打开。当前写入始终包含这三个字段。
5. **identity 匹配比结构准入更严格**：缺失 `formatVersion` 的记录绝不匹配当前 Session，因此前代行不能播种投影，而会从权威日志重新折叠。格式匹配后，`identityMatches` 才把缺失 lineage 归一化为 unseeded（`?? false` / `?? 0`）：对 unseeded 会话精确，对 seeded 期望则匹配失败。v5 投毒 home 因而可以安全启动，但其未绑定行不会作为当前值暴露。
6. **schema 校验兜底：`invalidRecords: 'backup-and-skip'`（仅本域声明）**。读兼容之外仍然解析失败的存量记录不再让整个域拒开：domain 层调用后端的 `KvUnit.backupRecord`（json per-record 实现＝把文档改名为 `<key>.json.bak.<YYYYMMDDHHmm>`，字节留档、不再被读取），用 `logger.error` 打印具体失败信息（域名、表、键、移动去向、zod 失败原因），随后当该记录不存在继续启动；下一次冷读会重建并重写该会话的缓存。**该策略是域级显式声明，缺省仍为 fail-loud**——其他业务域的存量数据校验失败照旧整域拒载；后端没有 `backupRecord` 能力（single 布局、行存储）时也回退 fail-loud。命名沿革：quarantine → backup-and-skip（用户裁决：词要同时含"备份"与"跳过"两义，且与 `.bak` 后缀同源；skip-backup 因 CLI `--skip-X` 惯例存在"不备份"反读而弃用）。对本域而言，该策略取代了 [2026-07-28 存储恢复提案](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.zh.md)中 reset/destroy 的恢复途径；该提案对权威介质与整介质损坏仍然有效。

7. **predecessor title 是列表 hint，而不是 fold shortcut**：Session list 启动保持 metadata/cache-only，绝不打开冷 log body。log header 是权威来源；生命周期匹配的 checkpoint 是 durable prefix witness，可以落后但不能领先日志。因此 `cachedPredecessorTitle` 只公开仍通过当前 title unit `stateVersion` 与 schema 的 predecessor `title` row。两条相邻 Session format edge 都保留 title 文本。该 hint 使用 `asOfSeq: -1`，而不使用存储 row 的序号，因为改变日志事件数量的迁移会重新映射该坐标。其他 predecessor row 继续隐藏，`hydratePrepared`/`coldSnapshot` 仍要求严格格式 identity，因为即使物理存储一致，normalizer 仍可能改变 `blank` 或 `lastPromptAt` 等值。

### v3-v6 → v7 处置

版本 3 至 6 仍可结构化读取，因为它们的记录与行表示是当前 schema 的有效输入。其 identity 缺少 `formatVersion`，因此有意不能作为当前折叠捷径。unseeded 且生命周期匹配的记录仍可向零 I/O 列表提供版本兼容的 title，但不能提供任何权威 seed。冷读或实时检查点会从迁移后的 Session 日志重建值，并写入带完整格式与 lineage identity 的 v7 记录。启动时不运行 eager 值迁移；schema 校验失败的已接受记录执行 `backup-and-skip`。

### 升级矩阵

| home 形态 | 修复后行为 |
|---|---|
| v3 单文件（未投毒） | bootstrap 迁移（3 ∈ 接受集）→ 启动成功；兼容 title 在列表可见，未绑定折叠等待冷重建 |
| v3 + 投毒新树 | optional 字段让新树文档可解析 → 启动恢复；兼容 title 在列表可见，未绑定折叠等待冷重建 |
| v4/v5/v6 per-record | 文档结构化读入 → 缺格式代而拒绝 fold shortcut；兼容 title 在列表可见；当前检查点重写 v7 |
| identity 匹配的 v7 当前记录 | 正常服务缓存值 |
| 格式匹配但缺 lineage 的记录 | unseeded 调用方可以使用；seeded 调用方拒绝并回落冷折叠 |

## 备选方案

- **在存储层拒绝前代版本戳**：对投影安全，但会阻止受保护的 legacy bootstrap，也无法保留结构完好的记录直到权威重折叠替换它。结构准入加语义 identity 拒绝既让启动可恢复，也不服务未经证明的值。
- **在所有用途中把缺失格式代视为当前代**：可以保留缓存值，但让迁移前折叠绕过 Session 格式边。不采用，因为 v0→v1 含有界历史规范化，后续边还可能改变事件基数。title-only 列表 hint 更窄：它不播种 fold，而且 title 文本在已安装 edge 之间保持不变。
- **schema `.default()` 填缺省**：行为与 optional+读点归一化等价，但把"缺失=unseeded"的解释固化进 durable schema 的输出类型；拍板为 optional——schema 如实描述介质上所有被接受的形态，解释权在消费点（2026-09-02 用户裁决）。
- **域版本回退到 4**：改动很小，但破坏版本单调性、依赖"bootstrap 不查版本"这个 bug 本身、且投毒态与正常 v5 home 的缓存全被丢弃。

## 影响

- 部署方若把本域路由到 sqlite 后端，得不到任何容忍能力：sqlite 既未实现 `compatibleVersions` 也没有 `backupRecord`，行为退化为原有的严格版本语义（整 unit 版本不匹配仍 `version-mismatch` 拒开；不放松、不出错值）。shipped 组合固定路由 json，此风险仅存在于部署配置层面。
- optional 格式字段允许前代记录通过结构校验，但缺失格式始终无法通过当前 identity 匹配。只有格式匹配后才归一化 optional lineage；seeded 调用方仍拒绝缺 lineage 的记录。逐行 `ver` 守卫继续筛查每个实际服务的值。
- `backupRecord` 对同一键的同一分钟内重复备份会覆盖前一份（新字节胜出）；不同分钟、不同键永不冲突。

## 测试

- `storage-json` 单测：compat 版本戳读入/集合外丢弃/写恒当前版本；legacy bootstrap 仅在版本被接受时迁移（含迁移后文档戳当前版本断言）；`backupRecord` 移档/读缺席/重写/封闭守卫。
- `storage-domain` 单测：`compatibleVersions`/`invalidRecords` 声明校验；后端无 `backupRecord` 时 backup-and-skip 回退 fail-loud。
- `session-projection-cache` 单测：格式匹配且缺 lineage 的记录只服务 unseeded Session；缺格式代的前代记录不能播种 fold，但只能提供其兼容 title hint。
- **归档 fixtures 独立恢复测试**（`tests/fixtures.spec.ts` + `tests/fixtures/`）：真实发布物产出的四份介质存档——`v3-single-unit.json`（0.1.1-rc.2 整域单文件）、`v4-session-doc.json`（0.1.2-alpha.3）、`v5-session-doc.json`（0.1.2-alpha.4）、`v5-lineageless-doc.json`（无守卫 bootstrap 的投毒形态，由 v3 记录合成）——逐一走真实存储栈开域、只服务其兼容 predecessor title、绝不服务其未绑定折叠，随后由实时写入替换成带完整 identity 与新值的 v7 记录。同一套件还证明 schema 失败记录的 backup-and-skip：启动不失败、`.bak` 落盘、诊断点名失败，且邻近前代记录仍可重写。

未来 bump 流程：只有当前存储 schema 能解析旧 domain 版本时，才把它加入 `compatibleVersions`，再由 owner reader 判断其语义 identity 是否充分。Session 格式变化绝不继承缺失的格式代。包 README 要求每次 bump 都随附归档 fixture 与测试，证明结构准入、语义使用或拒绝，以及当前重写。
