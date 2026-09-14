---
description: "The lsp group map: language-server code navigation through the LSP seam, its stdio provider, and the model-facing lsp tool, for users and maintainers navigating the group."
kind: "package-group"
---

# lsp/ — Language-server code navigation

English | [中文](README.zh.md)

## Summary

The lsp group lets agents navigate code through configured language servers: go to definitions, find references and implementations, and read hover documentation. Use `lsp-stdio` to connect local stdio language-server commands and extension mappings, and `tool-lsp` to make those operations available to the model. The shared `lsp` package keeps provider choice and normalized results consistent, so changing servers does not change model requests. Deployments must supply and configure their language servers; this group ships none.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`lsp/`](lsp/README.md) | Defines the code-navigation service: provider selection by file extension, four normalized read-only operations, and structured errors | `ctx.lsp` |
| [`lsp-stdio/`](lsp-stdio/README.md) | Drives configured stdio language-server commands as providers over `ctx.fs` and `ctx.subprocess` | registers on `ctx.lsp` |
| [`tool-lsp/`](tool-lsp/README.md) | Exposes precise code navigation to the model through the `lsp` tool | registers on `ctx.tools` |

Providers register capabilities, not tools: `tool-lsp` is the only owner of the model-facing name, schema, prompt guidance, and presentation, so swapping a provider never changes how the model asks for navigation.

-----

<a id="related-documentation"></a>
## Related documentation

- [LSP navigation subsystem](../../docs/subsystems/lsp.md) — operations, coordinates, requests and results, and `LspError` codes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp) — the `lsp` schema the model receives.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
