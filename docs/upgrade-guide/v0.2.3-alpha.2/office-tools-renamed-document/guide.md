---
kind: upgrade-guide
description: "The dsh-tool-office package and its office_render, office_convert, and office_recalculate tools are renamed to dsh-tool-document and document_render, document_convert, and document_recalculate."
---

# `dsh-tool-office` becomes `dsh-tool-document` with `document_*` tools

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the Office tools came from `@deepseek-ai/dsh-tool-office`, mounted as row `tool-office`, and the model called `office_render`, `office_convert`, and `office_recalculate`. The package is now [`@deepseek-ai/dsh-tool-document`](../../../../packages/document/tool-document/README.md), the shipped rows use the id `tool-document`, and the tools are `document_render`, `document_convert`, and `document_recalculate`. Parameters, results, error codes, and the `office` activation skill are unchanged.

Affected: `cordis.yml`, profile patches, overlays, and saved or custom agent presets that name `@deepseek-ai/dsh-tool-office` or patch the row `tool-office`, which no longer resolve; and tool allowlists, guard or approval rules, hooks, and scripts that match the `office_*` tool names, which no longer match. Sessions recorded before the upgrade still resume: a request header that declares an `office_*` tool keeps the renamed tools active, and the Web transcript shows earlier `office_*` calls as Office rows.

## Migration

1. Replace `@deepseek-ai/dsh-tool-office` with `@deepseek-ai/dsh-tool-document` in every `cordis.yml`, `cordis.patch.yml`, overlay, `package.json`, and import, including `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
2. Change patch rows that target `id: tool-office`, such as `- {id: tool-office, config: {activationSkills: [office]}}`, to `id: tool-document`. For a Web or Desktop preset edited in the Agent presets settings page, open the preset and confirm that its Office tools row names `@deepseek-ai/dsh-tool-document`.
3. Rename `office_render`, `office_convert`, and `office_recalculate` to `document_render`, `document_convert`, and `document_recalculate` in tool allowlists, preset tool lists, guard and approval rules, hooks, and scripts that inspect tool calls.
4. Confirm with `dsh --profile <profile> --dump-config` that a `tool-document` row appears and no row names `@deepseek-ai/dsh-tool-office`, then load the `office` skill in a new Session and check that the next request declares the three `document_*` tools.
