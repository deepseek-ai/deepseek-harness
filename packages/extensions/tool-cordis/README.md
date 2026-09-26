---
description: "Read-only runtime API discovery for agents developing and configuring installed Harness plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

English | [中文](README.zh.md)

## Summary

Inspect Host and Client runtime APIs before writing plugin code. Creator mode provides these read-only tools alongside Plugin Manager, which owns persistent profile changes. The inspection registry is supplied by the Cordis host runner; browser queries need a connected page.

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

Creator mode includes this toolset. Other compositions mount `@deepseek-ai/dsh-tool-cordis/host` once in the host composition beside the host runner that provides `cordisInspect`, and `@deepseek-ai/dsh-tool-cordis` in each agent preset that exposes the tools; a preset row alone registers no Host providers. Call `cordis_inspect_list` to discover providers, then `cordis_inspect_query` for a provider's exact methods and types. The Host `Config` provider lists live Loader entries in pages (`offset`, `limit` up to 100, optional exact plugin `name`; `total` and `nextOffset` bound the walk) with each entry's Loader id, the tree-local id patches address, and its Config status (`schema`, `absent`, `unsupported`, `tree` for group and include carriers, `inactive` for disabled, never imported, or disposed entries), and projects one entry's native Config into a self-contained JSON Schema document beside the entry's `packageDir`, the resolved directory holding the package README and built `lib/`, when the profile package lookup resolves it. Use [Plugin Manager](../../boot/plugin-manager/README.md) to install bundles containing plugin code or MCP configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Host providers combine generated Service/Event catalogs, the live Loader tree projected through the app-boot Config projector, and the requesting agent's tool registry. Client providers synchronize their manifests through the existing inspection registry and answer queries from a connected page. The host entry owns the Host provider registrations and the preset row owns the two tools, each through Cordis effects; the registry rejects a duplicate provider id, which is why the providers register once per process rather than per preset. No invariant companion is published because inspection reads its providers directly and maintains no independent runtime projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin Manager](../../boot/plugin-manager/README.md) — persistent bundle installation and enablement.
- [Cordis host runner](../cordis-host-runner/README.md) — inspection registry and existing runtime consumers.

<a id="model-experience"></a>
## Model Experience

### Runtime inspection

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis) describes two read-only inspection tools. The plugin contributes no system prompt section: the tool descriptions state when to call each tool and that queries never invoke business methods. In the `cordis` preset, the first-turn skill catalog carries the descriptions of the two shipped skills, which route plugin, MCP, composition, and destination-less visual requests to the skill covering Plugin Manager, MCP setup, Client packaging, and slot registration. Query results contain the requested API declarations, live tool schemas, the live entry directory with Config status, or one entry's projected Config JSON Schema.

#### Token effect

Only the two tool schemas enter model requests while this plugin is visible. Query results append to the transcript; exact queries avoid loading unrelated declarations.

#### KV Cache effect

Unchanged tool schemas remain prefix-stable. Query results append to history; enabling other plugins can change subsequent tool schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Client queries wait for a responding page or cancellation. Inspection cannot invoke service methods, configure plugins, or execute generated code.
- `Config.listConfigs` walks the profile Loader tree only. Agent preset `plugins` lists mount in detached preset trees, so a plugin present only inside a preset declaration is not listed unless the profile tree also mounts it.

<a id="dev-note"></a>
### Dev Note

None.
