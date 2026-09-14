# Agent Note: Global main panels without default UI additions

Status: implemented

English | [中文](2026-09-08-global-main-panels.zh.md)

## Problem

Plugins need application-wide views that do not belong to a Session. A Session-scoped Conversation view cannot provide that lifetime, and replacing the Conversation's single slot removes the ordinary conversation surface. Adding this extension must not add navigation controls or reserved space to the default application.

## Decision

The layout declares a root-scoped keyed `main` slot. The reserved `conversation` key belongs to the Conversation plugin, whose `main.conversation` child retains optional-Session binding. Other main entries receive no implicit Session binding.

The sidebar owns the root-scoped `sidebar.panellist` list. Each list entry supplies its icon and an id matching its main entry; its string or locale-aware label provides plain visible text, the accessible name, and the collapsed tooltip. The shipped composition registers no panel entry, so the empty list has no DOM or spacing. Selection validates the live main entry and rejects a missing key without replacing the current panel.

One eagerly created root store is shared by the renderer and layout controller. Its `panelInfo` and `layoutInfo` objects preserve independent references. The framework supplies `usePanelInfo`; individual rows and main content subscribe to their required selection values, while AppFrame reads only layout information. The right Sidebar's root controller decides whether to mount its Session subtree and reports the resulting track requirements to the frame.

`uiWorkspace.openSession(id)` selects the Session before returning the main area to the Conversation, including when the same Session is selected again. `openWorkspace` and `forkSession` use the layout's `beginNavigation()` abort signal and their own service lifetime to commit only the latest navigation. The Workspace preparation callback moves drafts synchronously only while the request remains current. Supersession prevents a late UI commit, not Session creation. Panel navigation neither cancels the retained Session nor writes a Session event.

DOM focus is not navigation selection. Search and directory-picker controls can receive focus while the global panel and its selected sidebar row remain visible; opening a Session changes the main selection.

## Alternatives considered

**Session-scoped main views.** Their lifetime and standard props bind application-wide state to whichever Session happens to be current.

**A second navigation stack.** Back buttons and saved return destinations are unnecessary when New Session and workspace Session rows already provide explicit destinations.

**React title slots.** Navigation entries use the same plain label for visible text and accessibility; a separate title registration is outside that presentation.

**Flat selection and layout state with shallow comparison.** Separating the two stored objects preserves reference equality directly and avoids allocating and comparing a fresh layout projection on every panel selection.

## Consequences

The default sidebar snapshots remain unchanged. Extension panels have no right Sidebar, and selecting a different global panel does not change layout preferences. Switching between a Conversation with a visible right Sidebar and a global panel still changes the required column widths; this is not a promise of zero browser layout work.

Panel selection is transient and resets on reload. Plugin disposal removes its contributions; removing the selected main entry returns the main area to the Conversation. Tests register real temporary panels and cover row interaction, focus, independent stored references, invalid ids, superseded asynchronous navigation, declaration lifetimes, and the empty default sidebar. The [Slots reference](../../../../docs/subsystems/slots.md) owns the composition API.
