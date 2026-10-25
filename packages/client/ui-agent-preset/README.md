---
description: "Choose Agent presets and the new-task default in Web, read what each mode does and what it declares. Authoring is guided to Creator mode."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

English | [中文](README.zh.md)

## Summary

Choose Agent presets and the new-task default in Web, read what each mode does and what it declares. Authoring is guided to Creator mode.

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

Settings shows the built-in and custom card groups with default highlighting and card-body selection; a group without presets is omitted, except the custom group, which keeps its Creator entry on screen. Coarse-pointer devices show complete card descriptions; other devices clamp descriptions to four lines with the full text available on hover. Every card offers “View configuration”, which opens the preset's declared plugin list as read-only YAML in the Loader's own dialect (`!!js` conditions included); a failed preset stays readable because its diagnostic points into that YAML. Escape closes only the viewer and returns focus to its card; leaving Settings clears the viewer, and a late read does not reopen it. The page edits nothing: the Creator entry starts a Creator-mode task that authors or overrides a preset as a bundle, offered while the `cordis` preset is on the roster and a conversation flow exists.

With Coding Tools off in General Settings, the new-session picker and Settings roster offer Standard, Creator, and custom presets; turning them on also offers PTC and Minimal. Default selection and the Creator entry remain available in both states. Choosing a healthy default also synchronizes the blank session on the current new-task surface. Creator starts a new task using the `cordis` preset.

Turning Coding Tools off clears all unapplied choices through the existing Developer tools subscription. Once the off value is accepted, every authenticated browser resets a saved built-in PTC or Minimal default to Standard. Saved Standard, Creator, and custom defaults (including named PTC or Minimal overrides) stay unchanged. The user can select an available preset again after turning Coding Tools off. Existing sessions keep their selected mode; New Session uses the current default. An existing mode's label remains visible even when that mode is absent from the menu. Turning Coding Tools back on does not restore the old default or cleared choice. If Standard is missing or broken, the default remains unchanged and an error is shown.

Known shipped presets offer mode details and usage examples in a read-only dialog. Minimal's guide explains image reading, automatic history compaction, and the idle-session `/compact` command. Its tabs preserve each page's scroll position; closing returns focus to the opening action. Help does not change the new-task default. The default badge replaces the card's group badge, and the preset id appears beside the title. Guide copy and examples belong to this package.

**Let the agent create a plugin** in the Plugins page's **Add plugin** arrow menu enters the same Creator flow as Settings. It submits no message and preserves unsent drafts. While the roster loads or Creator is unavailable, the menu item is disabled with an explanation. Both entries show a Toast with the reason if the Host refuses the preset switch.

Entering Creator selects `cordis` for the receiving blank Session without changing the new-task default or Coding Tools setting. If no workspace or blank Session is bound yet, the choice waits for that binding. After the choice is applied, the Creator Session keeps its preset; a later newly created Session uses the configured default, such as Standard.

On Desktop, the optional [product analytics](../product-analytics/README.md) service receives `agent_preset_switch` when a direct mode-picker choice moves to a different built-in preset: an unbound choice counts once it is staged for the next Session, and a choice for the bound blank Session counts once the Host applies it. The event carries the source and target categories mapped from the preset id (`cordis` is `creator`; `ptc`, `minimal`, and `standard` keep their ids; any other id is `other`) and the Coding Tools setting known at the choice. Custom targets, refused choices, choices the Host settles on another preset, default changes and their blank-Session synchronization report nothing, and neither does a choice made while the source mode or Coding Tools setting is unknown. Custom preset ids and names are not collected.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`agentPresets/list` supplies the roster and marks the current default, and `agentPresets/read` one declaration's YAML for the viewer; default changes write the `agent-preset-registry` settings namespace. The picker, blank-session synchronization and read-only session label use recorded preset identities. Connection resets and settings updates refresh the roster.

`CreatePluginMenuItem` contributes to `plugins.add.actions` using the shared roster store. Its selection calls the owner's `onDismiss()` before the same `startCreatorDraft` callback exposed to Settings as `creatorDraft`. That callback stages `cordis` through `AgentPresetSeatController`, except when the main blank Session lists a different preset (navigation then opens another blank and leaves that one unchanged), and opens the task through `uiWorkspace.startSession` with explicit draft preservation and `agentPreset: 'cordis'`, so the Host composes the reused blank or new Session under Creator; without a target Workspace, the staged choice applies when a Session binding becomes available. The choice is consumed once applied. Both Coding Tools states use the same picker and selection store, and `AgentPresetSeat` renders refusals through the shared `Toast` component.

`AgentPresetSeatController.select()` and `apply()` return the attempt's outcome: `applied` when the Host commits the staged preset, `staged` while no Session is current, `unchanged` when busy, without a stage, for a started or already matching Session, or when the Host settles on another preset, and `refused` with the bare Host reason. The chip's injected `select` reports `agent_preset_switch` from that outcome and returns only the refusal reason.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope](../../core/scope/README.md) — Registration isolation.
- [Agent](../../core/agent/README.md) — Session runtime.
- [Cordis](../../../docs/cordis-primer.md) — Plugin configuration and lifecycle.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the selected preset, whose plugins own model-visible capabilities.

#### KV Cache effect

Selection changes affect only later tasks; existing plugins and prompts remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web creates and edits no preset: the configuration viewer is read-only, and a bundle installed through Creator mode declares a new preset or overrides a shipped one by row id, replacing its complete child list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
