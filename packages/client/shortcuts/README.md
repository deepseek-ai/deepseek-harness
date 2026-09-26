---
description: "Customize application keyboard commands for each device"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-shortcuts

English | [中文](README.zh.md)

## Summary

Customize application keyboard commands for each device. Desktop and Web choose separate defaults for the receiving device. Custom bindings survive reloads on the same device. Commands disappear when their owning plugin unloads, while their saved overrides remain available for reinstallation.

Windows uses ` + ` between modifiers and the first ordinary key. Two simultaneous ordinary keys appear side by side, such as `F G`, on Windows and macOS Desktop, including tooltips and the shortcut reference.

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

The Web app bundle mounts this package automatically. Feature plugins register commands through `ctx.shortcuts` inside `ctx.effect()`. Each command declares defaults for explicit `desktop:macos`, `desktop:windows`, `desktop:linux`, `web:macos`, `web:windows`, and `web:linux` profiles; an omitted profile is unbound. The service accepts physical `code` values, expands `primary` to the device modifier, and rejects duplicate ids and overlapping default combinations across supported profiles. Labels, keycaps, modified flags, and binding conflicts share one observable catalog. Command owners resolve the current target before executing an action.

Feature plugins contribute read-only sequences through `registerFixed()` and observe locally arbitrated input through `observeFixedInput()`. Fixed rows follow the owning registration and locale; owners may use the `application` display group without making the action editable. Each action declares at least one physical combination and has no saved overrides. These combinations participate in conflict checks and cannot be assigned to editable commands. The Host's `stopSequenceMs` setting controls the maximum double-Escape interval, defaults to 500 milliseconds, and accepts integers from 1 to 2,147,483,646 so expiry stays within the browser timer limit; pages adopt the validated value on load.

Preferences store only overrides: a missing command inherits its default, `null` clears its binding, and restoring a default removes its override. Restore All affects only the current runtime/platform profile. Web uses origin-local `dsh.keybindings.v1` storage; Desktop uses Electron's device-local `userData/keybindings.json`, independently of Harness home and workspace settings. The schema version is independent of Session data. macOS and Windows Desktop read version 1 without rewriting it and save version 2 on the next successful edit; version 2 adds optional `secondCode`. Web and Linux retain their existing binding restrictions.

Windows and macOS Desktop accept one or two distinct supported non-modifier keys, with zero to four modifiers. Two-key bindings require overlapping presses in either order; sequential presses do not match. Modifier-only bindings are rejected. A single key and a pair containing that key conflict when their modifiers match, including keys reserved by fixed actions. Previously saved bindings that overlap a mounted fixed action remain visible but cannot execute. All effective bindings, including Command+C and Ctrl+C, take priority over native actions, editors, terminals, embedded pages, and modal controls. Recording and input-method composition remain protected. A pair takes priority only once both keys are held; the first key retains its normal behavior and may insert a character.

Bindings activate after the first read. Failed reads preserve the last accepted configuration, or use defaults when none exists. Edits, including Restore All, remain disabled while preferences are unreadable. Repair the stored document and reopen the application; reset operations never replace unreadable or future-version data. Write failures preserve active bindings and drafts. Another browser tab's update invalidates open drafts; saving requires reviewing the latest configuration. Browser writes reread first, but simultaneous cross-tab writes remain last-writer-wins.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host build emits the Node entry and `./protocol` before Desktop bundles its keyboard integration; the Client pass emits the browser bundle.

Windows and macOS Desktop intercept complete accepted combinations before local handlers and forward them through the trusted preload. Desktop startup requires the native keyboard bridge on every platform. On Windows and macOS, only native input dispatches configurable commands; DOM input continues to feed fixed actions. The adapter intercepts a key release only when it intercepted that key’s initial press. Default and user-saved bindings have identical priority, including over modal controls. Other environments dispatch after local handlers and respect their declared regions. Composition, dead keys, AltGraph, and consumed input pass through; macOS Web can consume a bound Option+Command+N reported as a dead key outside composition without guarding the next input. Web and Linux modal layers block background commands. Owned repeats remain consumed without rerunning the action. The context carries the original DOM input element, including elements inside a shadow root. Owners synchronously resolve their target and retain responsibility for action errors. `ctx.shortcuts.closeWindow()` owns the Desktop keyboard bridge and sends its current accepted revision; Web calls and bridge request failures reject. The pure `./protocol` export has no React, DOM, or Electron dependency and shares validation and serialized persistence between adapters. Explicit overrides displace conflicting new defaults; conflicting explicit overrides are all disabled. Desktop rejects stale revisions and restricts IPC to the current product window and top frame. Rejected adapter calls are logged and returned as save failures; errors while publishing an accepted command catalog propagate to the caller.

DOM fixed-input observers receive composition and consumption flags before application dispatch. Consuming an event makes it unavailable to subsequent observers and commands. Focus, pointer, window blur, composition, modal changes, and locally stopped propagation reset pending DOM sequences. Native chords reset on window blur, focused-frame or configuration changes, composition, recording, and modifier release. Electron can omit keyups after native interception; completing a native binding discards held-key state, so each chord activation needs two fresh presses. Releasing a modifier clears held-key state because macOS may omit character keyup events while Command is held. The adapter removes its listeners and modal observer when disposed; one feature's observer failure does not prevent the remaining observers from receiving input.

Desktop native menus and embedded frames use the same command registry as DOM input. Preload and the client match the focused iframe name or browser webview lease against native input; the client rejects messages from an older configuration. Browser guest input ends when its lease is released, before guest destruction finishes. Native menu selection is explicit and works without a bound accelerator. Two-key chords have no native menu accelerator; their labels remain visible in the shortcut reference. Terminal Ctrl+W/R remains local input outside Windows and macOS Desktop. Explicit native-menu actions retain their modal checks; keyboard bindings use the device dispatch policy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web Client](../../../docs/subsystems/web-client.md)
- [UI primitives](../ui-primitives/README.md)
- [Web app bundle](../../bundle/web-app/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Feature owners declare the Windows and macOS Web defaults explicitly: Mod+Slash, Mod+Comma, Mod+Backslash, and Control+Backquote stay two-key combinations; other defaults without Alt use Mod+Alt, and defaults with Alt use Mod+Shift except fullscreen uses Mod+Alt+Enter. macOS Web leaves Refresh current page unbound by default to preserve browser-specific Command+Option+R actions; its button and explicit user bindings remain available. Mod is Command on macOS and Control on Windows. Windows and macOS accept any three or four distinct modifiers in Web and Desktop. Web also accepts the listed combinations and Mod+Shift combinations; browser or system delivery requires platform testing. Linux Web accepts Mod+Slash, Mod+Shift+Comma, and Mod+Shift+Period. Operating-system shortcuts that do not reach the window cannot be intercepted. A chord does not delay or consume its first key while waiting for the second; a native action or focus change can therefore prevent completion. Command registration or disposal invalidates open edit drafts even when saved preferences are unchanged. Desktop rereads its file on every catalog update; there is no file watcher.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The catalog and binding index are derived together from the private registry; there is no independently maintained runtime relationship to inspect.
