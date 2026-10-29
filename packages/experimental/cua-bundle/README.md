---
description: "Enable optional macOS Computer Use and its permission page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-bundle

English | [中文](README.zh.md)

## Summary

Enable macOS Computer Use from Plugins for existing and new PTC sessions. Windows support is in development. This bundle remains in `experimental` until that support is complete, then moves to the `computer-use` group. It is off by default and hidden from the default plugin lists until enabled or separately installed; disabled profiles prepare no native components and register neither CUA tools nor their model guidance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

In macOS Desktop, open **Plugins → Add plugin**, enter `@deepseek-ai/dsh-cua-bundle`, choose **Install**, then **Enable now**. DSH installs the official version matching its runtime into the profile. Published packages contain the signed and notarized helper; users need no compiler. Source Web and development Desktop link the workspace bundle and prepare an ad-hoc helper when enabled. Open Computer Use details, choose PTC if needed, and grant Accessibility and Screen Recording to `DSH Computer Use.app`. Disabled installed bundles remain available for management. For source Web, run these commands from the repository root:

```sh
pnpm run build
pnpm dsh web
```

For the source Desktop launcher and its separate development profile, follow [Desktop development](../../../apps/desktop/README.md). Enable Computer Use in each profile that needs it.

The switch saves bundle selection in the profile’s `package.json`. Computer Use is installed only in PTC sessions. Enabling through Add plugin, a visible card, or its detail page offers setup guidance when system permissions need attention. The detail page offers **Set to PTC** for the new-session default; existing sessions keep their preset. The switch leaves PTC execution mode and other settings unchanged. The detail page’s **Use persistent mode** action separately enables in-memory state across PTC calls; its effects and reload behavior are described in the [permission page](../cua/README.md). Native preparation runs when the provider loads and reuses the source-hashed executable when available.

Disabling unloads the provider and withdraws CUA tools from its Agent scopes. Runtime configuration, the new-session default and saved grants remain.

Computer Use is available only on a macOS DSH Host. The native provider is an optional dependency installed only on macOS; the bundle and its shared libraries install on demand. Other Hosts hide the bundle from default plugin lists and model recommendations and refuse enablement before saving settings. Explicit profile dependencies and saved selections remain visible for management. An already selected bundle is skipped at startup with a diagnostic and remains available for deselection; saved user settings remain. A browser on another operating system can connect to a supported Mac Host.

If preparation fails, the saved selection remains and CUA operations stay unavailable. Refresh or reopen the plugin page to read the component diagnostic, correct its cause, then restart DSH.

Explicit activation runs a read-only permission check, which may start a helper without opening a system dialog. Open the [permission page](../cua/README.md) for system requests, settings navigation and automatic refresh. Tasks ask separately before accessing an application. Saved application decisions use profile-scoped domain storage. Conversation decisions survive turns, connections, DSH restarts and Computer Use disablement without applying to another conversation. Revoke access on the same page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details</summary>

The bundle patch mounts the native provider and permission UI with `agentPreset: ptc`. Using the exported `cordis.patch.yml` directly as an overlay bypasses bundle admission; its row-level condition skips the optional macOS provider on other Hosts. Shared entries alone do not provide computer control. Existing Agent scopes register the tools without changing preset documents. The detail-page action uses the existing settings form to save `agent-preset-registry.selectedDefault: ptc` only when clicked. [CUA](../cua/README.md) owns registration and disposal.

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

- First installation requires a reachable registry carrying the matching DSH version. System permissions require the user’s approval in macOS; installation does not grant them.
- PTC execution is shared by the profile and is configured independently. A Host without HMR applies saved changes at restart.

<a id="dev-note"></a>
### Dev Note

None.
