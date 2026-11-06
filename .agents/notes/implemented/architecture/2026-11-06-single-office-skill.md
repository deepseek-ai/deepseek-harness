# Agent Note: One Office skill with format files read on demand

Status: implemented

English | [中文](2026-11-06-single-office-skill.zh.md)

## Problem

The [Office provider](../../../../packages/skill/skill-office/README.md) listed four skills: the `office` router and the `office-docx`, `office-pptx`, and `office-xlsx` authoring skills. Every request carried four catalog summaries, although a format skill is useful only after the router has chosen it. Each format skill repeated the instruction to load `office` for the Office tools, and the provider appended the same Python environment section to three bodies. The catalog should identify the Office capability once and leave format detail to the task that needs it.

## Decision

`@deepseek-ai/dsh-skill-office` registers only `office`. The Word, PowerPoint, and Excel guidance lives in `docx.md`, `pptx.md`, and `xlsx.md` in the `office` skill directory. The `office` body names these files one level deep, and the model reads only the formats the task involves with `read`, resolving the relative path against the base directory that the skill result reports. Rendering, conversion, or recalculation alone reads no format file. The provider appends the configured Python environment section once, to the `office` body, and the format files refer to it. This partially supersedes [progressive Office skills](2026-09-27-progressive-office-skills.md): its compact router remains as `office`, and the format files replace its three format-specific skills; the [on-demand Office tools](2026-10-31-native-office-tool.md) keep their activation design with the new default.

This follows the three levels of progressive disclosure that Anthropic describes for Agent Skills: catalog metadata in every request, the skill body when the task matches, and referenced files when a step needs them.

The [Office tools](../../../../packages/document/tool-office/README.md) default `activationSkills` to `['office']`. Reading a format file activates nothing; because the model reaches a format file only through the `office` body, the tools are already active when format guidance applies. During catalog discovery and loading, the provider requires the three format files to be regular files; a missing file or one that is not a regular file omits `office` from the catalog with a warning naming the path.

The format files are Host files. On Desktop they lie inside `resources/app.asar`, which the `read` tool reads through Electron's archive support. With SSH or another filesystem backend that cannot reach Host files, `read` cannot open them, so only the `office` body's guidance reaches the model.

## Alternatives considered

**Keep the four catalog skills.** Separate skills keep the `/office-docx`, `/office-pptx`, and `/office-xlsx` commands and let a user replace one format by defining a skill with that name. They cost three catalog lines in every request, repeat the routing obligations, and append the Python section three times.

**Hide the format skills from the catalog but keep them loadable.** This needs a generic catalog visibility policy in the skill registry, independent of invocation permission, for one provider's benefit. Resource files use the existing skill result base directory and `read` without changing the registry or the `skill` tool.

**Inline all formats into the `office` body.** One body avoids the extra read, but every Office task, including a standalone render, would load guidance for all three formats.

## Consequences

The catalog carries one Office summary. Authoring takes one more model step to read the format file, and that `read` result stays in history like a skill result. The budget for the `office` body plus one format file stays within the earlier router-plus-format-skill budget; `read` line-number prefixes are an additional cost.

Users lose the direct format commands and per-format overrides: `/office` is the only command, and a user-defined `office` skill replaces the bundled body together with its format-file routing. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.4/office-single-skill/guide.md) owns the migration. Compositions must provide a file `read` tool, and Office authoring in SSH workspaces gets no format guidance until the format files are reachable through the Session's filesystem.

## Testing

`skill-office.spec.ts` covers the single catalog entry, the description and body budgets, the one-level links from `SKILL.md`, line and byte limits of each format file against the `read` tool defaults, and omission with a warning when a format file is missing, is a directory, or disappears after discovery. `progressive-loading.spec.ts` covers `skill(office)` followed by `read` of a format file in native and PTC mode, through resume and fork. `activation.spec.ts` covers the `['office']` default. The recorded headless scenarios `office-progressive-native`, `office-progressive-ptc`, `office-skills`, `office-authoring-checker`, and `office-skills-no-renderer` replay the read path, and the built Desktop Host resource test reads `docx.md` from the advertised resource directory.
