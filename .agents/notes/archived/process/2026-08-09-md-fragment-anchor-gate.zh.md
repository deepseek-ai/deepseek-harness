# Agent Note: verify-md-links 校验 fragment 锚点，消除最后一类死链

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-md-fragment-anchor-gate.md) | 中文

## 问题

`verify-md-links` 只证明相对链接的目标文件存在，从不检查 `#fragment`，文档标准以一条人工规则补偿：重命名标题前自己 grep 锚点。一次语料扫描发现 15 条链接的 fragment 在目标中没有对应锚点——三种衰变模式：链接写下后标题被改写（`#security-and-authority-are-explicit-non-goals` 对 note 现在的 `Security and authority are non-goals`）、约定搬迁到另一份属主文档（`tool-fs` 链到 seam README，而无超时规则现居 group README）、zh 侧链接其中文标题永远不会生成的英文 slug（`#deferred-work` 对 `## 推迟工作`）。这些都不触发任何 gate，且每条都把读者悄悄丢在目标页顶部。

## 决策

`verify-md-links` 现在也解析 fragment（取代[跨链接决策](2026-06-18-markdown-cross-link-lint.zh.md)中暂缓纳入该检查范围的决定）。对每条目标为 Markdown 文件的相对链接——包括旧检查器完全跳过的同文件 `#anchor` 链接——fragment 必须命名目标中的真实锚点：标题的 GitHub slug，或真实 HTML 流中的显式 `<a id>`（代码示例与注释掉的锚点不注册任何东西）。slug 由仓库自有的 `markdownHeadingLines` 从**渲染后**的标题文本计算，因此，标题内的链接、行内代码与强调都会按 GitHub 的渲染结果参与 slug 计算；下划线保留（`#showcase-web_fetch`）；重复 slug 获得 GitHub 的占用集 `-1`、`-2`……后缀；匹配区分大小写，因为元素 id 本就区分大小写。指向非 Markdown 目标的 fragment（`file.ts#L10`）语义归渲染器所有，不在范围内；外部与根绝对 URL 同样不检查。锚点集合对任意存在的目标惰性收集（`anchorCache`），因此链入归档 note 与 vendor 文档的链接照常校验，而这些文件不会因此成为扫描源。

slug 函数与 `gen-cordis-catalog` 的区块锚点 slugger 不同（后者丢弃下划线）：生成器的标题总能通过其显式 `<a id>` 锚点到达，两者无需共享一条规则。中文侧沿用既有语料惯例（`docs/glossary.zh.md`、`docs/cordis-primer.zh.md`）：链接保留英文 fragment，在中文标题前放置显式 `<a id>`，使两个语言侧暴露相同的锚点。

15 条坏 fragment 在同一变更中修复：陈旧 slug 重定向到当前标题，搬迁的无超时约定改链其属主 group README，四份中文文档补上显式锚点。`docs/AGENTS.md` 与 `dsh-doc` skill 不再要求为 Markdown 链接手工 grep 锚点；人工 grep 只对输出从不进入受检 Markdown 的 TypeScript 字符串锚点保留（三处受扫描引用全部渲染进受检页面，因此 gate 经由提交的产物覆盖它们）。

## 验证

`scripts/verify-md-links.spec.ts` 证明各验收路径：渲染文本 slug 化（反引号、标点、含链接标题、保留下划线）、占用集重复后缀、围栏/行内代码/注释中的 `<a id>` 不注册、全部可解析的混合链接文档、死的同文件与跨文件 fragment、大小写变体 fragment、以及缺失目标仍报 `target` 而非 `anchor`。gate 在 doc-sync 中跑完整语料（`verify-md-links`），且只有在 15 条修复之后才通过——语料本身就是每种衰变模式由红转绿的证据。

## 曾考虑的替代方案

- **保留人工 grep 规则。** 它被证明守不住：15 条 fragment 在 gate 驱动的维护文化下仍然衰变，因为改写标题的 PR 从不会去看入链。可机械检查的不变式应进入被执行的 gate。
- **让中文链接指向中文 slug 锚点。** GitHub 对 CJK 标题的 slug 没问题，但语料惯例已是显式 `<a id>` + 英文 fragment（glossary、primer），且它在剥离非 ASCII 的渲染器下也存活；引入第二种惯例会割裂语料。
- **与 typert 生成器共享 `githubSlug`。** 为一个函数引入包构建耦合不值得，且两条规则确实不同（生成器剥离下划线；其锚点是 gate 直接读取的显式 `<a id>`），分歧是设计使然而非漂移。
- **同时校验 VitePress slug。** 发布站点的死链检查已在 `website:build` 中运行；生成区块正是为两种渲染器一致而携带显式锚点，手写标题若有分歧会在那里失败。

## 后果

重命名标题现在会在任何 Markdown 链接引用其锚点处使构建失败，而非把读者丢在页顶；作者须在同一变更中修复入链，与文件重命名的既有义务完全一致。同文件锚点不再是盲区，中文页面使用英文 fragment 时必须补锚点。人工的重命名前 grep 只对输出从不进入受检 Markdown 的 TypeScript 字符串锚点保留。
