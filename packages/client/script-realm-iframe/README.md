---
description: "Provide optional same-origin iframe script environments through the Realm registry."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-script-realm-iframe

English | [中文](README.zh.md)

## Summary

Use this provider when framework code explicitly needs a separate browser global environment with direct object references. Loading the plugin registers the `iframe` factory without allocating a frame. It does not move application plugins or change their default execution environment.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The normal Client plugin injects `scriptRealms` and registers its factory. A composition must supply the [registry](../script-realm/README.md); neither package is a default application entry. The provider accepts no configuration.

<a id="understand-the-implementation"></a>
## Understand the implementation

Each request creates a hidden same-origin iframe. `expose()` installs direct references without replacing existing or reserved globals. `execute()` loads an external classic script, resolving relative URLs against the provider page. Cancellation or disposal rejects pending executions and removes the frame. Callers retain responsibility for disposing created instances.

<a id="further-exploration"></a>
## Further Exploration

- [Client modules](../modules/README.md)
- [Web client architecture](../../../docs/subsystems/web-client.md)
- [Client entry](src/client/index.ts)

<a id="model-experience"></a>
## Model Experience

None, as this optional browser infrastructure registers no model-facing tools or prompts.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Same-origin access is not hostile-code isolation. Native `window`, `document`, viewport, timers, and DOM constructors belong to the iframe; no transparent main-page emulation is provided. Module placement, pooling, and Shadow DOM are deferred.

<a id="dev-note"></a>
### Dev Note

None.
