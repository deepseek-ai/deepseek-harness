# Agent Note: 按子系统生成的 cordis-surface 区块

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-per-subsystem-cordis-surface-regions.md) | 中文

## 问题

一个子系统的文档过去分散在三个归属：手写的 subsystems 页面（介绍、数据结构、动词）、平铺生成的 `docs/cordis-catalog/services.md` 中属于它的 `ctx.<key>` 切片，以及平铺的 `docs/cordis-catalog/events.md` 中属于其事件作用域的切片。shell.md 的读者必须再打开两份文档，才能看到该页面正在描述的服务接口与事件；除了手工维护的链接，没有任何机制把这三个视图联系在一起。平铺目录还游离在双语语料之外（生成输出只有英文，故被排除在配对之外），因此，这套参考内容完全没有中文入口。

[生成式目录决策](../../archived/process/2026-06-20-generated-cordis-catalog.md)本身（从源码生成、`@mode` 标签交叉校验、失败关闭的类型链接覆盖、`ts cordis-catalog` 围栏）不在质疑之列；改变的只是生成输出「落在哪里」。

## 决策

`gen-cordis-catalog.ts` 把每个子系统的服务与事件参考注入到该子系统自己的页面内部，置于 `<!-- BEGIN GENERATED cordis-surface … -->` / `<!-- END GENERATED cordis-surface -->` 标记之间；平铺的 services/events 目录随之删除。现在，每个子系统由一个页面同时承载介绍、数据结构和生成的接线接口参考。

- **人工维护、异常时明确报错的划分。** `SERVICE_PAGE` 把发现的每个 `ctx.<key>` 映射到恰好一个页面；`EVENT_SCOPE_PAGE` 映射每个事件作用域。生成器在两个方向上都会直接报错（既有被发现却未映射的服务或作用域，也有已映射但遍历不再发现的键或作用域），因此，划分不会与源码中的接口范围脱节。独立的 AST 扫描读取 `packages/*/*/src/**` 下每一个 `declare module 'cordis'` merge 块，为投影在服务与事件两侧的盲区兜底：投影渲染不了的已声明 Context key 或 Events 成员必须在 `SERVICE_WALK_EXEMPTIONS`/`EVENT_WALK_EXEMPTIONS` 中带着点名理由，陈旧豁免直接报错，且投影渲染的一切也必须对扫描可见（扫描约定归[事件兜底决定](../architecture/2026-08-09-cordis-event-walk-backstop.zh.md)所有）；教会投影渲染接口类型条目的后续工作由 `TODO(cordis-catalog-interface-services)` 标记。
- **区块在配对两侧按字节一致。** 生成器把同一份英文区块字节写入 `foo.md` 和 `foo.zh.md`，是对「围栏代码块在配对两侧逐字节一致」这一既有规则的延伸。`verify-translation-pairing` 新增了专门的区块一致性检查（标记语法归 `translation-pairing.ts` 中的 `partitionGeneratedRegions` 所有），能精确点名出现分歧或格式错误的区块；整篇文档的结构签名仍会把区块内容再覆盖一遍。
- **带防护的配对自动记录。** 一次改变区块字节的重新生成会让每个被触及的配对失去同步，因此生成器会自行重新记录配对的 `.i18n.yaml`，但仅限本次写入完全限定在区块内的情况：两侧记录的 blob hash 必须与写入前的字节相符，且两侧剥离区块后的内容必须没有变化。人工行文若有漂移，记录就保持陈旧，配对门禁因此仍会强制走正常翻译流程；全新的配对绝不自动记录（那归作者经评审的 `--write` 所有）。这样 `.i18n.yaml` 保持为纯粹的 `git hash-object` 值：不引入任何「剥离后 hash」的语义变化。
- **继承层搬了家，而非消亡。** vendor 的 `ctx` 成员与 `internal/*`/loader/hmr/timer 事件渲染到 `docs/cordis-api/inherited.md`，紧邻迁移后的 Cordis 核心 API 页面（`docs/cordis-catalog/core/` → `docs/cordis-api/`）。框架表面落在框架自己的归属之下；harness 页面仍是仓库自有的词汇。
- **页内链接。** 签名的 `Types:` 行链接到兄弟页面（`core.md`、`shell.md`）；若某个类型的主要页面就是正在渲染的页面，该类型会从该行去掉，而不是链接到自身。页面用 `#cordis-surface` 或 `#ctx<key>--<class>` 锚点引用自己的区块：每个生成标题前都有一个显式 `<a id>`，携带 GitHub slug（即平铺目录时期的历史锚点），因此这些片段在 GitHub 与 VitePress 站点上解析一致——后者自带的 slugger 对含大量标点的标题会得出不同结果。

## 曾考虑的替代方案

- **平铺目录与区块并存、两者都生成**：否决。每次 JSDoc 编辑都会产生双份 diff 噪音，而本次变更本要消除的分散状况（一个子系统、三份文档）也将延续。
- **整页归生成器所有、手写介绍放进片段文件**：否决。叙述性行文占每个现有页面的大部分，应当留在被评审的文档本身；标记只需增加一条语法规则，同时还能让作者继续编辑真实文件。
- **本地化区块（生成器同时输出中文）**：推迟，与 i18n README 中针对其余生成文档的长期备注同属一个状态：教会生成器输出中文意味着要翻译源码 JSDoc，而那是本次变更并不需要的机制。zh 页面里的英文区块，与「英文 JSDoc 出现在逐字节一致的围栏代码块内」这一既有现状相符。
- **在 `.i18n.yaml` 中对剥离区块后的内容做 hash**：否决。记录将不再是文件的 `git hash-object`，这会破坏「还原上次确认文本」的性质，也会破坏每个自行重算 hash 的消费方。

## 后果

- 一个子系统的完整说明集中在一个页面上：`docs/subsystems/<name>.md`（及其配对文件）承载介绍、数据结构／动词，以及生成的服务／事件接口参考；`docs/cordis-catalog/` 不复存在。
- 新的服务或事件作用域无法在未记录、未映射的状态下落地：在 `SERVICE_PAGE`/`EVENT_SCOPE_PAGE` 点名其所属页面之前，生成器一直失败，而且该页面必须已经存在，并在两个语言侧都带有标记。
- 源码 JSDoc 变更后的重新生成会触及两种语言的受影响页面，外加（当写入限定在区块内时）它们的配对记录：一份机械、可评审的 diff。行文编辑仍然要走翻译流程，因为自动记录防护会拒绝它们。
- 网站的子系统导航列出每个页面（每个 locale 38 条路由：35 个已翻译配对，加上仍为英文镜像的 goal/terminal/commands 三页），取代两个平铺目录导航项；Cordis API 一节新增 `inherited.md`。
- `packages/typert/generator/tests/cordis-catalog-contract.spec.ts` 固定区块渲染器（`renderPageRegion`）、同页链接去除规则，以及异常时明确报错的 JSDoc 与类型链接校验；`scripts/translation-pairing.spec.ts` 固定标记语法与 blob hash 原语；`scripts/gen-cordis-catalog-record.spec.ts` 证明自动重录守卫拒绝每一种非法状态（陈旧记录、格式错误或键被改名的伴随记录、多余条目、行文漂移、记录缺失、快照缺失）。
