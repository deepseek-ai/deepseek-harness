# Agent Note: 投影缓存跨版本读兼容（session_projcache v3/v4/v5 → v6）

Status: implemented

[English](2026-09-02-projcache-cross-version-read-compat.md) | 中文

## 问题

`session_projcache` 存储域在已发布版本间演进了三代磁盘结构。升级后的 DSH_HOME 出现两类故障：

- **v3 单文件 home 升级后启动硬失败**：per-record 布局的 legacy bootstrap 迁移旧单文件时不检查其 `unit.version`，把旧记录原样打上当前版本戳写入新树；domain 层开域时逐条 zod 校验，旧记录缺新增必填字段 → `invalid-record` → 整个域拒开 → 插件树加载失败。且 bootstrap 先写盘后校验，**首次启动即把坏文档永久写入新树**（"投毒"）——此后每次启动新树非空、连 legacy 路径都不再走，home 持续不可用。
- **v4 per-record home 升级后列表丢标题**：v4 文档被版本戳检查静默丢弃（per-record 契约），SessionList 是零 I/O 纯缓存读，miss 后整行不带投影；标题要等每个会话被逐个重新打开后才恢复。

缓存域自身的契约是"过期或不可读的缓存只付出更长的尾部重放，绝不给出错值、绝不拒载"——硬失败与整体丢弃都违背该契约的前半句或产品预期。

## 三代磁盘结构差异

| domain version | 携带发布 | 布局 | 磁盘形态 | identity 字段 | 行字段 |
|---|---|---|---|---|---|
| 3 | 0.1.1-rc.2 | single | 单文件 `storages/session_projcache.json`（`{unit:{name,version}, global, tables}`） | `createdAt`, `cwd?` | `ver`, `seq`, `val` |
| 4 | 0.1.2-alpha.3 | per-record | 每会话一份 `storages/session_projcache/sessions/<sessionId>.json`（`{version, record}`） | `createdAt`, `cwd?` | 同上 |
| 5 | 0.1.2-alpha.4 | per-record | 同 v4 | + `isSeeded`（v5 首发必填；现为 optional）、`inheritedEventCount`（同前） | 同上（`seq` 数值语义与 v4 相同，仅类型加 brand） |

v4→v5 的唯一实质差异是 identity 新增两个 lineage 字段；行内 `ver/seq/val` 三代一致，`seq` 的数值含义未变（[2026-08-31 seq/offset brands note](2026-08-31-session-sequence-and-log-offset-brands.zh.md) 明确 on-disk 数值不变）。v3→v4 是布局迁移，记录内容结构一致。

另有一种衍生形态：跑过一次 v5 版本的 v3 home（投毒态）——新树里存在**版本戳为 5 但内容是 v3 记录**（缺 lineage 字段）的文档。

## 决策

声明式读兼容——读容忍 owner 背书过的旧版本，写恒戳当前版本：

1. **`DomainSpec.compatibleVersions`（新增，可选）**：域 owner 声明"这些旧版本的存量记录在当前记录 schema 下也可读"（典型手段：新增字段标 optional）。`defineDomain` 校验各项为小于当前 version 的非负整数；`descriptorOf` 透传到后端 `KvUnitDescriptor`。
2. **json 后端 per-record 读**：接受"当前版本 ∪ compatibleVersions"内的版本戳，集合外照旧视为 foreign 丢弃；**写路径永远戳当前版本**（读到旧记录后的下一次 checkpoint 自然把它推进到当前版本）。single 布局维持 exact-version 不变。
3. **legacy bootstrap 版本把关（bug 修复本体）**：旧单文件的 `unit.version` 必须落在接受集合内才迁移，否则视为空 unit 留在原地——为 owner 未背书的记录打当前版本戳，会把"可丢弃的过期缓存"变成 domain 层的 schema 硬失败。
4. **projcache 域声明 `version: 6, compatibleVersions: [3, 4, 5]`**；两个 lineage 字段改为 `.optional()`。唯一消费 stored identity 的读点 `identityMatches` 把缺失归一化为 unseeded lineage（`?? false` / `?? 0`）：对非 fork 会话这是精确值；fork 会话的 expected 是 seeded → 天然 mismatch → 丢弃冷读重建，lineage 绑定的防护不放松。
5. **投毒态自愈**：v5 戳缺 lineage 字段的文档被声明为兼容，并由 optional schema 接受（内容本就是升级前的真实缓存数据），home 恢复可启动且标题立即可服务。
6. **schema 校验兜底：`invalidRecords: 'backup-and-skip'`（仅本域声明）**。读兼容之外仍然解析失败的存量记录不再让整个域拒开：domain 层调用后端的 `KvUnit.backupRecord`（json per-record 实现＝把文档改名为 `<key>.json.bak.<YYYYMMDDHHmm>`，字节留档、不再被读取），用 `logger.error` 打印具体失败信息（域名、表、键、移动去向、zod 失败原因），随后当该记录不存在继续启动；下一次冷读会重建并重写该会话的缓存。**该策略是域级显式声明，缺省仍为 fail-loud**——其他业务域的存量数据校验失败照旧整域拒载；后端没有 `backupRecord` 能力（single 布局、行存储）时也回退 fail-loud。命名沿革：quarantine → backup-and-skip（用户裁决：词要同时含"备份"与"跳过"两义，且与 `.bak` 后缀同源；skip-backup 因 CLI `--skip-X` 惯例存在"不备份"反读而弃用）。对本域而言，该策略取代了 [2026-07-28 存储恢复提案](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.zh.md)中 reset/destroy 的恢复途径；该提案对权威介质与整介质损坏仍然有效。

### v5 → v6 兼容方式

版本 6 只改变当前写入的版本戳，沿用 v5 记录 schema。`compatibleVersions: [3, 4, 5]` 因此同时接受健康的 v5 记录，以及错误 bootstrap 生成的 v5 戳、缺 lineage 记录。当前 schema 允许 lineage 缺失；`identityMatches` 将其解释为 unseeded，并对 seeded 会话拒绝该记录。下一次成功的 checkpoint 会用 v6 戳和完整 lineage 重写已接受的 v5 记录。启动时不单独运行 v5→v6 重写：未接受的版本读作不存在，schema 校验失败的已接受记录则执行 `backup-and-skip`。

### 升级矩阵

| home 形态 | 修复后行为 |
|---|---|
| v3 单文件（未投毒） | bootstrap 迁移（3 ∈ 接受集）→ 标题立即可服务 |
| v3 + 投毒新树 | 新树文档直接读入（optional 容忍）→ 启动恢复、标题立即可服务 |
| v4 per-record | 文档直接读入（4 ∈ 接受集）→ 标题立即可服务 |
| v5 正常 | 文档直接读入（5 ∈ 接受集）→ 标题立即可服务 |
| v6 当前版本 | 不受影响 |
| fork（seeded）会话的旧记录 | identity mismatch → 丢弃，打开会话时冷读重建（安全侧） |

## 备选方案

- **只丢弃重建**（bootstrap 把关但不声明兼容版本）：启动可修，但升级后 SessionList 标题全丢、要逐会话打开才恢复——不满足升级即用的产品要求。
- **schema `.default()` 填缺省**：行为与 optional+读点归一化等价，但把"缺失=unseeded"的解释固化进 durable schema 的输出类型；拍板为 optional——schema 如实描述介质上所有被接受的形态，解释权在消费点（2026-09-02 用户裁决）。
- **域版本回退到 4**：改动很小，但破坏版本单调性、依赖"bootstrap 不查版本"这个 bug 本身、且投毒态与正常 v5 home 的缓存全被丢弃。

## 影响

- 部署方若把本域路由到 sqlite 后端，得不到任何容忍能力：sqlite 既未实现 `compatibleVersions` 也没有 `backupRecord`，行为退化为原有的严格版本语义（整 unit 版本不匹配仍 `version-mismatch` 拒开；不放松、不出错值）。shipped 组合固定路由 json，此风险仅存在于部署配置层面。
- optional lineage 字段允许被接受的记录缺少 lineage：无 lineage 的记录会解码为 unseeded。身份比对仍会对 seeded 调用方拒收，逐行 `ver` 守卫仍筛查每个值，残余暴露面只是 unseeded 调用方读到 unseeded 形态的记录——与真实 pre-lineage 记录享有的信任完全相同。
- `backupRecord` 对同一键的同一分钟内重复备份会覆盖前一份（新字节胜出）；不同分钟、不同键永不冲突。

## 测试

- `storage-json` 单测：compat 版本戳读入/集合外丢弃/写恒当前版本；legacy bootstrap 仅在版本被接受时迁移（含迁移后文档戳当前版本断言）；`backupRecord` 移档/读缺席/重写/封闭守卫。
- `storage-domain` 单测：`compatibleVersions`/`invalidRecords` 声明校验；后端无 `backupRecord` 时 backup-and-skip 回退 fail-loud。
- `session-projection-cache` 单测：缺 lineage 字段的记录对 unseeded 会话按原值服务、对 seeded 会话丢弃。
- **归档 fixtures 独立恢复测试**（`tests/fixtures.spec.ts` + `tests/fixtures/`）：真实发布物产出的四份介质存档——`v3-single-unit.json`（0.1.1-rc.2 整域单文件）、`v4-session-doc.json`（0.1.2-alpha.3）、`v5-session-doc.json`（0.1.2-alpha.4）、`v5-lineageless-doc.json`（无守卫 bootstrap 的投毒形态，由 v3 记录合成）——逐一走真实存储栈开域，断言列表读出归档标题、且 live 写把文档重写为当前版本（v6 戳 + lineage 字段 + 新值）；外加 schema 失败记录的 backup-and-skip 行为（启动不失败、`.bak` 落盘、日志具体、邻居记录不受累）。
- 端到端验收，以真实发布物执行：已发布的 0.1.1-rc.2 与 0.1.2-alpha.3 npm 包经各自 web app 造数（真实模型对话 + rename RPC），已发布的 0.1.2-alpha.4 包复现两类故障（含投毒树），修复后构建对纯净 v3、投毒 v3、v4、全新四种 home 形态经 SessionList RPC 原样返回记录在案的标题。

未来 bump 流程：新版本结构若可用"optional 字段 + 读点归一化"容忍旧记录，就把旧版本加入 `compatibleVersions`；否则正常 bump（丢弃重建），并把不再兼容的版本从集合中移除。无论哪条路，包 README 都要求 bump 随附归档 fixture 和论证所选处置方式的测试。
