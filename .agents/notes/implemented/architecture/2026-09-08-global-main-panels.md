# Agent Note: Global main panels without default UI additions

Status: implemented

English | [中文](2026-09-08-global-main-panels.zh.md)

## Problem

Plugins need application-wide views that do not belong to a Session. A Session-scoped Conversation view cannot provide that lifetime, and replacing the Conversation's single slot removes the ordinary conversation surface. Adding this extension must not add navigation controls or reserved space to the default application.

## Decision

The layout declares a root-scoped keyed `main` slot. The reserved `conversation` key belongs to Conversation. `ui-session` derives the root Session binding from `uiWorkspace`'s `mainView` ownership marker; `main.conversation` and its associated right Sidebar inherit that Provider binding. Other main entries receive no implicit Session binding. [Client Session references](2026-09-15-client-session-references.md) owns acquisition and source metadata; this note owns global panel selection.

The sidebar owns the root-scoped `sidebar.panellist` list. Each list entry supplies its icon and an id matching its main entry; its string or locale-aware label provides plain visible text, the accessible name, and the collapsed tooltip. The shipped composition registered no panel entry when this landed, so an empty list has no DOM or spacing; the web bundle's plugin manager now registers the first one ([plugin management moves to the Web sidebar](2026-09-09-plugin-management-in-the-web-sidebar.md)). Selection validates the live main entry and rejects a missing key without replacing the current panel.

One eagerly created root store is shared by the renderer and layout controller. Its `panelInfo` and `layoutInfo` objects preserve independent references. The framework supplies `usePanelInfo`; individual rows and main content subscribe to their required selection values, while AppFrame reads only layout information. The right Sidebar's root controller decides whether to mount its Session subtree and reports the resulting track requirements to the frame.

`uiWorkspace.openSession(target)` acquires the explicit target before replacing its main reference and returning the main area to Conversation. `openWorkspace` and `forkSession` keep the layout's existing `beginNavigation()` signal and service lifetime. `openWorkspace` runs its existing synchronous preparation after acquisition and before replacing the main reference. Supersession prevents a late UI commit, not Session creation. Direct Session opening adds no global navigation cancellation. Panel navigation neither releases the retained main Session nor writes a Session event.

DOM focus is not navigation selection. Search and directory-picker controls can receive focus while the global panel and its selected sidebar row remain visible; opening a Session changes the main selection.

## Alternatives considered

**Session-scoped main views.** Their lifetime and standard props bind application-wide state to whichever Session happens to be current.

**A second navigation stack.** Back buttons and saved return destinations are unnecessary when New Session and workspace Session rows already provide explicit destinations.

**React title slots.** Navigation entries use the same plain label for visible text and accessibility; a separate title registration is outside that presentation.

**Flat selection and layout state with shallow comparison.** Separating the two stored objects preserves reference equality directly and avoids allocating and comparing a fresh layout projection on every panel selection.

## Consequences

The default sidebar snapshots remain unchanged. Extension panels have no right Sidebar, and selecting a different global panel does not change layout preferences. Switching between a Conversation with a visible right Sidebar and a global panel still changes the required column widths; this is not a promise of zero browser layout work.

Panel selection is transient and resets on reload. Plugin disposal removes its contributions; removing the selected main entry returns the main area to the Conversation. Tests register real temporary panels and cover row interaction, focus, independent stored references, invalid ids, superseded asynchronous navigation, declaration lifetimes, and the empty default sidebar. The [Slots reference](../../../../docs/subsystems/slots.md) owns the composition API.
