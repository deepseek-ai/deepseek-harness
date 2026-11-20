---
kind: upgrade-guide
description: "内置的 office-docx、office-pptx 和 office-xlsx 技能已移除；office 技能内联承载精简的 Word、PowerPoint 和 Excel 指导，tool-office 默认只在加载 office 时激活。"
---

# 单个内置 `office` 技能取代各 Office 格式技能

[English](guide.md) | 中文

## 变更

[`@deepseek-ai/dsh-skill-office`](../../../../packages/skill/skill-office/README.zh.md) 原先注册四个技能：`office`、`office-docx`、`office-pptx` 和 `office-xlsx`，现在只注册 `office`。Word、PowerPoint 和 Excel 的易错点与工具激活精简指导直接内联在 `office/SKILL.md` 中，不再拆分为单独的格式文件。Python 环境说明追加在 `office` 末尾。

受影响的对象：

- 输入过 `/office-docx`、`/office-pptx` 或 `/office-xlsx` 的用户：这些命令已不存在；
- 定义了名为 `office-docx`、`office-pptx` 或 `office-xlsx` 的技能（例如位于 `~/.dsh/skills/` 下）以覆盖内置指导的用户：内置 `office` 技能不再加载这些名字，因此这类定义成为普通的独立技能，不再替换任何内置内容；
- 自定义的 `assetRoot` 目录：现在只需包含 `office/SKILL.md`；
- 依赖 [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.zh.md) 默认 `activationSkills` 的组合：默认值由 `[office, office-docx, office-xlsx, office-pptx]` 改为 `[office]`，因此加载名为 `office-docx` 的技能不再激活 `office_render`、`office_convert` 和 `office_recalculate`。

## 迁移

1. 把 `/office-docx`、`/office-pptx` 和 `/office-xlsx` 改为 `/office`。
2. 如需覆盖内置 Office 指导，改为定义名为 `office` 的技能，例如 `~/.dsh/skills/office/SKILL.md`。删除或重命名旧的 `office-docx`、`office-pptx` 和 `office-xlsx` 定义。
3. 如果配置了 `assetRoot`，在 `<assetRoot>` 下提供 `office/SKILL.md`，并删除 `office-docx`、`office-pptx` 和 `office-xlsx` 目录。
4. 如果 `office` 以外的自定义技能需要激活 Office 工具，把它写入 `cordis.yml` 中 `tool-office` 行的 `activationSkills`。
5. 启动一个 Session 确认：技能目录列出 `office`，不再出现已移除的名字；输入 `/office` 后，下一步声明 `office_render`、`office_convert` 和 `office_recalculate`。
