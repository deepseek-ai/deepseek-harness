---
description: "Active Loader package inventory metadata for deployments sending official DeepSeek requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-package-inventory-deepseek

English | [中文](README.zh.md)

## Summary

Complete active Loader-backed plugin package inventory for official DeepSeek LLM API requests. This function plugin injects the Loader, live Agent registry, and `ctx.deepseekLlmApiExtensions`, then owns the `dsh_plugin_packages` field. Enable it when the official API needs the active package list for request diagnostics.

## Table of Contents

- [Configuration](#configuration)
- [Collection](#collection)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Register the `dsh_plugin_packages` contribution. Set it to `false` to omit package metadata. |

Shipped profiles use the default, so every official DeepSeek request carries the package inventory when preparation succeeds.

<a id="collection"></a>
## Collection

Every request re-reads active non-group entries from the host Loader tree. When optional `ctx.agentPresets` is present and `sessionId` resolves to a live Agent joined to a standing preset, that preset's separate Loader tree joins the same collection; deployments without the service report the host tree only. Entries are included only while their root fiber is `ACTIVE` and their effective Loader state is enabled.

Bare package and package-subpath specifiers resolve through Node's package search paths without requiring a `./package.json` export. Each ordinary entry uses its owning Loader tree base. A standing preset's root entries use the harness base, matching the preset Loader's deliberate bare-package override; nested includes retain their own bases. Relative and absolute modules walk to their nearest manifest; a manifest without `name` marks a loose module and contributes no package identity. A named package manifest must also declare a non-empty `version`, and malformed package metadata fails request preparation. Exact name/version pairs are deduplicated and sorted with a locale-independent comparison, while simultaneously active different versions remain separate.

The version-1 `dsh_plugin_packages` field contains only `{ name, version }` pairs. Disabled, pending, failed, disposed, unloading, structural `cordis:` rows, ordinary dependencies, loose files without an owning package identity, programmatically mounted child fibers, and in-memory dynamic plugins are excluded.

<a id="model-experience"></a>
## Model Experience

### Package inventory metadata

#### What the model sees

Nothing. `dsh_plugin_packages` is provider metadata outside the model's messages, system prompt, and tool schemas.

#### Token effect

Zero model-input tokens; the complete inventory adds only HTTP request bytes.

#### KV Cache effect

None; package lifecycle changes do not alter the model-visible prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Loader package provenance only** — programmatic child fibers and in-memory dynamic plugins do not have authoritative npm name/version provenance and remain outside this inventory.
- **Loose modules are omitted** — a relative file without a named and versioned owning manifest is a plugin module, not a plugin package.
- **In-place package replacement requires restart** — manifest identities are cached for the process lifetime. Loader enable, disable, mount, unmount, and ordinary source HMR still refresh the active entry set, but replacing a mounted package's manifest with another version in the same process is not a supported upgrade path.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each request reads authoritative Loader fiber state and package manifests directly; the plugin retains no independently mutable inventory.
