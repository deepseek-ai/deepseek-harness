---
kind: upgrade-guide
description: "PTC Script import handlers now receive imports from explicitly declared ESM dependencies."
---

# PTC Script handlers receive ESM dependency imports

English | [中文](guide.zh.md)

## Change

Custom runners passing a `ProgramImportHandler` to `runNodeMain()` or `runPersistentMain()` now receive static and dynamic imports from `.mjs` files and `.js` files in `type: module` packages. Previously, default and redirected imports delegated their entire dependency graph to Node. These ESM modules now execute in the Script context and use an evaluator-owned cache. Their requests identify the importing module's filename. Other formats retain native loading; omitting the handler retains native loading for all imports.

## Migration

1. Update custom runner handlers to accept dependency filenames as `request.referrer`, and return `{ type: 'default' }` for imports that need ordinary resolution. Static imports bind once; changing a handler result does not replace an existing binding.
2. Check ESM dependencies that rely on native module singletons or the runner's global object. They now share the Script globals and remain separate from the runner's native ESM instances.
3. Run a Script that imports the affected package and invokes an exported function containing `import()`. Confirm both its static dependencies and later dynamic imports receive the intended handler decisions. See the [runtime's import handling](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#runner-import-handling) for supported formats.
