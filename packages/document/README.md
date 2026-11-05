---
description: "Package map for Host Office rendering, conversion, and the model-facing Office tools."
kind: "package-group"
---

# document/ — Office documents

English | [中文](README.zh.md)

## Summary

Render, convert, and recalculate authorized Office files on the Host, for previews and for the model's Office tools. The shared service runs LibreOffice kit. Targets with a declared native engine use it; other targets use Node WASM.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns its configuration and lifetime rules; the subsystem reference describes their shared conversion operation.

| Package | Role | ctx key |
|---|---|---|
| [office-kit](office-kit/README.md) | Authorized Office bytes to complete PDFs, PNG images, converted files, and recalculated workbooks with bounded queues and caching; the provider resolves its own Kit entry, engine manifests, and ASAR-unpacked engine paths | `ctx.officeKit` |
| [tool-office](tool-office/README.md) | `office_render`, `office_convert`, and `office_recalculate`, declared after an Office skill loads: render pages as images in the tool result, convert documents, and recalculate workbooks | — |

-----

<a id="related-documentation"></a>
## Related documentation

Consumers own source authorization and presentation.

- [Document conversion](../../docs/subsystems/office-kit.md) — shared operation and generated service reference.
- [Independent kit ownership](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) — engine distribution and application integration.
- [Workspace Files](../api/workspace-files/README.md) — authorized bounded source reads.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
