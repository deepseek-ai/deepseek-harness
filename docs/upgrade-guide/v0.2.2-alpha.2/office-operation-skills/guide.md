---
kind: upgrade-guide
description: "The bundled `office-render`, `office-recalculate`, and `office-export-pdf` skills are removed; Office operations call the `office` tool directly."
---

# Office operation skills are removed

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-skill-office` registered seven skills: the `office` router, the `office-docx`, `office-pptx`, and `office-xlsx` authoring skills, and the `office-render`, `office-recalculate`, and `office-export-pdf` operation skills. It now registers only the router and the three authoring skills. The router and the authoring skills direct rendering, recalculation, and PDF export to the [`office` tool](../../../../packages/document/tool-office/README.md) without a separate skill load.

The skill catalog and the `/` menu no longer list the three operation skills, and `skill` calls or `/office-render`, `/office-recalculate`, and `/office-export-pdf` invocations that name them find no skill. Recorded Sessions keep their earlier skill calls and results.

This affects:

- users who invoke the three skills from the `/` menu;
- prompts, skills, and scripts that tell a model to load them;
- tests and tools that expect the seven-skill catalog;
- deployments that set `assetRoot` of the `skill-office` row to their own copy of the skill folders.

## Migration

1. Replace each invocation or load of a removed skill with a request that calls the `office` tool with the matching operation:
   - `office-render`: `operation: "render"`;
   - `office-recalculate`: `operation: "recalculate"` with `format: "xlsx"` or `"ods"`;
   - `office-export-pdf`: `operation: "convert"` with `format: "pdf"`.
2. Update expected skill lists to `office`, `office-docx`, `office-pptx`, and `office-xlsx`.
3. In a copy referenced by `assetRoot`, replace the four remaining folders with those from the installed package's `assets/` and delete `office-render/`, `office-recalculate/`, and `office-export-pdf/`; the provider no longer reads them.
4. Open a new Session and confirm that the `/` menu lists the four Office skills, and that a request to render a document produces an `office` tool call without a skill load other than `office` or an authoring skill.
