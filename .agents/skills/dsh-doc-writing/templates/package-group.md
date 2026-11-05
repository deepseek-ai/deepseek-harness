# Template: package-group

Use this template for `packages/README.md` and every `packages/<group>/README.md`. The page is a map: it orients the capability family, lists its direct packages with one-line roles, and links package-owned details. It never restates a package's contract.

## Frontmatter

```yaml
---
description: "The <group> package group: what the packages under packages/<group>/ own, for readers choosing or navigating the family."
kind: "package-group"
---
```

## Skeleton

```markdown
# <group>/ — <one-line subject>

English | [中文](README.zh.md)

## Summary

Three to five sentences and at most 100 `wc -w`-style words: what the family provides, what a reader can DO with it, which package owns which half, and the main boundary. Apply the [Summary voice rules](../SKILL.md#voice-rules).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One short orienting sentence, then the package map:

| Package | Role |
|---|---|
| [`<pkg>`](<pkg>/README.md) | One-line role: what it contributes |

<a id="related-documentation"></a>
## Related documentation

- [Adjacent owner](../../<path>.md) — what it adds to this family.

<a id="dev-note"></a>
## Dev Note

None.
```

## Rules

- One row per direct package; role text states the package's contribution, never its internals.
- Add a `ctx key`, package shape, or npm-name column only when that distinction helps readers choose among the direct packages.
- Related documentation links adjacent owners (group maps, subsystem pages, Agent Notes) with a short phrase per link.
- Do not add a Model Experience or Known Limitations section; the group map owns no runtime behavior.
- Re-run `pnpm run verify-translation-pairing --write packages/<group>/README.md` after editing the pair.
