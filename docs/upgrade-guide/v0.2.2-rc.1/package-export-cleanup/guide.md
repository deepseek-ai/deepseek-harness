---
kind: upgrade-guide
description: Internal helper values are removed from three published plugin-root entries.
---

# Replace internal plugin-root imports

English | [中文](guide.zh.md)

## Change

After upgrading from v0.2.2-rc.1, the following plugin-root values are no longer exported. Their implementations remain inside the packages. Consumers importing these values from a package root must change their imports or use the owning service.

| Package suffix (`@deepseek-ai/dsh-`) | Removed root helpers |
|---|---|
| `file-reference-local` | `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES`, `DEFAULT_FILE_SEARCH_MAX_ENTRIES`, `DEFAULT_FILE_SEARCH_MAX_RESULTS`, `WorkspaceFileSearch`, `FILE_REFERENCE_PROMPT`, `activeAtToken`, `formatFileMention` |
| `llm-pi-ai` | `recordKeyFor` |
| `lsp-stdio` | `LspConnection`, `LspInstance`, `MessageDecoder`, `canonicalizeWorkspace`, `encodeMessage`, `negotiatePositionEncoding`, `normalizeHover`, `normalizeLocations`, `readHostSource`, `requestMethod`, `supportsOperation`, `supportsTransientOpen` |

Brand constructors, package subpaths, persisted values and Session formats are unchanged.

## Migration

1. Stop importing the listed helper values from plugin roots. Package-owned tests can use relative imports from the corresponding internal modules.
2. Application code should use the injected `fileReferences` or `lsp` service instead of provider implementation classes or protocol helpers. File-reference grammar remains at `@deepseek-ai/dsh-file-reference/grammar`; `FILE_REFERENCE_PROMPT` remains at `@deepseek-ai/dsh-file-reference`. `recordKeyFor` has no replacement public entry.
3. Compile the application and run its tests. Load any plain-JavaScript consumers under Node as well: TypeScript checking alone does not cover missing ESM named exports in `.mjs` files.
