---
description: "Active Loader package inventory metadata for deployments sending official DeepSeek requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-package-inventory-deepseek

English | [中文](README.zh.md)

## Summary

Best-effort active Loader-backed plugin package inventory for official DeepSeek LLM API requests. This function plugin injects the Loader, live Agent registry, and `ctx.deepseekLlmApiExtensions`, then owns the `dsh_plugin_packages` field. Enable it when the official API needs the active package list for request diagnostics.

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

At activation, the plugin samples the optional `ctx.pluginPackages` service. Shipped app boot mounts that service before profile Loader entries, so bare package and package-subpath identities use the same authoritative runtime resolution as their imports, including its misses, without requiring a `./package.json` export. If the service is absent, the plugin retains native Node package-search lookup for its lifetime and does not switch an existing inventory when a resolver mounts later. A low-level embedder that wants runtime resolution identities must therefore mount `PluginPackages` before both the Loader entries and this plugin.

Each ordinary entry uses its owning Loader tree base. A standing preset's root entries use the harness base, matching the preset Loader's deliberate bare-package override; nested includes retain their own bases. Relative and absolute modules walk to their nearest manifest; manifests without a non-blank string `name` are omitted. A missing or invalid `version` produces a name-only entry, regardless of `private`. A nested directory with its own manifest does not inherit its parent's identity. Package resolution, manifest reading, and JSON parsing failures omit only that entry and log one warning per module; inventory metadata does not block model requests. Entries are deduplicated by name and optional version and sorted with a locale-independent comparison; name-only entries sort before same-name versioned entries, and different versions remain separate.

The version-1 `dsh_plugin_packages` field contains `{ name, version }` or `{ name }` entries; `version` is included only when it is a non-blank string. Disabled, pending, failed, disposed, unloading, structural `cordis:` rows, ordinary dependencies, loose files without an owning package identity, programmatically mounted child fibers, and in-memory dynamic plugins are excluded.

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

- **Loader package identity only** — programmatic child fibers and in-memory dynamic plugins do not have authoritative npm names and versions and remain outside this inventory.
- **Unavailable identities are omitted** — the inventory can be partial when package metadata is unavailable.
- **In-place package replacement requires restart** — manifest identities are cached for the process lifetime. Loader enable, disable, mount, unmount, and ordinary source HMR still refresh the active entry set, but replacing a mounted package's manifest with another version in the same process is not a supported upgrade path.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
