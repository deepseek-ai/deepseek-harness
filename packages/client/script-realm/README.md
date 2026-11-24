---
description: "Register optional script-environment providers and create caller-owned Realm instances."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-script-realm

English | [中文](README.zh.md)

## Summary

Use this package when a Client extension needs a named script-environment provider. Registration does not create an environment; creation returns an instance whose caller owns cleanup. The default Web roster loads the registry as an ordinary entry, and application startup waits for it only when a package requests script isolation. The module loader keeps its own Main execution environment and uses a registered provider only for packages that request script isolation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The normal Client plugin provides `ctx.scriptRealms`. Provider plugins inject `scriptRealms` and register factories through its effect-owned `register()` operation. The returned disposer is asynchronous; callers that remove a registration early await it, while plugin teardown owns automatic removal. This package declares no configuration; the default Web roster includes it.

<a id="understand-the-implementation"></a>
## Understand the implementation

When the registry plugin activates, it calls `modules.installRealmRegistry(this)` if the page module system at `loader.internal` implements this package's `ScriptRealmRegistryHost` interface. Plugin teardown detaches its registry without disturbing a replacement. If no such module system is present at activation, `ctx.scriptRealms` still works as a standalone Cordis service; a Loader mounted later does not trigger installation.

`create()` resolves a registered provider by name and passes the caller-supplied identity and cancellation signal to it. Removing a provider prevents subsequent creation through that registration; it does not dispose instances already returned. The registry does not assign modules to environments; [Client modules](../modules/README.md) selects the environment of a script-isolated package.

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

- Capability matching, environment reuse, and grouping several packages in one environment are not implemented. A Script Realm preserves direct references and is not a security sandbox.

<a id="dev-note"></a>
### Dev Note

None.
