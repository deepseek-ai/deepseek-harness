---
kind: upgrade-guide
description: "The base profile bundle gains the `upstream-skills` row, which stays pending and adds a boot warning in a composition that disables the `skill` row."
---

# Upstream skills base row

English | [中文](guide.zh.md)

## Change

The base profile bundle gains the row `upstream-skills` (`@deepseek-ai/dsh-upstream-skills`), a Host Service that injects `skills`. A composition that keeps the `skill` row is not affected. A `cordis.yml`, patch, or overlay that disables the `skill` row and leaves `upstream-skills` enabled keeps the new row pending, and every boot prints two more lines on stderr:

```text
dsh: warning: 1 entry did not activate
upstream-skills (@deepseek-ai/dsh-upstream-skills): pending (waiting for service: skills)
```

A composition that already reports entries that did not activate counts one more and lists this row with them.

## Migration

1. In each `cordis.yml`, patch, or overlay that disables the `skill` row, disable the new row next to it:

   ```yaml
   - id: upstream-skills
     name: '@deepseek-ai/dsh-upstream-skills'
     disabled: true
   ```

2. Boot the profile and confirm that stderr no longer names `upstream-skills`.
