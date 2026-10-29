---
description: "Sidebar shell plugin for the dsh web client: brand row, New Session action, collapse control, scroll-aware region seat, and bottom-pinned Settings seat."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The dsh web client sidebar lets users recognize the active build, start a new session, collapse navigation to a 56px rail, browse Workspaces and Sessions, and open Settings. It preserves a bottom-pinned Settings entry and hides idle scrollbars without moving browser rows. New Session uses an explicitly selected Workspace, then the current Session's Workspace, then the most recently active Workspace; if none exists, it opens a blank New Session page. Deployments can replace the brand mark or name while retaining the navigation controls and rail geometry.

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

The sidebar is the navigation shell: users see the brand, start new sessions, collapse the rail, and reach Settings. Feature plugins fill its seats — ui-workspace fills `sidebar.workspaces`, ui-settings registers the trigger row and settings panel at `sidebar.settings`.

Below 768px, without a native Windows caption, the sidebar keeps its expanded content mounted inside the frame's drawer. The drawer initially focuses its collapse toggle, traps keyboard focus, closes with Escape or a mask press, and restores the invoking control unless a foreground dialog remains open. When an open drawer becomes a collapsed rail, focus remaining in its wide content transfers to the rail toggle before that content unmounts. When a collapsed rail becomes a hidden drawer, the sidebar transfers its own focus to its header opener, preserving focus elsewhere and in foreground dialogs. This includes focus in a global menu identified by the original sidebar control's `aria-controls`. Returning from a closed drawer renders the compact rail immediately, without a crossfade. Its toggle tooltip renders outside the drawer. Opening it does not resize the conversation.

### Brand and New Session

When the sidebar is fully hidden, Web shows only the header's sidebar opener. Desktop hosts that mount this header seat also keep New Session; Windows with a native caption keeps its New Session control in that caption instead.

The expanded brand row renders `sidebar.brand.mark` and `sidebar.brand.name` as independent single slots; the collapsed rail renders the same mark slot. On Web and Windows desktop, clicking the expanded brand starts a new session; hovering or focusing it shows no tooltip. Without occupants, the shell uses the fish mark and a localized local-build label. A complete build stacks a code badge below the label as `version[-commit][-dirty]`, using `DSH_CLIENT_VERSION`, the optional 7-character `DSH_CLIENT_COMMIT_HASH`, and `DSH_CLIENT_GIT_DIRTY=true`; missing version metadata omits the badge. Clicking the fallback mark or label of such a build copies that badge text instead of starting a session, also on macOS desktop, and a successful write shows a Version copied toast. New Session targets the explicit Workspace used by a scoped action, otherwise the current Session's Workspace, otherwise the most recently active Workspace; when none exists it clears into the blank New Session page. The expanded New Session button displays the effective binding as trailing grey text on keyboard focus regardless of hover capability, and on hover when the device supports it. While the shortcut is visible, the centered icon and label fade before it when space is narrow; CSS reserves the shortcut’s width without measuring the button. Icon-only controls retain tooltips with platform-formatted keycaps, including the resident macOS header control when the sidebar is hidden. All controls expose `aria-keyshortcuts`. While the global access snapshot excludes `session/create`, the brand row stays inert and neither the New Session button nor the window-chrome New Session control renders; the Host still decides every create request.

### Global panel entries

Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection. The label supplies plain visible text, the accessible name, and the collapsed tooltip. Expanded navigation rows have a 2px gap. Each row reads its own selected state through `usePanelInfo`; moving DOM focus to search or a directory picker does not change the displayed panel or its selected row. With no panel registrations, neither the list nor spacing for it is rendered. The shipped composition registers no example panel.

While the root-scoped `sidebar.panellist.actions` list has registrations, a **More** button styled as a panel row follows the rows inside the navigation landmark; the collapsed rail shows its label as a tooltip. It opens a menu whose rows are that list's registrations. Each receives `entries` (customizable panels in registration order with `id`, `label`, `pinned`, and `active`; Plugins is never listed), `onOpen(id)`, which selects the panel, `onPinnedChange(id, pinned)`, and `onDismiss()`, which closes the menu. The sidebar keeps one in-memory list of unpinned panel ids shared by every Session; Plugins always shows. The default More menu only offers plugin browsing and creation, without panel rows or pin controls. Pin callbacks remain available to other registrations, but choices reset when the plugin reloads and legacy localStorage values are ignored. Unpinning hides only the row; the main panel, its registration, and the current selection stay unchanged. Unregistered panel ids remain in the in-memory list until the plugin reloads.

### Collapse behavior

The sidebar and conversation-header toggles show the effective shortcut from the command catalog in their hover and keyboard-focus tooltips and `aria-keyshortcuts`. An unbound command shows only the action label.

The top expand button hosts the optional, non-interactive `sidebar.toggle.badge` slot while collapsed. Its occupant supplies status and tooltip content without adding another action or changing the button's navigation behavior.

Expanded content follows the frame's column width, including its transitions. During a live collapse, the content fades out at its frozen expanded width, the upper controls share one fade and leftward translation into the 56px rail, and the layout's column slide ends the motion. A page that starts collapsed renders the rail statically, and reduced-motion mode disables both transitions. The bottom-pinned `sidebar.settings` control shares the fade timing but has no horizontal translation.

On Windows Electron, `html[data-windows-titlebar]` fixes the sidebar toggle in the caption's top-left corner in both states, aligned with New Session's left edge only when expanded. The expanded brand sits below the caption and above New Session, with 8px of extra space above that button. Collapsing hides the brand and sidebar content and places New Session between the sidebar toggle and the Desktop-owned menus. The sidebar sets the root `--dsh-windows-menu-start` to 84px when collapsed; the Desktop preload uses it to position its menu after New Session and defaults to 48px when expanded. Caption icon buttons use centered 16px glyphs in 28px controls with the compact control radius and exclude themselves from the window drag region. The sidebar toggle and New Session bubbles open below the caption, where the Desktop-owned menu text cannot cover them; an occupying `sidebar.toggle.badge` chooses its own bubble side.

### macOS desktop

Under `html[data-platform='darwin']` (set only by the desktop preload) the expanded column opens with a 52px top strip that clears the hiddenInset traffic lights and carries the collapse toggle; the strip and the logo row below each mark themselves `data-window-drag`, so each row's own box is the window's drag region (ui-web base.css declares the one darwin drag rule), and the brand wordmark is not a New Session shortcut there — the dedicated New Session button keeps the action — and collapsing hides the column entirely instead of leaving the rail. The package registers `HeaderLeadingControls` into the frame's `shell.leading` window-chrome seat (ui-layout), which mounts it — the open-sidebar and New Session controls beside the traffic lights — only while the column is hidden, over every main panel. The [Desktop reference](../../../apps/desktop/README.md) owns window integration.

### Scrollbars

Scrollbars in the column are a pointer affordance: the shell rebinds the scrollbar indirection to `transparent` whenever the pointer is outside the column and keeps the thumb drawn for 2s after the pointer leaves, so a list nobody is pointing at carries no bar. The reservation that keeps rows from moving belongs to the scrolling region (ui-workspace), so revealing a thumb never reflows.

### Click analytics

On Desktop, the official navigation controls report `sidebar_menu_click` with `menu_name` and `position` before they act. Without the analytics service, the controls only navigate. Selecting a panel by other means reports nothing, and the sidebar reports no exposure events.

- The expanded brand and the New Session button report `menu_name=new_session` with `position=sidebar`. While the Windows caption hosts the collapsed New Session button, that button reports `position=titlebar`; the macOS New Session control beside the traffic lights also reports `position=titlebar`.
- The **Plugins** and **Automation tasks** rows report `menu_name=plugin` and `menu_name=cron` with `position=sidebar`. Other panel rows report nothing.
- Each **More** button click reports `menu_name=more` with `position=sidebar`, whether it opens or closes the menu.
- A third-party More menu row that calls `onOpen(id)` for Plugins or Automation tasks reports `menu_name=plugin` or `menu_name=cron` with `position=sidebar_more`. The shipped More menu only browses and creates plugins, so it never calls `onOpen`. The report precedes the registration check, so a request for a panel that has unregistered still counts although nothing is selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The shell is pure composition: `SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared brand, the `sidebar.workspaces` and `sidebar.settings` child slots, and injected navigation callbacks. The sidebar owns `sidebar.panellist` and renders each panel's registered icon directly. Panel metadata is derived from list registrations and locale changes; selection belongs to the layout store. The injected `trackEntryClick(attributes)` forwards to `ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes)`, and `selectPanel` only selects, so each control supplies its own entry and position.

Expanded navigation uses 8px outer gutters, hover and selected fills inset 3px on each side, and a 16px leading cell with a 6px label gap. New Session centers its content with 4px side margins and a 10px bottom margin. The logo row has no bottom margin; its content starts 16px from the column's left edge, with 5px between mark and name. Only the macOS non-fullscreen top toggle shifts 4px right while expanded, retaining that offset throughout its fade-out. Collapsed geometry stays independent.

The sidebar root supplies inherited CSS properties to `sidebar.workspaces` and `sidebar.settings`: `--dsh-sidebar-inline-padding: 8px`, `--dsh-sidebar-row-padding: 12px`, `--dsh-sidebar-label-gap: 6px`, and `--dsh-sidebar-paint-inset: 3px`. Occupants consume these values for expanded row alignment; standalone compositions must provide them on an ancestor. The paint inset reduces the fill without moving content: rows subtract it from their inline padding and use it as a transparent border.

### Slot discipline

Declaration-aware `slots.inject()` lets a replacing package activate before or after the sidebar. The foot is the `sidebar.settings` seat: the sidebar renders only the bottom-pinned layout slot and shares its column state (`wide`). The `/client` exports are the plugin body (`apply`/`inject`) plus the contract types only; SidebarRoot, the row components, and the tree derivation remain package-internal behind the slot registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the surfaces that fill the shell's seats and the composition model.

- [ui-workspace](../ui-workspace/README.md) — the Workspace and Session browser rendered into `sidebar.workspaces`.
- [ui-settings](../ui-settings/README.md) — the settings domain base registering the trigger row at `sidebar.settings`.
- [ui-layout](../ui-layout/README.md) — the layout owner whose rail and column state the collapse uses.
- [ui-theme](../ui-theme/README.md) — the scrollbar token indirection the shell rebinds.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the seats.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the shell owns versus what its occupants own; they are current package constraints.

- **Session state-dot rendering is owned by ui-workspace** — no done/error notification sources are available to this shell.
- **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to ui-workspace, not this shell.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
- **Copying the local-build version is mouse-only** — keyboard activation of the brand starts a session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
