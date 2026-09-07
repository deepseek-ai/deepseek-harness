# Agent Note: Markdown 交叉链接有效性检查

Status: implemented
Archived: 2026-09-04

[English](2026-06-18-markdown-cross-link-lint.md) | 中文

## 问题

本仓库的文档通过相对路径互相链接：`[topic](../implemented/2026-…-….md)`、`[the cookbook](adding-a-tool.md)`、`[architecture.md](../../architecture.md)`。此前没有任何机制验证这些目标是否存在。重命名或移动文件会静默破坏所有指向它的链接，且在读者点击之前不可见。[doc-sync（文档同步门禁）强制执行](../../archived/process/2026-06-11-doc-sync-enforcement.md)已经将两类文档漂移的检查自动化（无法编译的代码块、陈旧的事件分类体系表），[verify-md-wrap](../../archived/process/2026-06-11-doc-sync-enforcement.md) 覆盖了第三类（硬换行的段落），但死链是第四类同样可机械检查、却仍靠肉眼验证的问题。

引入这道门禁的直接动因是 Agent Note 目录树重组：将 `docs/adr/` 与 `.agents/notes/` 统一到同一个 `.agents/notes/` 下，并设置 `proposed/`、`implemented/`、`rejected/` 子目录，需要手工重命名约 40 条文档间链接。只要有一处路径输入错误，就会在没有任何检查拦截的情况下交付断链。

## 决策

新增第四道 `doc-sync` 门禁 `verify-md-links`（`scripts/verify-md-links.ts`），风格与 `verify-md-wrap` 一致（tsx ESM、基于 AST、只验证不生成）：

- 使用 `mdast-util-from-markdown` + GFM 解析每个范围内的 Markdown 文件，遍历所有 `link`、`image`、`definition` 节点。
- 仅当目标是**相对路径**时才检查。跳过带协议的 URL（`https:`、`mailto:` 等）、协议相对路径（`//host`）、根绝对路径（`/path`，在检出目录中没有稳定基准）以及纯页内锚点（`#section`）。剥除 `#fragment`/`?query`，相对于链接所在文件的目录解析路径，并断言目标在磁盘上存在。
- 只报告、不改写；发现第一条死链即以非零状态退出。

检查范围与其他门禁一致，并额外包含 AGENTS.md 文件对以及 `.agents/skills/` 下仓库自有的 agent skill（智能体技能） Markdown（这些 skill 文件会交叉链接到 docs 目录树，因此本次重组也改写了其中的链接）：`README.md`、`docs/**/*.md`、`packages/*/README.md`、`AGENTS.md`、`packages/AGENTS.md`、`.agents/skills/**/*.md`。系统按真实路径去重（`CLAUDE.md` symlink 会解析到 AGENTS.md 文件）。该检查接入 `doc-sync`，因此相关文档变更与 CI 执行同一套断链检查。

本门禁现在也检查 Markdown 目标上的 `#fragment` 锚点——包括同文件锚点——对照标题 slug 与显式 `<a id>`；该机制与 slug 规则由 [fragment 锚点决定](2026-08-09-md-fragment-anchor-gate.zh.md)规定。

## 曾考虑的替代方案

**锚点级有效性检查**：当时以更重且价值更低为由推迟（实际发生过的问题是文件级死链），把 `#fragment` 验证留给作者人工完成。该人工规则没有守住；[fragment 锚点决定](2026-08-09-md-fragment-anchor-gate.zh.md)后来补上了这项检查。

## 后果

- 造成交叉链接失效的重命名与移动会直接使 `doc-sync` 和 CI 失败，而不是等读者点击死链才暴露。由此，引入该门禁的 Agent Note 重组具备自校验能力：该检查证明其自身改写的链接均未悬空。
- `doc-sync` 链中多了一个快速 tsx 脚本；无新增依赖（mdast/GFM 技术栈已作为 `verify-md-wrap` 的 devDependencies 存在）。
- 该门禁强制执行的约定是：文档交叉引用必须使用可机械检查的相对链接，绝不能只写纯文本或编号。[docs/AGENTS.md](../../../../docs/AGENTS.md)记录了这项约定，使作者了解该门禁及其理由。
