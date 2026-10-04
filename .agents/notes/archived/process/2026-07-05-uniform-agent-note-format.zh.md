# Agent Note: Agent Note 的统一受门禁约束的文件内格式

Status: implemented
Archived: 2026-09-30

[English](2026-07-05-uniform-agent-note-format.md) | 中文

## 问题

Agent Note 的路径编码了生命周期和类别，但文件内容仍混杂着不同标题、状态格式、ADR 与提案模板，以及已实现记录中的提案阶段章节。作者会复制随手找到的相邻文件，而生命周期迁移可能跳过必要的改写，因为没有门禁强制执行文件内约定。

## 决策

[README.md § 文件格式](../../README.zh.md#the-file-format)是文件内约定——头部块（`# Agent Note: <title>`，加上无日期且与文件夹一致的 `Status:` 枚举，其中只有拒绝原因可作为额外内容）、各生命周期的正文骨架（所有文件均以 `Problem` 开篇；`proposed/` 使用 `Proposal`/`Acceptance criteria`/`Risks`；`implemented/` 使用现在时的 `Decision`/`Consequences`，并禁止提案阶段标题；`rejected/` 冻结提案结构）、强制的 `Alternatives considered` 章节，以及规范章节词汇；定制技术章节可在这些规范章节之间保持自由形式。`pnpm run verify-agent-note-format`（[scripts/verify-agent-note-format.ts](../../../../scripts/verify-agent-note-format.ts)）作为 `doc-sync` 的一部分强制执行每项机械规则，因此跳过改写的生命周期迁移现在会使 CI 失败，而不再依赖评审者记忆。

定义该格式的同一变更规范化了整个语料库——遵循预发布立场：不设过渡期，不容忍双格式。唯一适用既有内容豁免的是内容，而非格式：替代方案只能记录、不能杜撰，因此若某份格式制定前的 Agent Note 无法从记录中还原替代方案，就会带有内容完全匹配 `agent-note-format: alternatives-not-recorded` 的注释；门禁只对日期早于本文的文件接受该注释。

## 曾考虑的替代方案

- **完整的刚性模板**（每个生命周期使用固定章节顺序，重构每份 Agent Note 以适配）：否决。大型设计 Agent Note 包含八到十五个定制技术章节（包拓扑、协议约定、schema），它们是承载设计的内容，而非漂移；刚性顺序会迫使我们现在进行破坏性改写，并永远与模板较劲。
- **仅规范化头部**（H1 和 Status，正文不动）：否决。债务标记指出的是*正文*的体裁分裂，让 `Context`/`Decision` 与 `Problem`/`Proposal` 无限期并存什么也解决不了。
- **不设 Status 行**（文件夹已经表示状态；格式制定前最新的三份 Agent Note 及其中一份的中文对应文件省略了该行）：否决，保留文件的自描述性。通过门禁校验该行与文件夹一致，消除了原本促使我们删除它的漂移风险。
- **带日期的 Status**（`Status: implemented (accepted YYYY-MM-DD)`）：否决。接受日期属于叙述性历史，写作规则将其排除在文档之外；文件名承载首次提出日期，git 承载其余信息；门禁能检查日期格式，但永远无法检查其真实性。
- **裸 `# <title>` H1**：否决。文件脱离目录树单独阅读时，`Agent Note: ` 前缀能自描述其体裁，而格式门禁可防止它漂移。
- **以 `## What we give up` 作为已实现记录的结尾**（README 对 Agent Note 所记录内容的原有表述）：否决。它只点出成本，而诚实的后果章节也会记录取舍换来了什么。
- **只有惯例没有门禁**（写下约定，靠评审强制执行）：否决。slop checklist 已经通过惯例禁止在 `implemented/` 中使用 spec 语气，而十九个文件展示了仅靠惯例在此处能达到什么效果。
- **独立的 `FORMAT.md` 约定文件**：否决。由一个入口同时承载布局、分类和格式，比维护两个约定文件更易发现和维护。

## 后果

现在每份 Agent Note 都需要稍多一些结构，而强制的 `Alternatives considered` 章节是有意设置的阻力：记录决策却不记录它胜过什么，会招致 Agent Note 本应防止的重新争论。无法还原替代方案的格式制定前 Agent Note 会永久保留既有内容豁免注释——这是记录中诚实的缺口，而不是杜撰的理由。`doc-sync` 增加一道门禁；在生命周期文件夹之间移动 Agent Note 时，现在必须当场完成真正的工作（迁移本就应包含的正文改写），而不是推迟为无人跟踪的清理任务。三十九个债务标记已经消失，由它们一直等待的模板解决。
