---
description: "Choose an Agent’s tools, prompt sections and skills through declarative presets. One process can run several compositions. Failed definitions remain visible, while existing Agents retain the composition they already use."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-preset-registry

English | [中文](README.zh.md)

## Summary

Choose an Agent’s tools, prompt sections and skills through declarative presets. One process can run several compositions. Failed definitions remain visible, while existing Agents retain the composition they already use.

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

### Minimal configuration

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
| `default` | required | Preset ID used when none is requested |

The Web definitions come from the `dsh-web-app` bundle. Definitions are ordinary plugin rows; the registry neither scans directories nor accepts preset paths. The `selectedDefault` volatile field of the `agent-preset-registry` entry retains the user default, which new sessions resolve over the deployment `default`. A profile patch may still carry the retired `modeSelectionEnabled` field; the registry declares no such field and neither reads nor rewrites it.

The registry writes no declarations. The `read` Remote renders one declaration’s child list back as entry-list YAML (`!!js` conditions included) so a client can show what a preset composes; nothing accepts YAML back. A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row, or a patch keyed by that row’s id, installed into the profile with `plugin_manager`; Creator mode authors such bundles in conversation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree. Updating or removing a declaration retires its previous revision. Agents, children and temporary historical reads retain references; releasing the final reference disposes the retired tree. Plugin registrations inherit the preset scope, and the Agent scope’s parent link controls visibility. The Host continues to share the Agent loop.

Activation auditing checks imports, missing services and globally leaked services. Import failures, activation failures and leaks reject the mount. A row waiting for a Host service stays mounted, and every read and binding re-audits it after the Host Loader tree settles, so startup order does not decide the outcome. Failure prevents new bindings to that definition. Session logs retain the preset ID and blank-session selections; recovery after restart uses the current definition of that ID and rejects a missing definition.

| File | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Registration, revisions and Agent bindings |
| [mount.ts](src/mount.ts) | Scoped plugin trees and activation auditing |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope](../../core/scope/README.md) — Registration isolation.
- [Agent](../../core/agent/README.md) — Session runtime.
- [Cordis](../../../docs/cordis-primer.md) — Plugin configuration and lifecycle.

<a id="model-experience"></a>
## Model Experience

### Preset selection

#### What the model sees

Nothing directly: the selected preset’s `plugins` own the model-visible tools and prompt sections.

#### Token effect

None from this package; each mounted `plugins` row declares its own tools and sections.

#### KV Cache effect

Existing Agents retain their plugins and prompts. New Agents build their prefixes from the current definition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Presets are not security sandboxes: YAML and plugins can execute Host code. A user override replaces the complete child list and does not automatically merge future changes to the builtin list. Old revision implementations are not retained across process restarts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** The companion checks services leaked globally after activation and Agents addressing a model without joining a configured preset.
