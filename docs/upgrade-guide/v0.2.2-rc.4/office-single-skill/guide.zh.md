---
kind: upgrade-guide
description: "内置的 office-docx、office-pptx 和 office-xlsx 技能已移除；office 技能承载 Word、PowerPoint 和 Excel 指导，tool-office 默认只在加载 office 时激活。"
---

# 单个内置 `office` 技能取代各 Office 格式技能

[English](guide.md) | 中文

## 变更

[`@deepseek-ai/dsh-skill-office`](../../../../packages/skill/skill-office/README.zh.md) 原先注册四个技能：`office`、`office-docx`、`office-pptx` 和 `office-xlsx`，现在只注册 `office`。Word、PowerPoint 和 Excel 指导移入 `office` 技能目录下的 `docx.md`、`pptx.md` 和 `xlsx.md` 文件，模型加载 `office` 后用 `read` 读取。Python 环境说明追加在 `office` 末尾。

受影响的对象：

- 输入过 `/office-docx`、`/office-pptx` 或 `/office-xlsx` 的用户：这些命令已不存在；
- 定义了名为 `office-docx`、`office-pptx` 或 `office-xlsx` 的技能（例如位于 `~/.dsh/skills/` 下）以覆盖内置指导的用户：内置 `office` 技能不再加载这些名字，因此这类定义成为普通的独立技能，不再替换任何内置内容；
- 自定义的 `assetRoot` 目录：现在必须包含 `office/SKILL.md`、`office/docx.md`、`office/pptx.md` 和 `office/xlsx.md`；
- 依赖 [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.zh.md) 默认 `activationSkills` 的组合：默认值由 `[office, office-docx, office-xlsx, office-pptx]` 改为 `[office]`，因此加载名为 `office-docx` 的技能不再激活 `office_render`、`office_convert` 和 `office_recalculate`。

## 迁移

1. 把 `/office-docx`、`/office-pptx` 和 `/office-xlsx` 改为 `/office`。
2. 如需覆盖内置 Office 指导，改为定义名为 `office` 的技能，例如 `~/.dsh/skills/office/SKILL.md`；按格式划分的指导放在它旁边的文件中，并用相对路径引用。删除或重命名旧的 `office-docx`、`office-pptx` 和 `office-xlsx` 定义。
3. 如果配置了 `assetRoot`，按包内 `assets/office/` 的目录结构复制（包括三个格式文件），并删除 `office-docx`、`office-pptx` 和 `office-xlsx` 目录。
4. 如果 `office` 以外的自定义技能需要激活 Office 工具，把它写入 `cordis.yml` 中 `tool-office` 行的 `activationSkills`。
5. 启动一个 Session 确认：技能目录列出 `office`，不再出现已移除的名字；输入 `/office` 后，下一步声明 `office_render`、`office_convert` 和 `office_recalculate`。
