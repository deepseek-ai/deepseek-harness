---
description: "Fill the More menus of three navigation regions with pin controls, plugin browsing, and a Creator draft."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-entry-customization

English | [中文](README.zh.md)

## Summary

Fill the More menus of the left sidebar, Conversation View tabs, and right-sidebar guide with each region's customizable entries, pin buttons, plugin browsing, and a reviewable Creator draft. The Web app loads it by default. Each region draws its own More button and stores its own pin choices; this package stores nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `@deepseek-ai/dsh-web-app` bundle loads this package by default; it needs no Plugins switch or profile selection. A region shows its More button only while its actions slot has a registration, so unloading this package removes all three buttons.

Open **More** beneath the left navigation entries, **More conversation views** after the Conversation View tabs, or **More tools** after the right-sidebar guide cards. Each menu lists the region's customizable entries in registration order; Plugins, Chat, and Workspace files always show and are not listed. Selecting an entry's name closes the menu and opens the entry without changing its pin state. The separate pin button pins or unpins the region's launcher and keeps the menu open; a filled pin marks a pinned entry. Unpinned entries stay reachable through the menu, and pin choices persist across reloads. Long entry names wrap, except in the More tools menu, where they truncate to one line.

**Browse other plugins** opens the Plugins main list without opening an installation dialog. **Create your plugin** opens a new or reusable blank Session with the Creator preset and adds a short localized request for a plugin in that region to its draft: an empty draft takes the request as its text, and an existing draft keeps its text, references, and attachments with the request appended as a new paragraph. It never sends a message. Review and send the draft yourself. Both actions remain available when a region has no customizable entries; an empty list adds no separator.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`apply`](src/client/index.ts) registers [`EntryMenuContent`](src/client/EntryMenuContent.tsx) under id `entry-customization` into `sidebar.panellist.actions`, `conversation.session.header.views.actions`, and `sidebar.right.tab.guide.actions` through `ctx.slots.inject`, so each registration follows its region's declaration lifetime. The regions render these slots inside their own `Menu` and supply the entries, their pin state, `onOpen`, `onPinnedChange`, and `onDismiss` as owner props. The rows call `onDismiss` before opening an entry or running a footer action; pin changes leave the menu open.

Each registration's `inject` supplies its region and two callbacks. Browsing calls `pluginNavigation.openList()`. Creation calls `uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })` with the region's localized prompt; it does not go through `ui-agent-preset`, so the preset chip plays no introduction. The [`dsh-web-app` bundle patch](../../bundle/web-app/cordis.patch.yml) mounts the browser plugin.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package manages browser launchers and prepares an unsent, reviewable draft; only user submission sends its text to the model.

#### KV Cache effect

None; the package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- If this package is disabled or fails to load after entries were unpinned, those launchers stay hidden and no More menu can restore them. Re-enable the package or clear the region's `dsh.slot.manual-order.*.v1` localStorage key.
- Pin choices live in browser localStorage, which is isolated by protocol, host, and port: changing the Web port or switching between Web and Desktop does not carry them over, and they do not sync across devices.
- **Create your plugin** does not check whether the Creator preset exists. Without it, Session creation fails, the Workspace shows its creation-failure notice, and no draft is prepared. Draft preparation also requires a resolvable Workspace; without one, the existing flow reports that a Workspace is required.
- Entries keep registration order; the menus offer no reordering, and entries cannot move between regions.
- Conversation controls follow the existing nonblank-Session header and Coding Tools eligibility. Right-sidebar controls require a selected Session and appear on its guide page.
- Only active registered launchers appear; the menus are not an inventory of disabled or uninstalled plugins.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
