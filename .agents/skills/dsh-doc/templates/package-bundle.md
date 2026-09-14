# Template: package-bundle

Use this template for a package whose manifest declares `dsh.bundle.patch` — an installable profile layer: `packages/bundle/*`, `dsh-subagent-codex`, `dsh-subagent-claude-code`. The `bundle/base` README pair is the worked example.

A bundle README leads with the profile-install path and the layer semantics; the implementation fold explains the patch document. It never presents the package as a library to import or as a single plugin to mount.

## Frontmatter

```yaml
---
description: "What the bundle layer adds to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---
```

## Skeleton

```markdown
# @deepseek-ai/dsh-<name>

English | [中文](README.zh.md)

## Summary

Three to five sentences and at most 100 `wc -w`-style words: what a profile gains from this layer, which profiles already include it, how a user adds or removes it, and the main boundary. Apply the [Summary voice rules](../SKILL.md#voice-rules).

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

### Install into a profile

The verified install path — run it against the current checkout before writing:

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-<name>
dsh plugin --profile <name> remove @deepseek-ai/dsh-<name>
```

State where in-box bundles resolve from, what the reconcile step activates, and what fails when the patch declaration is missing.

### What you get

The observable surface this layer adds: tools, providers, or UI rows, and which package owns each row's behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch document: insert list, row ids, platform gating, override semantics. Source-map table links `cordis.patch.yml` and `src/`. No API catalogs.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Adjacent pages: the group map, the profile contract, the composition graph.

-----

<a id="model-experience"></a>
## Model Experience

The form the verify-package-readme-model-experience gate assigns (bundle carriers are `indirect` or `none`: each inserted row's package owns its model-facing behavior).

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Current constraints: override semantics, platform gates, and conflict rules a user must respect.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
```

## Rules

- **Only `dsh.bundle.patch` packages use this template.** Verify the declaration in `package.json` before classifying; the `dsh plugin` reconcile activates a layer for exactly these packages.
- **Test the install path.** Run `dsh plugin --profile <name> add <this-package>` in a scratch profile and reproduce the documented warning, layer activation, and failure modes before writing them.
- Re-run `pnpm run verify-translation-pairing --write packages/<group>/<pkg>/README.md` after editing the pair.
