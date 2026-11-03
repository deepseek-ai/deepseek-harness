---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-office-kit` replaces `@deepseek-ai/dsh-office-to-pdf`, renaming its service, Remote methods, exported types, and configuration row."
---

# `@deepseek-ai/dsh-office-kit` replaces `@deepseek-ai/dsh-office-to-pdf`

English | [中文](guide.zh.md)

## Change

The Office conversion provider moved from `@deepseek-ai/dsh-office-to-pdf` to `@deepseek-ai/dsh-office-kit`. Compositions, plugins, and Clients that name the old package, service, Remote methods, or exported symbols are affected:

| Old | New |
|---|---|
| `cordis.yml` row `id: office-to-pdf`, `name: '@deepseek-ai/dsh-office-to-pdf'` | `id: office-kit`, `name: '@deepseek-ai/dsh-office-kit'`; configuration keys are unchanged |
| `ctx.officeToPdf` | `ctx.officeKit` |
| Remote `officeToPdf/render`, `officeToPdf/generation` | `officeKit/render`, `officeKit/generation` |
| `OfficeToPdf` | `OfficeKit` |
| `OfficeToPdfError`, `OfficeToPdfErrorCode` | `OfficeKitError`, `OfficeKitErrorCode` |
| `OfficeToPdfGeneration` | `OfficeKitGeneration` |
| `OfficeToPdfRequest`, `OfficeToPdfResult`, `OfficeToPdfPriority`, `OfficeToPdfKey` | `OfficeKitRequest`, `OfficeKitResult`, `OfficeKitPriority`, `OfficeKitKey` |

The `document-render/failed` Remote error, `RenderedDocumentBytes`, `OfficeSourceKey`, and `OfficeExtension` keep their names. The `/types` and `/remote` entries remain.

The provider previously failed to load when LibreOffice Kit was absent. It now registers without Kit; each conversion that needs a converter rejects with `OfficeKitError` code `unavailable` and locates Kit again, so installing Kit later takes effect without reloading the provider.

## Migration

1. In `cordis.yml`, patches, and overlays, change the row `id: office-to-pdf` to `id: office-kit` and its `name` to `'@deepseek-ai/dsh-office-kit'`. Keep its `config` block unchanged.
2. Replace the dependency `@deepseek-ai/dsh-office-to-pdf` with `@deepseek-ai/dsh-office-kit` in `package.json`, and update import specifiers, including `/types` and `/remote`.
3. Rename `ctx.officeToPdf`, Remote method names, and the exported symbols listed above.
4. Code that treated a load failure of the conversion row as "Kit absent" now checks for `OfficeKitError` with code `unavailable` from conversion instead.
5. Confirm the migration by searching the project for `office-to-pdf`, `officeToPdf`, and `OfficeToPdf`, then opening a DOCX file in the Web document preview.
