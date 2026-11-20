---
kind: upgrade-guide
description: "The bundled office-docx, office-pptx, and office-xlsx skills are removed; the office skill now carries concise inline Word, PowerPoint, and Excel guidance, and tool-office activates only on office by default."
---

# One bundled `office` skill replaces the Office format skills

English | [中文](guide.zh.md)

## Change

[`@deepseek-ai/dsh-skill-office`](../../../../packages/skill/skill-office/README.md) registered four skills: `office`, `office-docx`, `office-pptx`, and `office-xlsx`. It now registers only `office`. Concise Word, PowerPoint, and Excel pitfall and tool-activation guidance lives inline in `office/SKILL.md`, with no separate format files. The Python environment section is appended to `office`.

This affects:

- users who typed `/office-docx`, `/office-pptx`, or `/office-xlsx`: those commands no longer exist;
- users who defined a skill named `office-docx`, `office-pptx`, or `office-xlsx`, for example under `~/.dsh/skills/`, to override the bundled guidance: the bundled `office` skill no longer loads those names, so the definition becomes an ordinary separate skill and no longer replaces any bundled content;
- custom `assetRoot` directories, which now need only `office/SKILL.md`;
- compositions that rely on the default `activationSkills` of [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.md): the default changed from `[office, office-docx, office-xlsx, office-pptx]` to `[office]`, so loading a skill named `office-docx` no longer activates `office_render`, `office_convert`, and `office_recalculate`.

## Migration

1. Replace `/office-docx`, `/office-pptx`, and `/office-xlsx` with `/office`.
2. To override bundled Office guidance, define a skill named `office` instead, for example `~/.dsh/skills/office/SKILL.md`. Delete or rename the old `office-docx`, `office-pptx`, and `office-xlsx` definitions.
3. If you configure `assetRoot`, provide `office/SKILL.md` under `<assetRoot>` and remove the `office-docx`, `office-pptx`, and `office-xlsx` folders.
4. If a custom skill other than `office` must activate the Office tools, list it in the `tool-office` row's `activationSkills` in `cordis.yml`.
5. Confirm by starting a Session: the skill catalog lists `office` and none of the removed names, and after `/office` the next step declares `office_render`, `office_convert`, and `office_recalculate`.
