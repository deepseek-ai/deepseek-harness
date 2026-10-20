---
kind: upgrade-guide
description: "viewProfilePackage from @deepseek-ai/dsh-plugin-manager/operations requires the manifest fields it prints."
---

# `viewProfilePackage` takes the fields it prints

English | [中文](guide.zh.md)

## Change

`viewProfilePackage(dir, spec, options)` from `@deepseek-ai/dsh-plugin-manager/operations` used to print a fixed field list: `name`, `version`, `description`, and `dsh`. `PackageViewOptions` now requires `fields`, the manifest or registry fields `pnpm view` prints, so the same lookup reads version lists and per-version peers. Code that calls `viewProfilePackage` directly no longer type-checks without `fields`, and a JavaScript caller that omits it runs `pnpm view` with no fields.

## Migration

1. Pass the fields the call used to print:

   ```ts
   import { viewProfilePackage } from '@deepseek-ai/dsh-plugin-manager/operations'

   declare const dir: string, spec: string, timeoutMs: number
   await viewProfilePackage(dir, spec, { fields: ['name', 'version', 'description', 'dsh'], timeoutMs })
   ```

2. Run your type checker; a missing `fields` property is reported at each call.
