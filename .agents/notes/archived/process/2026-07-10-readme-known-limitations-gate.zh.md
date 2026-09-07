# Agent Note: 每个包 README 中受门禁保护的「已知限制」章节

Status: implemented
Archived: 2026-09-04

[English](2026-07-10-readme-known-limitations-gate.md) | 中文

## 问题

[文档标准](../../../../docs/AGENTS.md)规定限制项归属包 README。没有统一结构时，章节缺失便无法区分“经审计确认没有限制”与“忘记编写文档”，不同的标题还会妨碍全仓库搜索。

## 决策

每份位于 `packages/<group>/<pkg>/package.json` 的 manifest（元数据清单）都有一个同级 README，其中包含规范的 `## Known Limitations and Deferred Work` 章节。其中的项目符号记录由该包负责的长期消费方缺口和不明显的维护者约束；一般清理事项仍留在源码 TODO 或所属 Agent Note 中。[`verify-package-readme-limitations` 门禁](../../../../scripts/verify-package-readme-limitations.ts)从 manifest 推导包集合，拒绝缺失 README，并要求恰好一个规范的 H2 标题，且至少包含一个顶层项目符号。“Limitations”“Deferred”“What is NOT here”或“Non-goals”等近似标题都会失败。

如果一个包确实没有需要声明的限制事项，则将其列入 `NO_LIMITATIONS` 并省略该章节。新增限制事项时须移除该条目；包重命名或移除后，陈旧条目会使门禁失败，因为每个条目都必须对应一个被扫描的包。

门禁检查存在性、形状和允许列表。评审依据文档与[行文](../../../skills/dsh-prose-standard/SKILL.md)标准检查覆盖面和准确性。常设规则位于 [packages/AGENTS.md](../../../../packages/AGENTS.md)。

## 曾考虑的替代方案

- **自由格式标题**：无法统一搜索，仍需近似标题检测。
- **要求空章节或写 "None."**：样板文字可能在包新增限制事项后仍然残留；允许列表使「确实没有限制事项」这一状态显式且可评审。
- **设置词数上限**：合理的限制事项数量因包而异，因此由评审管控这一不设词数预算的 README 层级。

## 后果

- 新建的包须声明符合条件的限制事项，或显式加入白名单；缺失、漂移或空的章节会在本地和 CI 的 `doc-sync` 中失败。
- 门禁为 `doc-sync` 新增一个无外部依赖的 TypeScript 脚本。
- 重命名受强制的标题需要同时修改脚本和所有包 README。
