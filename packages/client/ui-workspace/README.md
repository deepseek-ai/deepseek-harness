---
description: "Shared Workspace browser and picker plugin for the dsh web client: grouped or flat session rows, management actions, the slot-composed Session row actions, and directory picking."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

This package lets users browse grouped or flat Session lists, choose a Workspace for a new Session, and manage Workspaces and Sessions through add, rename, reorder, search, fork, archive, and Workspace deletion; the Session row menu and its hover buttons are slot lists that client plugins extend. Pending interactions appear as warning dots, and subagent-origin Sessions remain hidden. An idle, unarchived Session row with active scheduled tasks shows a clock mark, and its hover card lists those tasks. Canonically distinct folder paths remain separate Workspaces. Adding a Workspace requires a composed directory picker; without one, adding is unavailable.

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

Use the sidebar to browse Workspaces and their Sessions, reorder them, and start new ones; use the picker in the Session Intent hero to choose a Workspace for a new session. An open Workspace shows five idle, non-blank Sessions by default. Running Sessions, including parents with running children, remain visible in their ordered positions without using that quota; the selected blank **New Session** is also an extra row until its first prompt. Each **Show more** click reveals up to five more idle Sessions; after the final batch, **Show less** restores the initial rows while keeping running Sessions visible. Closing and reopening the Workspace also restores this folded projection.

History rows without a stored title use the localized unnamed label (未命名 / Untitled), rather than a directory name. The current blank row remains New Session; other blank rows remain hidden. Rename drafts use the stored title, or start empty when unnamed; unnamed rows do not offer title copying.

### Reordering and view options

Pinned Sessions lead ordinary Sessions in both grouped and flat views. **Last updated** sorts each partition strictly by the latest user prompt or steer time, newest first; pin time does not affect it. **Manual** uses the relative positions in one complete Session sequence, including hidden archives. Returning to Last updated discards the manual layout, and entering Manual again freezes the then-current chronological order. The browser defaults to Last updated and remembers the selected mode across reloads.

Pinning moves the Session to the front of its complete saved sequence without changing the selected mode. It leads the pinned partition in Manual but need not lead it in Last updated. Unpinning leaves the saved position unchanged. Dragging either a pinned or ordinary row edits that same complete sequence and selects Manual; hidden archived members are retained. Missing pinned members prepend in pin-array order. New ordinary forks precede their sources in the complete sequence without inheriting pin membership; visible pins still lead ordinary rows. Other missing members append by recency with missing archives last. Supplementation stays in memory until a Session-order write records the complete result. Archive filtering alone changes neither saved positions nor account membership.

The selected blank **New Session** retains its provisional first slot and cannot be dragged; after its first prompt it becomes an ordinary draggable row, retaining that position in Manual or following its current timestamp in Last updated. A collapsed-group drag uses the target Session identity and keeps the source visible. Session display orders for real Workspaces, Ungrouped, and the flat list are browser-local; Workspace group drag order remains Host-durable.

### Workspace hierarchy

Choose **Add workspace** and select a directory to register it and open a Session. **View options → Group by** defaults to **WorkSpace**, which lists Workspaces as sibling sections. Select **Workspace Tree** to nest each Workspace under its nearest registered ancestor, including Workspaces added later. Each Workspace keeps its own Sessions and row actions. Child Workspaces appear before the parent's own Sessions. Ancestors start expanded unless a saved collapsed state exists. A saved collapse also hides the current Session; ancestor folder icons stay highlighted when a descendant Workspace contains it. Row fills and hit targets span the same width at every level; only the contents indent. Workspace dragging reorders siblings; dropping on a descendant targets the nearest compatible ancestor, so an expanded parent can be moved past without collapsing it. Search-result navigation expands every ancestor. Grouping and expansion are saved in the current browser; switching modes preserves each Workspace's expansion preference, and the single-list view stays flat.

Hierarchy uses registered canonical paths only. It does not scan for projects or resolve symlink aliases. Nesting does not change Session working directories, logs, or Workspace membership. Deleting a parent Workspace leaves its child Workspaces registered and places them under their next registered ancestor, or at the root.

### Search

Collapsed search is one header action beside the view and add actions: activating it expands the field across the header. A non-blank query replaces either browsing mode with one flat result list — case-insensitive title and Workspace substring matches appear immediately, while a 250 ms debounced Host request adds ranked current-conversation content matches and snippets. Each new query aborts the preceding request; a failed content search leaves metadata matches visible without an additional warning. The list is capped at 20. Choosing an unarchived result clears and collapses search, opens the Session, and scrolls its row into view in the configured browsing mode; grouped browsing also expands its Workspace and the full Session list when required. Archived results offer Unarchive; attempting to open one explains that restriction without clearing the query or navigating.

### Managing sessions

The Session row's Rename action opens a dialog prefilled with the row's display title; confirming an unchanged title is deliberately allowed — it pins the current automatic title against regeneration. Double-clicking a title also opens Rename; for an unarchived Session, the preceding clicks open its conversation. Rename uses a temporary `workspaceOperation` reference and awaits its initial history opening. The row's Fork action reads ordinary cold history normally. When the Host reports that source migration is required, an app-wide Toast offers to open that Session; the action only navigates and does not retry fork. A successful fork uses the source's last completed turn and increments the inherited persisted title through Session Controller without retaining the child, opening its history, or changing selection. Workspace Delete opens a confirmation that states the retention boundary; success removes the group while its Sessions remain under Ungrouped. Pin, Rename, Fork, and Archive are themselves entries of the `sidebar.workspaces.session.menu.item` list (pin and archive also of `sidebar.workspaces.session.row.action`), so a client plugin's action takes whatever position its `order` gives it.

Archive commits without a confirmation dialog for a quiet Session and retains the Session's account position. A Session with running work is the one case that asks first: the Host refuses the plain archive and names that work, and the sidebar opens a stop-and-archive dialog listing it by family — the turn in progress, running subagents, background jobs, scheduled reminders, each with its labels — with the restore path stated; confirming asks the Host to stop the work the way the stop button does and archives once the archive set is durable, while the stops settle in the background, and cancelling leaves the Session running and visible. View options control visibility through one explicit three-way choice: Hide archived (the default) hides archived Sessions, All conversations (show archived) includes them, and Archived only hides ordinary Sessions and drops Workspaces without an archived Session; in tree grouping, children of a dropped Workspace nest under the nearest shown ancestor. Visible archived rows are grayed and carry an accessible explanation that they cannot be opened until restored; Rename, Fork, and Unarchive remain available. A successful archive shows a notice with an undo action and — while archived rows are hidden — a "filter archived sessions" action that switches the filter to All conversations (show archived); a stop-and-archive shows the same notice under its own wording, and undo restores the Session without resuming the stopped work. Unarchive removes the archive mark without restoring a pin or changing the saved position. An empty list shows a centered glyph-over-text placeholder; the Archived-only view names its own emptiness (No archived sessions yet) and adds a View other sessions text action that switches the filter back to Hide archived.

Session update times use the tertiary label color, including on archived rows. A Session title wider than its row is clipped with an ellipsis at rest. Hovering the row scrolls the title to its far edge — the incremented title of a fork, for example — and reveals it without the ellipsis; leaving the row returns the title to its start.

The keyboard reference exposes New Session, Search sessions, Add workspace, Rename session, Fork session, and Archive session. Desktop defaults use the platform's primary modifier, with Mod+K for search; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves these commands unbound until configured. Button tooltips and Session row menus display the effective bindings. Clicking a menu item targets that row; pressing its shortcut targets the main Session. Desktop and Windows/macOS Web rename use Mod+Alt+G, leaving Mod+Shift+R to browser reload. Rename requires a nonblank main Conversation with no modal obscuring it; a retained Session behind another main panel is unavailable. Other Windows and macOS Desktop bindings also execute from terminal input and modal dialogs; other environments follow the command's region and modal restrictions. Search and rename requests belong to this package; input drafts remain in the browser. The directory picker rejects another open while selection or Workspace adoption is pending. Fork captures the retained main-view Session, for which navigation has requested history opening, and keeps automatic migration. It uses the row action's Host operation to select its last completed turn, without loading older Client history. Missing or blank Sessions are unavailable; the Host rejects a source with no completed turn. A rejected shortcut fork preserves the current selection, displays a localized notification, and can be retried; unexpected failures also retain diagnostic logging.

### Pending interactions

Session rows render the runtime's live `pendingInteraction` classification: approvals report **Waiting for approval**, plan reviews report **Plan awaiting review**, and ordinary questions report **Waiting for answer**. While an interaction is pending, the row uses the shared warning dot and replaces its trailing update time with **Approval**, **Plan review**, or **Answer**; the full status and relative time remain in hover details. Pending interaction takes precedence over the shared ongoing loader; a finished-but-unviewed Session uses done, while idle remains dot-free in the row and uses the shared idle dot in its hover details. The leading seat renders only while the row's primary status is idle — no pending interaction, no own or descendant activity, and no unviewed completion — so an occupant there never appears beside the row's own status dot. An archived row keeps that cell blank: it shows neither a status dot nor the seat, and its live status appears on the hover card only.

### Active Schedule markers

Grouped and flat Session rows show a clock mark when the Session has active scheduled tasks. It is an occupant of the row's `sidebar.session.row.leading` seat, so it renders only on a row whose primary status is idle and never beside the row's own status dot; an archived row keeps that cell blank, and a search result has no leading seat and shows no mark. It is not a button, has no tab stop, and a press on its area does not open the row. The mark's own read and the meaning of its active-task condition belong to [ui-schedule](../ui-schedule/README.md).

-----

`ctx.uiWorkspace.openSession(target)` synchronously replaces the owned `mainView` reference and returns the main area to Conversation without waiting for `reference.ready`, so history loading renders inside the selected Session view. The target may be a known Session id or a durable direct-parent subagent address; an explicit address does not require a preloaded parent catalog. `openWorkspace(id, beforeOpen?)` opens a Workspace blank only if no later navigation has superseded the request; an explicit New Session creates a fresh Session. `forkSession(id)` creates the child without navigating or superseding a pending navigation. The optional synchronous preparation callback runs after the target is retained and only for a current Workspace request, so superseded requests do not move composer drafts. Navigation or owner disposal suppresses the late UI commit, not the underlying Session creation. Startup restoration retains its main reference without changing the selected panel or cancelling a later navigation. Archiving the main Session releases its reference and clears the main selection. Selection failure leaves a global panel visible. Session rows read `usePanelInfo` to suppress their selected appearance while a global panel is active; search and directory-picker focus alone do not leave that panel.

Navigation and startup restoration obtain the selected Session's projections from its `follow`; neither issues a separate projection refresh for that Session or its parent.

Workspace reopening and explicit draft preparation try to acquire the first eligible blank in catalog order; startup restoration tries the saved blank. If that writer is held, navigation creates a new Session without trying other blanks. Other acquisition failures abort the request: an explicit New Session or hero Workspace pick shows the failure as a transient notice quoting the Host's code and message (for example a preset that fails to mount) or, for a failure that is not a Host refusal, that failure's own message; a request a later navigation or owner disposal superseded raises no notice, and startup restoration reports only to the console. Released blanks retain their slash-command state when reused. Later navigation cancels a pending startup selection.

Once both Workspace and Session startup baselines are ready, an empty installation calls `workspaces.initializeDefault` and creates or reuses its blank Session. The composer becomes editable when that Session is selected; no message is submitted automatically. Later navigation or owner disposal prevents startup from selecting its result. Ineligible first use leaves the folder picker available without an error. Default Workspace creation failure shows a transient notice directing the user to Choose workspace, and is not retried until the next startup. Session creation failures use the ordinary restoration error handling. The registered Workspace remains available if Session creation or later submission fails.

The first-use directory name and its stored title are fixed, so neither follows the reader's language: `workspaces.initializeDefault` carries no names, and one installation keeps one on-disk path and one stored title across language switches. A Workspace still carrying that automatic title is labeled with the localized default name wherever this package shows it — sidebar rows and their hover card, search result meta, the hero picker menu, and the rename and delete dialogs — through the controller's `workspaceDisplayTitle`. The rename dialog is seeded with the label on screen while the stored title decides whether confirming saves, so confirming the untouched prefill on such a Workspace pins that name and the row stops following the language; the duplicate-title check excludes the target by Workspace identity rather than by title.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one composition: both target slots are declared by other plugins, so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored.

The browser entry also declares two root-scoped `list` child seats on each Session row: `sidebar.session.row.leading`, rendered only while that row's primary status is idle and left blank on an archived row, and `sidebar.session.row.hover`, mounted only while that row's hover card is open. Both take the row's Session identity and nothing else, so an occupant reads its own data by that id; a Session-scoped seat would force a Session binding, which would activate and retain every listed Session.

Client callers can pass `prompt` and `clearPreviousDraft` in the second argument to `uiWorkspace.startSession`. A prompt is plain text; structured drafts are handled internally during restoration and Workspace transfer. Without clearing, existing text or attachments are preserved; explicit clearing replaces only the target Session's text and inline references, leaving attachments intact. Option values are captured before asynchronous creation and applied to the exact retained binding before navigation commits. Superseded navigation does not write content; a submission-blocked input refuses preparation and keeps the previous selection. Calls without options create a fresh Session using the current Agent preset definition. Workspace reconnection and explicit draft preparation may reuse an existing blank Session. The [draft initialization decision](../../../.agents/notes/implemented/architecture/2026-09-30-structured-draft-initialization.md) describes the input owner's data flow.

### The directory-flow hole

Each registration declares a **directory-flow child hole** (`single` kind: `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`) that the composed picker package's client half fills with its picking interaction — the `-native` backend's renderless OS-chooser driver, an in-app browsing dialog under a `-browse` composition. The flat **Add workspace...** action renders only while the surface's hole is occupied; an empty hole means the composition has no picking affordance. The sidebar Add workspace action preserves an existing blank Session and its draft. This package owns the trigger and the adoption: the occupant reports one picked path per open through the hole's owner conversation (`open`/`busy`/`onPicked`/`onCancel`/`onError`), and the owner adopts it through the object layer, selecting the committed Workspace only after its list projection has refreshed.

### Session row actions

The Session row's "..." menu and its hover buttons are two `list` slots declared by the WorkspaceBrowser entry: `sidebar.workspaces.session.menu.item` and `sidebar.workspaces.session.row.action`. Every menu row and every hover button is an entry, this package's own actions included: `apply` registers `pin` (menu 100, button 200), `rename` (200), `fork` (300), and `archive` (menu 400, button 100) the way a client plugin registers its actions, so a plugin action lands wherever its `order` says, and reusing a shipped id at another `priority` shadows that action.

An entry receives only the row identity (`sessionId`, `displayTitle`) and owns everything else. It reads the Host state it cares about through its own injected hooks (the pin and archive sets, as Sets derived once per Workspace snapshot), decides its own visibility (pin renders nothing on an archived row, because the Host keeps the two sets exclusive), carries its whole behavior in its registration's `inject` face (a pin also fronts the Session in its saved orders; an archive raises the notice), and raises its own surfaces: the rename dialog, the stop-and-archive dialog, and the row-action notice are this package's `shell.overlay` entries, fed by the requests the actions inject. A menu entry renders one `role="menuitem"` button (this package's rows use `MenuItemButton` from ui-primitives, which adds the host styling and `separatorBefore` for a group start; the hairline comes and goes with the row) and dismisses the menu through the slot-level `useMenuOpenState` hook, the menu's own open state bound from the row's render occurrence; a hover button entry renders one icon button, and the strip keeps its clicks from opening the row. The browser passes no action callbacks to its rows; its remaining verbs are the search results' restore button and the title double-click, which raises the same rename request.

#### Packaged client plugin

Declare `ui-workspace`, `ui-slots`, `ui-renderer`, `client-locale`, and `ui-primitives` as browser/type development dependencies according to the Client dependency policy. The type-only `ui-workspace/client` import loads this package's `SlotMap` declaration; without it, an independently compiled plugin does not know the slot keys. Keep the Component at module scope and own visible copy in the contributing package's locale namespace.

```tsx
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, LocaleDictOf, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { exportSession } from './export-session.ts'

const NS = 'acme.sessionActions'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'acme.sessionActions': 'export'
  }
}

const en: LocaleDictOf<typeof NS> = { export: 'Export {title}' }
const zh: LocaleDictOf<typeof NS> = { export: '导出 {title}' }

interface ExportRowInjected {
  exportSession: (sessionId: SessionId) => void
}

type ExportRowProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ExportRowInjected>

function ExportRow({ sessionId, displayTitle, useMenuOpenState, exportSession, t }: ExportRowProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore onSelect={() => { setMenuOpen(false); exportSession(sessionId) }}>
      {t('export', { title: displayTitle })}
    </MenuItemButton>
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'acme-session-actions: dictionaries')

  // Order 500 places the row after the shipped Archive (400); `separatorBefore` opens the plugin group.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'acme.export-session',
    order: 500,
    locale: NS,
    inject: (): ExportRowInjected => ({ exportSession }),
  }, ExportRow))
}
```

`ctx.slots.inject()` is required even if the owner is normally present: it waits for the declaration, removes the contribution when that declaration collapses, and registers it again after restoration. The registration's `inject` factory may close over the plugin's declared Cordis services; the Component receives only the projected data and callbacks. A hover button registers into `sidebar.workspaces.session.row.action` the same way and renders one icon button.

#### Dynamic client package

A dynamically loaded browser half follows the same component contract; which modules it can reach depends on its lane. A Module Loader package (`factory(require)`, as in the real Loader/Web fixture) gets `@deepseek-ai/dsh-client-ui-primitives` as an implicit baseline external: resolve `MenuItemButton` through the loader's `require`, do not list the primitive as a runtime dependency or bundle another copy, and declare a development dependency only when source compilation needs its types. A `cordis-client-runner` closure (the audience of the generated Client Slot catalog) cannot import anything: it renders its own `role="menuitem"` `<button>` with `React.createElement`, styles it through `styles.insert`, and dismisses the menu through the same `useMenuOpenState` hook, as the catalog's example shows.

### View state

Once the Workspace baseline is ready, browser-persisted expansion and Session-order records retain only current Workspace ids plus Ungrouped and the flat-list account. `WorkspaceView.sessionIds` supplies real-Workspace membership, not Session display order. View actions receive complete account orders, never filtered rows. A new member without a Session summary waits for that summary, while a saved position survives a temporarily missing summary. Archive visibility is applied only when deriving rows. Pin and drag writes save complete orders; ordinary derivation does not write them. The selected blank Session remains an explicit position write, including during Workspace reconnection, when other saved members are retained until the baseline establishes membership. Ordering remains mounted while the sidebar is a rail or search replaces its body. Last updated derives from current summaries without reading saved positions; equal timestamps use Session ids as a stable tie-break.

The sidebar hides durable summaries with `origin: 'subagent'`. A visible ordinary row shows the shared ongoing loader from running direct children in its loaded parent catalog, never from summary lineage. Child activity uses the latest UI status, falling back to the Session summary until that status is known.

Row motion belongs to [AnimatedRows](src/client/rows/AnimatedRows.tsx). It measures keyed rows before and after React commits that change their membership or order, and uses native movement and opacity animations. Removed rows fade as inert copies outside the scrolling list; they do not delay React unmounting or extend its scroll range. Initial loading, drag commits, overflow expansion, and view-option changes settle immediately. The animator has no layout observers or polling and does not measure content-only updates or scrolling.

### Hover cards

Workspace and Session hover cards copy the value their row clips: activating a Workspace card writes its full directory path, while activating a non-blank Session card writes its full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder rather than session content. A Session card also renders its `sidebar.session.row.hover` seat between the relative time and the trailing status lines whenever the card is open, independent of the row's own state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sidebar host, the hero surface, and the picking backends.

- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell hosting the `sidebar.workspaces` hole.
- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the Session Intent hero's picker hole.
- [directory-picker-native](../../host/directory-picker-native/README.md) — the OS-chooser backend filling the directory-flow hole.
- [Workspace Controller](../../api/workspace-controller/README.md) — the Host mutations and framework-neutral Client projection that own Workspaces, membership, and Workspace group order.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the search depth, the archive surface, and the picking carrier; they are current package constraints.

- **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
- **No Session deletion** — sessions can be archived but never deleted; archived rows stay recoverable in place through the archived view filter and the search results' unarchive action, and Workspace registration deletion does not delete Sessions.
- **Pending user interaction is not aggregated into collapsed groups** — a waiting row inside a collapsed group lights no group-header indicator and becomes visible only after that group is expanded.
- **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; remote-capable picking is the `-browse` composition's in-app flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
