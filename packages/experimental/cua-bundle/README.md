---
description: "Enable experimental Computer Use and configure PTC from the plugin page."
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

This workflow targets developers running macOS Web or unpackaged Desktop from source. Open Plugins, select More beside Experimental plugins, then open Computer Use and enable the switch. The permission page identifies the responsible application reported by macOS when the optional system query is available, and guides the user through requesting access, enabling the matching system switch, and automatically refreshing on return. Follow the application named by macOS if it differs from the detected source. Persistent PTC retains variables across calls under the selected file sandbox policy. For Web, run these commands from the repository root:

```sh
pnpm run build
pnpm dsh web
```

For the source Desktop launcher and its separate development profile, follow [Desktop development](../../../apps/desktop/README.md). Enable Computer Use in each profile that needs it.

The switch saves bundle selection in the profile’s `package.json`. Enabling preserves Coding Tools preferences and PTC execution mode. The detail page’s **Use persistent mode** action saves `ptc-runtime.executionMode: persistent-in-memory` in the user’s `cordis.patch.yml`. Already-persistent runtimes show a disabled button. Computer Use is designed for PTC and installed only in PTC sessions. When system permissions need attention, activation guidance opens the plugin details. The detail page offers **Set to PTC** for the new-session default; existing sessions keep their preset. HMR maintains these settings and the provider’s session tool registrations. Native components prepare when the provider loads and reuse the source-hashed executable when available. First preparation requires local compiler tools, and failure preserves diagnostics without publishing a new executable.

Disabling unloads the provider and withdraws CUA tools from its Agent scopes. It retains the selected default, runtime configuration and retained PTC variables. Enabling again does not recreate the runtime. Explicitly changing from per-call to persistent execution replaces the shared runtime through HMR and can interrupt an active PTC call.

Computer Use is available only on a macOS DSH Host. The native provider is an optional dependency installed only on macOS; shared CUA and Client packages remain in the installation. Other Hosts refuse enablement before saving settings. An already selected bundle is skipped at startup with a diagnostic and remains available for deselection; saved user settings remain. A browser on another operating system can connect to a supported Mac Host.

If preparation fails, the saved selection remains, while CUA operations stay unavailable. Refresh or reopen the plugin page to read the component diagnostic, correct its cause, then restart DSH.

Explicit activation runs a read-only permission check, which may start a helper without opening a system dialog. Open the [permission page](../cua/README.md) for system requests, settings navigation and automatic refresh. Tasks ask separately before accessing an application. Saved application decisions use profile-scoped domain storage. Conversation decisions survive turns, connections, DSH restarts and Computer Use disablement without applying to another conversation. Revoke access on the same page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details</summary>

The bundle patch mounts the shared native provider and permission UI with `agentPreset: ptc`. Using the exported `cordis.patch.yml` directly as an overlay bypasses bundle admission; its row-level condition skips the optional macOS provider on other Hosts. Shared entries alone do not provide computer control. The provider registers tools through existing Agent scopes, so other presets receive no CUA tool or guidance. Preset documents remain unchanged. The detail-page action uses the existing settings form to save `agent-preset-registry.selectedDefault: ptc` only when clicked, preserving the deployment `default`. The provider defaults to PTC scope even when a saved grants override omits that field. [CUA](../cua/README.md) owns registration and disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Computer use](../../../docs/subsystems/computer-use.md)

-----

<a id="model-experience"></a>
## Model Experience

### Computer Use and persistent PTC

#### What the model sees

Existing and new PTC sessions receive `cua` through the generated SDK and `run_code`, plus CUA guidance. Disabling withdraws these contributions and keeps PTC presentation. Other presets receive no CUA contributions. [CUA](../cua/README.md) and [PTC](../../ptc-runtime/ptc-runtime-node/README.md#persistent-repl) own the interfaces and output semantics.

#### Token effect

CUA activation adds its guidance. Disabling removes that guidance and retains the configured PTC instructions.

#### KV Cache effect

CUA activation and removal change the PTC SDK and system guidance; subsequent requests use the updated prefix. The top-level `run_code` transport remains present.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Source Web and Desktop share permission controls on macOS. Packaged Desktop helper distribution, signing, and permission attribution are deferred.
- PTC execution is shared by the profile. A Host without HMR applies saved changes at restart. When Coding Tools is off, the existing preset UI restores the new-session default to `standard`; choosing persistent execution leaves Coding Tools off.

<a id="dev-note"></a>
### Dev Note

None.
