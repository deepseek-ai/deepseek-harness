# Agent Note: Plugin entry customization: region-owned pins and More menus

Status: implemented

English | [中文](2026-10-14-plugin-entry-customization.zh.md)

## Problem

The `release/dsh-0.2.1` Web app shows plugin entries in three regions: the left sidebar's panel buttons (`sidebar.panellist`), the Conversation header's View tabs (`conversation.view`), and the right sidebar guide's tool cards (guide entries from the right-sidebar tab registry). Each region shows every entry in registration order, so users cannot hide entries they rarely use, and every installed plugin makes the regions more crowded. Users also cannot browse more plugins or start creating a plugin from these positions.

The feature ships in `release/dsh-0.2.1` and is later merged back to master with the release, so it changes as little as possible relative to the release: no changes to the slot framework (`ui-slots`, `ui-renderer`), no new Cordis service, `ui-layout` unchanged, and client plugin packages share only types ([Client package export rules](../../../../packages/client/AGENTS.md)). Persisted data must be readable without migration by a later slot-level store for manual order and pin state.

## Decision

Each region keeps and persists its own list of unpinned entries and filters its own entry buttons with it. Each region draws its own More button, opens a menu with the shared `Menu` component, and renders its actions slot inside that menu. The default-loaded plugin package `ui-entry-customization` registers the same menu-content component into the three actions slots: the entry list with pin buttons, Browse other plugins, and Create your plugin. This follows the Plugins page's Add plugin menu, where the page draws the button and menu and `ui-agent-preset` adds Create plugin through `plugins.add.actions`. Entries cannot be reordered.

### User-visible behavior

- The left sidebar, the Conversation header, and the right sidebar guide each have a More button. Its menu lists the region's customizable entries. Selecting an entry name opens the entry; its pin button shows or hides the entry in the region; the bottom of the menu has Browse other plugins (opens the Plugins main list) and Create your plugin (opens a new or reused blank Session with the Creator preset and fills in the region's prompt without sending it).
- Entries appear in registration order, as in the release; they cannot be reordered.
- Default entries always show and never appear in the menu: Plugins in the left sidebar, Chat in the Conversation header, and Files in the right sidebar.
- Pin state survives page reloads and is shared by every Session.
- Hiding the selected entry does not navigate away from its content; the left-sidebar row or View tab of the selected entry stays visible, as the current item, until another entry is selected.
- The left-sidebar `<nav>` and the Conversation header tab bar keep their release visibility conditions: `<nav>` shows while any panel is registered, and the tab bar shows while more than one View is registered. Both conditions count registered entries, not entries left visible by pin state. With only Chat registered the tab bar stays hidden; with other Views registered, the tab bar and its More button stay visible even when every other View is hidden, so users can pin them again.
- While an actions slot has no registrations, for example when `ui-entry-customization` is not loaded, its region shows no More button.

### Structure and ownership

```text
ui-sidebar / ui-conversation / ui-sidebar-right (each region)
  apply: the region's unpinned list (createSnapshotStore + persist) and setPinned
         whether the actions slot has registrations (entriesOfSlot + subscribe)
  root component: draws only fixed or pinned entries
          while the actions slot has registrations, draws the region's More button and Menu:
            <Menu anchor={region's More button} …>
              renderSlot('<region>.actions', { entries, onOpen, onPinnedChange, onDismiss })
            </Menu>

ui-entry-customization (default-loaded)
  registers one menu-content component into each actions slot (id 'entry-customization')
  content: non-fixed entries with pin buttons, Browse other plugins, Create your plugin; keeps no state
```

Dependency direction: the three regions do not depend on the plugin package and only add uses of `client-store` and `ui-primitives` they already depend on. `ui-entry-customization` depends on the three regions (slot types) and on `ui-plugin-manager` and `ui-workspace` (service types), and calls `ctx.pluginNavigation` and `ctx.uiWorkspace` at runtime. No package gains a new runtime value import from another package.

### Package changes relative to release/dsh-0.2.1

| Package | Change |
|---|---|
| `ui-sidebar` | Adds `sidebar.panellist.actions`; apply adds the unpinned list, `setPinned`, and the actions-slot registration state; `SidebarRoot` filters entries and draws the More button and menu at the end of `<nav>`; expanded panel rows use a 2px gap instead of 4px |
| `ui-conversation` | Adds `conversation.session.header.views.actions`; apply adds the same three parts; the Session header filters View tabs and draws the More button and menu inside the tab bar after the tablist; View tabs use a 32px gap instead of 36px, with 20px before More |
| `ui-sidebar-right` | Adds `sidebar.right.tab.guide.actions`; apply adds the same three parts; the guide filters cards and draws the More card and menu after the cards; the guide registration declares the `sidebarRight` locale namespace |
| `ui-entry-customization` (new package) | Registers the menu-content component into the three actions slots; owns the `entryCustomization` locale namespace; keeps no state |
| `ui-plugin-manager` | Adds `openList()` to `pluginNavigation`: selects the Installed tab of the Plugins main list without opening a dialog or changing the current Session |
| `ui-primitives` | Adds `minWidthFromAnchor` to `Menu` so the right-sidebar menu is never narrower than its card; adds `IconAppsAddOutlineRegular` / `IconAppsAddOutlineMedium` (`compact` for card size), shared by the left-sidebar and right-sidebar buttons |
| `@deepseek-ai/dsh-web-app` | Loads `ui-entry-customization` by default |

### Actions slots and menu content

The three actions slots are root-scoped list slots declared by their regions and rendered inside the region's More menu. Other plugins may register menu items into them; items follow their registration `order`. Each region declares the owner props in its own contract (`SidebarPanelActionsOwnerProps`, `ConversationViewActionsOwnerProps`, `SidebarRightGuideActionsOwnerProps`) with the same fields; the left sidebar's type is:

```ts
interface SidebarPanelActionsOwnerProps {
  /** The region's customizable entries in registration order; fixed entries are excluded. */
  readonly entries: readonly { readonly id: string; readonly label: string; readonly pinned: boolean }[]
  /** Open an entry without changing its pin state. */
  readonly onOpen: (id: string) => void
  /** Show (true) or hide (false) an entry. */
  readonly onPinnedChange: (id: string, pinned: boolean) => void
  /** Close the More menu. */
  readonly onDismiss: () => void
}
```

The `ui-entry-customization` menu-content component renders those fields: one row per entry (`EntryPickerRow`, whose name and pin button are separately focusable). Selecting the name calls `onDismiss` and then `onOpen`; the pin button calls `onPinnedChange`. Browse other plugins and Create your plugin follow and call `onDismiss` before acting. Each registration receives its region (used only to choose pin copy and the Creator prompt) and the two footer actions through its registration `inject`. Browse other plugins calls `ctx.pluginNavigation.openList()`; Create your plugin calls `ctx.uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })` with the region's localized prompt. The call does not go through `ui-agent-preset`, so the preset chip plays no introduction animation. When no Creator preset exists, Session creation fails, Workspace shows its creation-failure notice, and no draft is created.

The region decides its More button's styling, accessible name ("More", "More conversation views", and "More tools", from the regions' `panels.more`, `session.moreViews`, and `tab.guide.more` copy), Tooltip, and the menu's placement and width. Every menu uses the `ui-primitives` `Menu` component.

### The three regions

| | Left sidebar (`ui-sidebar`) | Conversation header (`ui-conversation`) | Right sidebar guide (`ui-sidebar-right`) |
|---|---|---|---|
| Entry source | Existing `panels` (from `sidebar.panellist`) | Existing View list (from `conversation.view`; Trajectory is removed while developer tools are off) | Existing tab registry `guide()` |
| Entry id | Panel id | View id | `kind:entryId` |
| Fixed | `plugins` | `chat` | Entries of kind `files` |
| localStorage key | `dsh.slot.manual-order.sidebar.panellist.v1` | `dsh.slot.manual-order.conversation.view.v1` | `dsh.slot.manual-order.sidebar.right.tab.guide.list.v1` |
| Actions slot | `sidebar.panellist.actions` | `conversation.session.header.views.actions` | `sidebar.right.tab.guide.actions` |
| More button | Panel-button styling; shows its label when expanded and a Tooltip when collapsed | Small header button with a Tooltip | Card styling; the menu is at least as wide as the card and aligned to its end |
| `onOpen` | `selectPanel(id)` | The Session's `selectView(id)` | Finds the entry by id, then `openTab(kind, { replaceTab: true })` |

Each region defines its fixed entry in a module constant. The unpinned list is created in apply with client-store's `createSnapshotStore(…, { persist })`, is independent of Sessions, and stores `{ "unpinned": string[] }`. It reaches the region's root component through the inject `hooks.entryPins`; `setPinned` is an inject callback and ignores the fixed entry. Reads accept only an array of strings and treat any other value as an empty list, so corrupted localStorage content cannot break rendering. Ids that are no longer registered stay in `unpinned`, so an entry registered again stays hidden. Whether the actions slot has registrations reaches the root component through `hooks.entryActions`.

Every localStorage key has the form `dsh.slot.manual-order.<list slot key>.v1`, named after the list slot that holds the entries rather than after the region package: the left sidebar and the Conversation header use the existing `sidebar.panellist` and `conversation.view`. The right-sidebar guide entries come from the tab registry and have no list slot in the release, so their key uses the name reserved for one, `sidebar.right.tab.guide.list`. A later slot-level store for the manual order and pin state of a list slot reads these keys and ids directly; saved `unpinned` values need no migration, and fields added later default to empty lists when absent from saved values.

Right-sidebar ids use `kind` instead of `providerId`: when an extension takes over a kind, `providerId` changes while `kind` stays the same, so persisted pin state remains valid after the takeover.

## Alternatives considered

**Keep pin state in a Cordis service (provided by `ui-layout` or the plugin).** A region must read pin state while drawing its own buttons, and a slot only passes data from the region to the plugin, so plugin-held state needs a new public service. A `ui-layout` service would hold state unrelated to layout; a plugin-provided service would require each region to handle the service appearing and disappearing. Region-held state needs only a few lines.

**One pin service per region.** Adds three public services with different signatures, while pin state is used only by its region and that region's menu.

**Add `useSlotEntries` / `useManualOrderedListSlot` to the slot framework.** Requires changing `ui-slots` and `ui-renderer`, makes `ui-renderer` hold user preferences and read and write localStorage, and requires the right sidebar to mirror its guide entries into an internal list slot. Without reordering, each region's pin logic is a few lines, which does not justify changing the framework in a release.

**Drag reordering in the left sidebar.** Only the left sidebar would use it, so the three regions would behave differently; this version does not support reordering.

**Make the popover a Component Factory with the More button as a local slot.** The callers are the three regions and the implementation is the plugin. Declaring the Factory in the plugin package creates a dependency cycle, because the plugin's dependencies `ui-plugin-manager` and `ui-workspace` depend on the regions. Declaring it in `ui-layout` cannot name the plugin's locale namespace, so the declaration would be split across two packages and completed through declaration merging.

**Let the plugin draw the whole More control (button and menu) from region data.** The plugin would copy the three regions' button styles, because CSS Modules cannot be reused across packages, and would need layout state from each region. Button styling carries region-specific behavior and belongs to the region.

**Let the plugin render the region entries.** Left-sidebar icons and right-sidebar cards depend on their regions' child slots, and the plugin cannot reach the region's `renderSlot`; React nodes also cannot be passed as props.

**Stop applying pin state while the plugin is not loaded.** The only benefit is that entries hidden before the plugin was disabled or failed to load would still show. That case requires explicitly disabling a default-loaded plugin; the limitation is accepted and documented in the README.

**Show the tab bar based on entries left visible by pin state.** With other Views registered, hiding all of them would remove the tab bar together with its More button, and users could not pin them again.

**Publish `agentPresetNavigation`, or have `ui-agent-preset` react to `startSession` calls that carry `agentPreset` and play the introduction animation.** The first adds a service only to forward to `startSession`; the second changes the `ui-workspace` and `ui-agent-preset` interfaces, and the introduction animation is not essential to this feature.

**Name localStorage keys after region packages.** A later slot-level store keyed by list slot would have to migrate saved data.

## Verification

- Unit tests for the three regions cover: entry buttons show only fixed or pinned entries; `setPinned` ignores the fixed entry; `setPinned` writes and persists to the region's key; corrupted localStorage content reads as an empty list; ids that are no longer registered are kept; More shows while the actions slot has registrations and passes `entries` without fixed entries and the callbacks, and is absent without registrations; the Conversation header tab bar stays hidden with only Chat and stays visible after every other View is hidden; right-sidebar ids are `kind:entryId`.
- Unit tests for the menu-content component cover: opening an entry, toggling a pin, an empty list showing only the footer actions, the arguments of Browse other plugins and Create your plugin, and removal of the three registrations when the plugin is released.
- The Web e2e `entry-customization.e2e.ts` exercises the left sidebar through the real Web composition: More shows by default, hiding a panel removes its button, the panel still opens from the menu, it stays hidden after a reload, and pinning it again restores the button. Recorded-session Web goldens cover the Conversation header and right-sidebar More buttons; `changed-files-turn.e2e.ts` and `document-preview.e2e.ts` assert that the compact header has no tab bar with only Chat.
- Every changed source file has 100% per-file coverage.

## Consequences

- If a user hides entries and the plugin is later explicitly disabled or fails to load, the hidden entries stay hidden with no menu to restore them; re-enabling the plugin or clearing the region's localStorage key restores them.
- localStorage is isolated by protocol, host, and port, so pin state is not shared after changing the Web port or between Web and Desktop.
- client-store's persist does not validate restored values, so each region validates on read; the validation and the owner props type exist once per region.
- The actions slots sit inside the More menus, so other plugins can add menu items but cannot place arbitrary controls beside the entries.
- The right-sidebar key reserves `sidebar.right.tab.guide.list`; a later list slot for guide entries must use that name for saved pin state to carry over.
- When an extension takes over a kind and uses different guide entry ids, existing pin state does not match the new entries.
- With the plugin loaded by default, Web goldens that record the left navigation, the Conversation header tab bar, or the right sidebar guide include a More button.
