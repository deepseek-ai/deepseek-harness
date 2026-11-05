# Template: package-reference

Use this template for a package whose entry is a Cordis plugin — a service default export or an `apply` function — mounted in a composition. This is the default for `packages/<group>/<pkg>/README.md`. The `session-persistence-jsonl` README pair is the worked example of this template.

## Frontmatter

```yaml
---
description: "What the package lets a reader choose, configure, or debug, in one or two concrete sentences with searchable domain terms."
kind: "package-reference"
---
```

## Skeleton

```markdown
# @deepseek-ai/dsh-<name>

English | [中文](README.zh.md)

## Summary

Three to five sentences and at most 100 `wc -w`-style words on what a user or agent can DO with the package: outcomes, when to choose it, main cost, most important boundary. Apply the [Summary voice rules](../SKILL.md#voice-rules); never describe its role, type, or internal identity.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

One orienting sentence: the common path.

### When to choose it

Choose or avoid the package: one paragraph naming the deciding conditions and the fallback package.

### Minimal configuration

The smallest mount that works, as a `cordis.yml` snippet, plus the config table:

| Field | Default | Meaning |
|---|---|---|
| `<field>` | `<default>` or `required` | One-line meaning |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-<name>) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Design concept, component architecture, and hand-waving dataflow — enough to understand the package. A source-map table links files for exact detail. No API catalogs or JSDoc restatement.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Three to seven adjacent pages, closest prerequisite first, one short phrase each.

-----

<a id="model-experience"></a>
## Model Experience

<per the Model Experience contract in docs/cookbook/adding-a-package.md#4-write-the-package-readme; the verify-package-readme-model-experience gate owns the required form>

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

One orienting sentence, then top-level bullets naming current package constraints. Packages with none use the allowlist in scripts/verify-package-readme-limitations.ts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
```

## Rules

- **Fact-check before writing.** Mount the package in a test composition and run every command, config field, default, and behavior claim this README makes. Delete anything you did not reproduce; link the generated config catalog instead of restating fields.
- **Installation guidance.** A plugin package mounts through `cordis.yml` rows. Only a package declaring `dsh.bundle.patch` installs as a profile layer via `dsh plugin --profile <name> add <package>` — if this package lacks that declaration, say how it mounts in a composition, never `dsh plugin add`.
- **Model Experience and Known Limitations are gate-owned.** Match the exact headings and per-package forms the two gates enforce; update the gates' audited lists in the same change when behavior moves a package between forms.
- Re-run `pnpm run verify-translation-pairing --write packages/<group>/<pkg>/README.md` after editing the pair.
