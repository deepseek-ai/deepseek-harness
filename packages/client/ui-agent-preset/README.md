---
description: "Agent-preset surfaces for the Web GUI: picker visibility and default settings, the new-session chip, the session-header label, and preset roster management; for users and maintainers of agent composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

English | [中文](README.zh.md)

## Summary

Use this package to choose the agent preset for a new Web GUI session, see the active preset in the session header, and manage available presets in Settings. The Agent mode picker is shown by default; Settings can hide it without changing running or historical sessions. A preset is fixed when a session is created, so changing the selection or default affects only later sessions. If the deployment provides no presets, these controls stay hidden and every session uses the host composition.

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

Mount this plugin alongside the settings and conversation packages; the management section then shows a visibility switch that is on by default. While it is off, the new-session chip is absent and the Host composes an unnamed session from the deployment default (`standard` in the shipped Web bundle). Turning it on restores the saved user default, or uses the deployment default when none has been saved, and carries that default to the current blank task; a chip pick itself is staged only once for the next blank session. Turning the picker off again returns the current blank task to the deployment default the same way and discards an unconsumed stage; started and historical sessions keep their labels, compositions, and recorded history.

### Managing the roster

The settings section shows the roster as cards: a copy dialog is the only way a preset is created — the browser edits no composition text — and every custom card keeps a location action that opens the preset's own files. The visibility switch changes only whether the saved user default is active: the Host uses the deployment default while hidden and restores the saved default when the picker is shown again. While the picker is enabled, choosing a healthy non-default card writes a new user default for later sessions; if the current new-task surface already reuses a blank session, that explicit Settings action carries the same preset to that exact blank session through the existing selection path. Started and historical sessions remain unchanged. The switch is disabled while saving, and a failed write keeps the prior preference and shows an error. Hiding the picker disables default selection and the Creator launch but leaves roster viewing, copying, location, and deletion available. Deleting removes the preset directory while sessions already composed from it keep running. A shipped preset opens in a read-only viewer and offers no location or delete. A roster row carrying `broken` renders as a marked card whose body and duplication are disabled, because a copy of a broken preset is another broken preset; broken custom rows keep their location and delete actions so the files can be fixed and ghost directories cleared. The card face still shows the preset's own description — a chooser cannot act on a package specifier there — and the host's reason rides the badge as a tooltip, plus a visually hidden alert that carries it to assistive technology, which a disabled card body cannot.

### The conversational entry

When the roster carries the self-referential `cordis` preset, its dashed add-card stays disabled until the picker is enabled. It then stages `cordis` and starts a new session — the section closes the settings panel and the new-session chip's own applier composes the blank session the workspace flow produces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The settings section writes the Host's existing `agent-presets` namespace through `settings.update`. Its visibility switch sets only `modeSelectionEnabled`, and its make-default action writes `default` only while the picker is shown. After either write, the Host roster supplies the effective default, and the chip controller's `agentPresets/select` path carries it to the same still-blank session; that path is the only session-mutation API these surfaces use. Display options and Host-effective visibility come from `agentPresets/list` — the roster already marks the effective Host default and carries `modeSelectionEnabled`, so a non-loopback read-only client stays consistent without introspecting the settings schema. The settings section queries `settings.canOpenAgentPresetDirectory()` when it first loads and joins that result with the roster; a failed query removes only the native-open affordance. The new-session chip renders only while `modeSelectionEnabled` is true; hiding it drops a pending stage and local menu or refusal state, while the header label remains registered and reads each session's recorded preset. The stage is applied when a session arrives (covering both the session a workspace connect created and the blank one it reused) and dropped on refusal. A refusal announces itself as a transient banner over the composer column, because the chip's label has already reverted and a preset the Host refuses to mount is one discovery reported healthy — its roster card carries no reason to go back and read. Only a pick a person just made is announced; the applier that runs when a session becomes current is not. [`dsh-client-connection`](../connection/README.md) authenticates `agentPresets/read`, `agentPresets/copy`, `settings/openAgentPresetDirectory`, `agentPresets/deletePreset`, `agentPresets/list`, and every other Host API method with the same browser session. A composition still names the plugins a session runs, so reading one is reconnaissance, while copy, delete, and the settings-owned directory opener manage the roster and drive the Host desktop. The section re-reads on its own actions, `settings/document-updated`, and `connection/reset`, because composition files are edited outside the browser and nothing on the wire announces a file change.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the preset surface is not enough. They move from the browser surfaces to the preset domain and the composition model.

- [dsh-agent-presets](../../preset/agent-presets/README.md) — the host roster and composition the surfaces read and manage.
- [ui-conversation](../ui-conversation/README.md) — declares the hero and session-header slots the chip and label fill.
- [ui-settings](../ui-settings/README.md) — the settings shell that hosts the roster section.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the preset a later session is composed from; the preset it selects owns every model-facing effect.

#### KV Cache effect

No direct invalidation. Changing picker visibility or the default does not alter a running session's composition or prefix, or a historical session's recorded preset; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current preset surfaces. They are current package constraints, not a general composition comparison or a task backlog.

- **A preset without metadata is listed by id** — display text is optional, and a copy given no name deliberately falls back to its directory name rather than presenting itself identically to its source. The resolution itself is the shared `presetDisplayText` fold from [`dsh-agent-presets/display`](../../preset/agent-presets/README.md), which the Settings plugin list inlines over this plugin’s dictionaries to show shipped presets in the active locale without translating user-authored metadata.
- **A revealed path is display text, not a link** — where the host has no desktop opener the row shows the directory to copy by hand; the browser cannot open a host filesystem location itself.
- **Composition edits are invisible to the page** — the files are edited outside the browser and nothing on the wire announces a file change, so the roster re-reads on its own actions, `settings/document-updated`, and `connection/reset`, not on every disk edit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This is a browser-side surface plugin whose node half owns no event stream or mutable runtime data; the roster and the settings write are host contracts covered there.
