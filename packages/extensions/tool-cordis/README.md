---
description: "Read-only runtime API discovery for agents developing and configuring installed Harness plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

English | [中文](README.zh.md)

## Summary

Inspect Host and Client runtime APIs before writing plugin code. The Desktop Standard and Creator modes and the SDK profile provide this read-only tool alongside Plugin Manager, which owns persistent profile changes. The Cordis host runner supplies the inspection registry and the Host providers; browser queries need a connected page.

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

The Desktop Standard and Creator modes and the SDK profile include this tool. Other compositions mount `@deepseek-ai/dsh-cordis-host-runner` once in the host composition, which provides `cordisInspect` and registers the [Host providers](../cordis-host-runner/README.md#host-inspect-providers), and `@deepseek-ai/dsh-tool-cordis` in each agent preset that exposes the tool. Call `cordis_inspect` without `query` to discover providers, then pass a `query` object with `platform`, `provider`, `method`, and optional `input` to read a provider's exact methods and types. A query without an Agent fails with `ToolContextUnavailableError`. Use [Plugin Manager](../../boot/plugin-manager/README.md) to install bundles containing plugin code or MCP configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The preset row registers the tool through a Cordis effect and queries the shared `cordisInspect` registry. The Cordis host runner registers the Host providers once per process, because the registry rejects a duplicate provider id. Client providers synchronize their manifests through the same registry and answer queries from a connected page.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin Manager](../../boot/plugin-manager/README.md) — persistent bundle installation and enablement.
- [Cordis host runner](../cordis-host-runner/README.md) — inspection registry, Host providers, and existing runtime consumers.

<a id="model-experience"></a>
## Model Experience

### Runtime inspection

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis) describes one read-only inspection tool whose description explains directory discovery and queries without adding a system prompt section. In the `standard` and `cordis` presets, the first-turn skill catalog carries the description of the shipped `dsh-doc` skill, which covers questions about DSH and requests to build or change DSH plugins, MCP connections, and agent presets; its references cover Plugin Manager, MCP setup, Client packaging, and slot registration. Query results contain the requested API declarations, live tool schemas, the live entry directory with Config status, one entry's projected Config JSON Schema, or the running DSH version.

#### Token effect

In the shipped Desktop Standard and Creator modes and the SDK profile, this plugin contributes one tool schema to each model request. Query results append to the transcript; exact queries avoid loading unrelated declarations.

#### KV Cache effect

Unchanged tool schemas remain prefix-stable. Query results append to history; enabling other plugins can change subsequent tool schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Client queries need a responding page and use the Host runner's [bounded wait and retry policy](../cordis-host-runner/README.md#client-inspection). Inspection cannot invoke service methods, configure plugins, or execute generated code.

<a id="dev-note"></a>
### Dev Note

None.
