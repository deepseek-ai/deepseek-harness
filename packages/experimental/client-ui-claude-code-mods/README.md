---
description: "Web band above the prompt for Claude Code mods: draws each session's mod tree from the bridge's Remote and sends button clicks back."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-claude-code-mods

English | [中文](README.zh.md)

## Summary

This optional browser plugin draws the band a [Claude Code mod](../claude-code-mods/README.md) renders above the prompt. It mounts the bridge's `claudeCodeMods` Remote, watches each open session's band, and renders the serialized `Box`/`Text`/`Button` tree as a full-width entry above the composer card; clicking a button runs the mod's `onPress` on the Host and the band redraws. Without a mod that draws, nothing is shown.

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

Compose it beside the bridge and the mods; the [opt-in overlay](../claude-code-mods/cordis.source.patch.yml) does so for a source launch of the Web profile. The band appears only while a mod's `ui.render` hook returns a tree: Token Weather's forecast after the first turn, Blast Radius's Proceed and Cancel while a risky command is held, Replay Theater's hint after a turn with edits. Colors follow Claude Code's terminal palette on this theme's tokens; a hotkey is shown as a hint beside the label, and a press is a click. While a press is in flight every button is disabled; a press the Host refuses shows its message under the band.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The browser entry imports the generated Remote contribution and hands it to `mountModsBand`, which mounts the contribution through `ctx.remote.$mount()` and registers one `conversation.input.dock` entry. The entry's `inject` keeps one `watchBand` stream per session behind a small observable store the slot renderer exposes as `useBand`; `press` calls `pressBand` with the generation the band was drawn in and applies the snapshot it returns. Disposal ends every stream and the Remote mount. [`Band.tsx`](src/client/Band.tsx) renders the serialized tree: `Box` as a flex container with `data-direction`, `data-border`, and padding and gap from the props, `Text` as a span carrying `data-color`, `data-bold`, `data-dim`, `data-italic`, `data-underline`, and `Button` as a button disabled without an action id or while a press runs.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [The bridge](../claude-code-mods/README.md) — how the band is drawn and which mods draw first.
- [Compatibility with Claude Code mods](../../../docs/subsystems/claude-code-mods.md) — the element and prop subset this band renders.

-----

<a id="model-experience"></a>
## Model Experience

None, as the band is drawn from Host state and never enters a model request; a button's effect reaches the model only through the mod's own hooks.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One band per session; no docked `Pane`, `TextInput`, hotkeys, focus, or scrolling. The Host renders for a band 120 columns wide and the band wraps; `width`, `height`, `overflow`, `wrap`, and `truncate` props are ignored.
- The band reflects the Host's redraw triggers; a mod that changes state outside them is drawn at the next trigger.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
