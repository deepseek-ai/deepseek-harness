---
description: "Define an Agent’s child plugins in ordinary Cordis YAML. Declare several presets and let sessions select one. Definitions load eagerly, and edits affect subsequently created Agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-preset

English | [中文](README.zh.md)

## Summary

Define an Agent’s child plugins in ordinary Cordis YAML. Declare several presets and let sessions select one. Definitions load eagerly, and edits affect subsequently created Agents.

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

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Stable preset identifier |
| `plugins` | required | Child plugin entry list |
| `name` | unset | Display name |
| `description` | unset | Display description |
| `order` | unset | Roster order |

The declaration row’s `id` addresses Loader edits; `config.id` is the preset identity saved by sessions. Child entry IDs may be omitted and assigned by Loader.

The package also ships the `skills/` directory that creator mode mounts through `skill-filesystem`. It holds one skill, `dsh-doc`: a short `SKILL.md` that sets the order for finding DSH facts (runtime inspection when its tools are available, then the installed documentation and package sources) and states that loading the skill authorizes no file or profile change, plus `references/` read on demand and copyable `templates/` bundles. The references cover locating documentation, plugin development, bundle display metadata and detail documents, Web UI plugins, MCP bundles, extension practices, user actions, verification and user experience review, icon and feature-image drawing, agent presets, the Loader patch dialect, tool design, upgrades across DSH releases, and `references/packages.md`, which `scripts/gen-plugin-packages.ts` generates and `doc-sync` checks for freshness. The rendered `SKILL.md` and every reference except `packages.md`, read with line numbers, stay under the 8192-character threshold above which the standard preset's tool-result pruner trims results.

Edit tool design rules in [skills/dsh-doc/references/tool-design.md](skills/dsh-doc/references/tool-design.md). The repository skill `.agents/skills/agent-experience/SKILL.md` only links to that file.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[index.ts](src/index.ts) registers a definition and returns its disposer to Cordis. The plugin’s group marker preserves child `!!js` expressions until their own plugins load. The [registry](../agent-preset-registry/README.md) owns revision retention and release.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope](../../core/scope/README.md) — Registration isolation.
- [Agent](../../core/agent/README.md) — Session runtime.
- [Cordis](../../../docs/cordis-primer.md) — Plugin configuration and lifecycle.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the declared plugins, which own model-visible tools and prompts.

#### KV Cache effect

A live Agent’s composition stays stable; new Agents can use an updated definition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Requires the `agentPresets` service. Duplicate preset IDs fail declaration loading. Declarations provide no directory, file-copy or file-delete operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
