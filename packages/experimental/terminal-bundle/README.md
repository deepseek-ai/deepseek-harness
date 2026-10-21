---
description: "Keep shell processes alive across tool calls."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-terminal-bundle

English | [中文](README.zh.md)

## Summary

Add six experimental global terminal tools to every Agent. The bundle owns an isolated terminal registry with the platform shell backend; terminals remain Agent-owned. It ships switched off in Web and Desktop and is omitted from the Plugins bundle lists and detail pages.

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

In `$DSH_HOME/profiles/<name>/package.json` (default home: `~/.dsh`), add `@deepseek-ai/dsh-experimental-terminal-bundle` to `dsh.profile.bundles` to enable its profile layer; remove it from that list to disable it. Restart that profile to apply the change; see the [profile reference](../../../apps/cli/reference/README.md#profile-boot). The [minimal preset](../../bundle/web-app/presets/minimal.patch.yml) loads its own persistent shell independently of this bundle.

The selected layer adds its global tools to every Agent in the Host, in every preset including minimal. Hiding the management entry preserves existing selections; the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/persistent-terminal-controls/guide.md) explains how to disable a previously enabled layer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the Host group `optional-persistent-terminals`, which registers the tools in the global tool layer. Later profile patches can override its rows by id. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../tool-terminal/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../tool-terminal/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Terminals belong to the Agent that created them. POSIX uses Bash and Windows uses PowerShell; the bundle does not share another terminal registry.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
