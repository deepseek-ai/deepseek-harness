---
description: "Enable optional macOS Computer Use and its permission page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-bundle

English | [中文](README.zh.md)

## Summary

Enable macOS Computer Use from Plugins for existing and new PTC sessions. Windows support is in development. This bundle remains in `experimental` until that support is complete, then moves to the `computer-use` group. It is off by default; disabled profiles prepare no native components and register neither CUA tools nor their model guidance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

This workflow targets developers running macOS Web or unpackaged Desktop from source. Open Plugins, select More beside Experimental plugins, then open Computer Use and enable the switch. The permission page identifies the responsible application reported by macOS when the optional system query is available. Request access and enable that application in System Settings; follow the application named by macOS if it differs from the detected source. For Web, run these commands from the repository root:

```sh
pnpm run build
pnpm dsh web
```

For the source Desktop launcher and its separate development profile, follow [Desktop development](../../../apps/desktop/README.md). Enable Computer Use in each profile that needs it.

The switch saves bundle selection in the profile’s `package.json`. Computer Use is installed only in PTC sessions. Enabling from the plugin list offers setup guidance when system permissions need attention; enabling from its detail page displays the permission controls directly. The detail page offers **Set to PTC** for the new-session default; existing sessions keep their preset. The switch leaves PTC execution mode and other settings unchanged. The detail page’s **Use persistent mode** action separately enables in-memory state across PTC calls; its effects and reload behavior are described in the [permission page](../cua/README.md). Native preparation runs when the provider loads and reuses the source-hashed executable when available.

Disabling unloads the provider and withdraws CUA tools from its Agent scopes. Runtime configuration, the new-session default and saved grants remain. Session-only application decisions end with provider disposal.

Computer Use requires a macOS DSH Host. On other operating systems, installation omits the optional macOS provider and the bundle skips its Loader entry. Shared CUA logic and the permission-page entry remain available, but Computer Use operations require the provider. A browser on another operating system can connect to a supported Mac Host.

If preparation fails, the saved selection remains and CUA operations stay unavailable. Read the Host startup diagnostic, correct its cause, then restart DSH.

Explicit activation runs a read-only permission check, which may start a helper without opening a system dialog. Open the [permission page](../cua/README.md) for system requests, settings navigation and automatic refresh. Tasks ask separately before accessing an application. Saved application decisions use the existing profile configuration; session decisions remain in memory across turns and connections until DSH restarts or Computer Use is disabled. Revoke access on the same page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details</summary>

The bundle patch mounts the native provider and permission UI with `agentPreset: ptc`. Existing Agent scopes register the tools without changing preset documents. The detail-page action uses the existing settings form to save `agent-preset-registry.selectedDefault: ptc` only when clicked. [CUA](../cua/README.md) owns registration and disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Computer use](../../../docs/subsystems/computer-use.md)

-----

<a id="model-experience"></a>
## Model Experience

### Computer Use in PTC sessions

#### What the model sees

Existing and new PTC sessions receive `cua` through the generated SDK and `run_code`, plus CUA guidance. Disabling withdraws these contributions and keeps PTC presentation. Other presets receive no CUA contributions. [CUA](../cua/README.md) and [PTC](../../ptc-runtime/ptc-runtime-node/README.md#persistent-repl) own the interfaces and output semantics.

#### Token effect

CUA activation adds its guidance. Disabling removes that guidance; the existing PTC execution instructions remain.

#### KV Cache effect

CUA activation and removal change the PTC SDK and system guidance; subsequent requests use the updated prefix. The top-level `run_code` transport remains present.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Source Web and Desktop share permission controls on macOS. Packaged Desktop helper distribution, signing, and permission attribution are deferred.
- PTC execution is shared by the profile and is configured independently. A Host without HMR applies saved changes at restart. Saving or revoking application grants while another HMR transaction unloads the provider can block; queued-write cancellation is a separate pending lifecycle fix.

<a id="dev-note"></a>
### Dev Note

None.
