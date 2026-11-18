---
kind: upgrade-guide
description: Reopen saved plan previews and migrate custom document bodies to shared content rendering.
---

# Shared sidebar content previews

English | [中文](guide.zh.md)

## Change

Plans and pending reviews now use the shared `content` tab instead of standalone `plan` or `plan-review` tab types. Previously saved tabs of those types show an unavailable message after upgrading. Content supplied to the new tab is transient and expires on browser reload.

Custom document bodies use the `sidebar.right.document.body` Factory. Its input separates `resourceAddress` from optional `baseAddress`, which controls relative file resolution. Compaction markers no longer carry `summary` or `summaryEventSeq`; the preview reads the replacement checkpoint message on demand.

## Migration

1. Close unavailable saved plan tabs and reopen their plan or review cards. Include `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` in compositions that need previews; without its optional service, plan openers are disabled.
2. Open text with `ctx.contentPreviews.open({ mediaType: 'text/markdown', text }, { title, key })`. The method opens the sidebar directly; use `destination: 'float'` for a floating panel. Reopen previews after a browser reload.
3. Mount custom document renderers through `sidebar.right.document.body`, supplying `rendererId` and `useTabInfo`. Pass `baseAddress: resourceAddress` for workspace files and omit it for content without a file base.
4. Use the compaction preview service instead of reading removed summary fields. Verify that opening a compact row shows the checkpoint replacement text.
