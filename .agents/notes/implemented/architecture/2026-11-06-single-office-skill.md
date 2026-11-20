# Agent Note: One Office skill with concise inline guidance

Status: implemented

English | [中文](2026-11-06-single-office-skill.zh.md)

## Problem

The [Office provider](../../../../packages/skill/skill-office/README.md) listed four skills: the `office` router and the `office-docx`, `office-pptx`, and `office-xlsx` authoring skills. Every request carried four catalog summaries, although a format skill is useful only after the router has chosen it. Each format skill repeated the instruction to load `office` for the Office tools, the provider appended the same Python environment section to three bodies, and the format bodies mostly carried step-by-step workflow instructions and examples that constrained the model's approach instead of stating non-obvious harness facts. Moving those format bodies into separate files read on demand would still cost an extra `read` step and depend on Host filesystem access. The catalog should identify the Office capability once and load only DSH-specific facts and silent data-loss pitfalls in one step.

## Decision

`@deepseek-ai/dsh-skill-office` registers only `office`. The `office` body states that `office_render`, `office_convert`, and `office_recalculate` become available on the next step, notes bundled `pypdf` for existing PDFs and `office_convert` for legacy `.doc`, `.ppt`, and `.xls` files, records concise Word, PowerPoint, and Excel pitfalls that can silently drop formatting, East Asian fonts, layout fit, formula results, or sheets, and appends the configured Python environment section once. No separate format files are bundled or read. This supersedes the catalog and authoring bodies of [progressive Office skills](2026-09-27-progressive-office-skills.md) while keeping the activation design of the [on-demand Office tools](2026-10-31-native-office-tool.md) with `['office']` as the default `activationSkills`.

The [Office tools](../../../../packages/document/tool-office/README.md) default `activationSkills` to `['office']`. During catalog discovery and loading, the provider reads `office/SKILL.md`; a missing file or invalid metadata omits `office` from the catalog with a warning, and other read errors leave discovery incomplete so that the registry retries it.

Because the entire guidance travels in the `skill` tool result, no second `read` call is needed and the guidance is identical in local, Desktop (`app.asar`), and remote or SSH workspaces.

## Alternatives considered

**Keep the four catalog skills.** Separate skills keep the `/office-docx`, `/office-pptx`, and `/office-xlsx` commands and let a user replace one format by defining a skill with that name. They cost three catalog lines in every request, repeat the routing obligations, and append the Python section three times.

**Put per-format guidance in `docx.md`, `pptx.md`, and `xlsx.md` read on demand.** Resource files keep format detail out of standalone render or conversion turns, but require an extra `read` tool call for authoring, depend on the Session's `read` tool reaching Host files (failing in SSH or remote filesystems), and preserve lengthy workflow prescriptions that the model does not need when only non-obvious pitfalls are kept.

**Hide the format skills from the catalog but keep them loadable.** This needs a generic catalog visibility policy in the skill registry, independent of invocation permission, for one provider's benefit.

## Consequences

The catalog carries one Office summary (≤ 50 estimated tokens), and loading `office` adds one compact body (≤ 350 estimated tokens including the Python environment section) while activating the Office tools for the next step. Every Office task loads the same concise body, with no follow-up file read and no Host-filesystem dependency for skill guidance.

Users lose the direct format commands and per-format overrides: `/office` is the only command, and a user-defined `office` skill replaces the bundled body. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.5/office-single-skill/guide.md) owns the migration.

## Testing

`skill-office.spec.ts` covers the single catalog entry, the description and body token budgets, the inline pitfall and Python environment content, omission with a warning when `office/SKILL.md` is missing, has invalid metadata, or disappears after discovery, and retries after other read errors. `progressive-loading.spec.ts` covers `skill(office)` in native and PTC mode, through resume and fork. `activation.spec.ts` covers the `['office']` default. The recorded headless scenarios `office-progressive-native`, `office-progressive-ptc`, `office-skills`, `office-authoring-checker`, and `office-skills-no-renderer` replay the single-skill flow.
