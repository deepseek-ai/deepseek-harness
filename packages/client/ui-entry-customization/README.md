---
description: "Offer plugin browsing and a Creator draft in three navigation regions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-entry-customization

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

Browse plugins and prepare a reviewable Creator draft from the More menus of the left sidebar, Conversation View tabs, and right-sidebar guide. The Web app loads this package by default. Each region draws its own More button; this package stores nothing.

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

Open **More** beneath the left navigation entries, **More conversation views** after the Conversation View tabs, or **More tools** after the right-sidebar guide cards. Left-sidebar and guide menus offer only **Browse other plugins** (when available) and **Create your plugin**. The Conversation menu also lists folded Views before those actions and marks the active View with a check on the right. None of these menus provide pin controls or sorting.

**Browse other plugins** opens the Plugins main list without opening an installation dialog. **Create your plugin** opens a new or reusable blank Session with the Creator preset and adds a short localized request for a plugin in that region to its draft: an empty draft takes the request as its text, and an existing draft keeps its text, references, and attachments with the request appended as a new paragraph. It never sends a message. Review and send the draft yourself. Creation remains available regardless of the region’s entries; a separator appears only between folded Views and the actions, before browsing when available or before creation otherwise.

On Desktop, **Browse other plugins** and **Create your plugin** report `more_menu_item_click` before they act, with `action=browse_plugins` or `action=create_plugin` and the menu's `region`: `sidebar` for **More**, `conversation` for **More conversation views**, and `rightbar` for **More tools**. The menus report no exposure events. Without the analytics service, both actions behave the same and report nothing.

The browse-plugins row appears only while the `pluginNavigation` service is present; the plugin starts without it. Its absence removes only browsing, not More buttons, folded Views, or creation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`apply`](src/client/index.ts) registers [`EntryMenuContent`](src/client/EntryMenuContent.tsx) under id `entry-customization` into `sidebar.panellist.actions`, `conversation.session.header.views.actions`, and `sidebar.right.tab.guide.actions` through `ctx.slots.inject`, so each registration follows its region's declaration lifetime. The regions render these slots inside their own `Menu`; the rows call `onDismiss` before browsing or creating. Only the Conversation menu consumes its owner’s folded entry list and navigation callback; pin callbacks remain unused.

Each registration's `inject` supplies its region and two callbacks. Each callback first calls `ctx.get('productAnalytics')?.track('more_menu_item_click', { region, action })`. Browsing then calls `ctx.get('pluginNavigation')?.openList()`; ui-plugin-manager provides that service only while the Plugins page has access, so this package reads it optionally and never lists it in `inject`. Creation then calls `uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })` with the region's localized prompt; it does not go through `ui-agent-preset`, so the preset chip plays no introduction. The [`dsh-web-app` bundle patch](../../bundle/web-app/cordis.patch.yml) mounts the browser plugin.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package manages browser launchers and prepares an unsent, reviewable draft; only user submission sends its text to the model.

#### KV Cache effect

None; the package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- More menus provide no visibility controls. Region pin callbacks remain available to other registrations and change only in-memory choices; plugin reload restores defaults.
- Legacy pin values in localStorage are neither read nor written.
- **Create your plugin** does not check whether the Creator preset exists. Without it, Session creation fails, the Workspace shows its creation-failure notice, and no draft is prepared. Draft preparation also requires a resolvable Workspace; without one, the existing flow reports that a Workspace is required.
- Conversation owns the estimated tab split; these menus provide no sorting.
- Conversation controls follow the existing nonblank-Session header and Coding Tools eligibility. Right-sidebar controls require a selected Session and appear on its guide page.
- The menus do not list plugins; use the browsing action to open the Plugins page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
