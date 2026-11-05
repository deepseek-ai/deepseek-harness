# Template: upgrade-guide

Use this kind for `docs/upgrade-guide/v<version>/<item>/guide.md` and its Chinese sibling `guide.zh.md`, whose sections are `## 变更` and `## 迁移`. The tree has no folder index. [dsh-create-upgrade-guide](../../dsh-create-upgrade-guide/SKILL.md) owns scope, placement, maintenance, and length rules; `pnpm run verify-upgrade-guides` enforces them.

## Frontmatter

```yaml
---
kind: upgrade-guide
description: "The externally perceptible surface that breaks and what replaces it."
---
```

## Skeleton

````markdown
# <Specific break, for example: `--profile` replaces `--preset`>

English | [中文](guide.zh.md)

## Change

State the old and new behavior of the surface and who observes it.

## Migration

1. Name the exact file, key, command, or symbol to change, with a before/after snippet when it is shorter than prose.
2. State how to confirm the migration worked.
````
