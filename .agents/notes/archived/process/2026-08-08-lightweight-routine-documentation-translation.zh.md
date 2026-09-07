# Agent Note: 轻量化日常文档翻译

Status: implemented
Archived: 2026-09-04

[English](2026-08-08-lightweight-routine-documentation-translation.md) | 中文

## 问题

日常双语编辑会自动选用完整的[翻译 skill（技能）](../../../skills/dsh-translate-docs/SKILL.md)。即使经过[基于简报的更新优化](2026-07-26-briefed-minimal-translation-updates.zh.md)，一次小的文档改动仍可能加载专用工作流、生成简报、把行文翻译委派给 subagent，并另行执行一轮核验。这种编排耗费的时间、上下文和模型 token 比直接翻译改动文本本身还多，而且 skill 的自动发现机制还会在普通文档处理轮次中暴露该工作流。

## 决策

- **日常翻译一次完成，只处理一遍。** 当前 agent（智能体）加载 [terminology.md](../../../../docs/i18n/terminology.md)，直接翻译发生改动的内容；如果术语的实际首现位置跨过了编辑边界，则移动相应括注，否则保留改动之外已经评审的对侧文件行文；最后重新记录配对。它不会调用翻译 skill、生成简报、启动单独的翻译评审轮次，也不会把翻译委派给 subagent。
- **扩展工作流仅限手动调用。** [dsh-translate-docs](../../../skills/dsh-translate-docs/SKILL.md) 保留简报、行文翻译委派、整篇文档和按范围核验路径。[Claude Code skill 契约](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill)读取 `SKILL.md` 中的 `disable-model-invocation: true` 和 `user-invocable: true`；Codex 读取 `agents/openai.yaml` 中的 `policy.allow_implicit_invocation: false`。仓库的 `.claude/skills` 符号链接把同一个 skill 目录映射给 Claude Code，因此两个产品共享同一份提交到仓库的工作流，同时分别执行各自的调用元数据契约。`doc-sync` 中的 skill 调用元数据门禁会让这两份独立策略保持一致。
- **自动工作流不会串联调用这项仅限手动调用的 skill。** 轻量默认行为由根级指令和文档指令定义。文档、网站同步、行文和代码评审 skill 会链接这些指令或 i18n 契约，而不会因为推断到双语改动就加载 `dsh-translate-docs`。
- **配对契约与评审契约保持不变。** 两种语言文件仍会一并更新；未触及的对侧文件措辞保持稳定；术语约束仍然有效；只有当前 agent 确认配对后，才会重写一致性记录；`doc-sync`（文档同步门禁）继续执行全语料机械检查。语义层面的翻译质量仍由人工评审负责。

## 曾考虑的替代方案

- **删除扩展 skill 和简报工具**：不予采纳。在整篇文档翻译或棘手的两侧内容协调中，以及对有意选择受控工作流的调用方而言，显式手动调用仍有价值。
- **用自动调用的轻量 skill 取代扩展 skill**：不予采纳。另一项自动 skill 仍会给这项任务增加发现上下文和调用边界，而当前 agent 仅依据术语表与常驻指令即可直接完成该任务。
- **仅对新配对或大规模改动保留自动调用**：不予采纳。基于规模的推断同样是一项隐藏政策，可能出乎意料地启用高开销工作流。何时值得为扩展路径付出成本，应由用户而非 agent 决定。
- **同时取消加载术语表**：不予采纳。术语表是体量小但有约束力的输入，可以防止整个仓库发生术语漂移；移除它等于用产品语言不一致换取 token 节省。

## 后果

- 普通开发的成本来自发生改动的源文本、其局部对侧文件上下文和术语表，不再来自扩展工作流的简报与 subagent 上下文。
- 当前 agent 在同一轮次内对日常翻译的最终结果负责。轻量路径有意放弃扩展工作流提供的自动生成对齐信息、委派所提供的隔离，以及单独的行文核验轮次。
- 用户仍可在 Claude Code 中通过 `/dsh-translate-docs`，或在 Codex 中通过 `$dsh-translate-docs` 显式调用完整工作流。
- Claude Code frontmatter 与 Codex 策略文件是彼此独立的产品契约；如果某项 skill 仅在一个产品中变为手动调用，或者在 Claude Code 中对模型和用户都不可用，`doc-sync` 会拒绝该状态。
