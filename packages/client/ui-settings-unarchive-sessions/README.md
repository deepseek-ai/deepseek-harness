---
description: "Archived-session Settings page for the dsh web client: the registry-global archive set as a searchable list with one Unarchive action per row."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-unarchive-sessions

English | [中文](README.zh.md)

## Summary

The **Archived sessions** Settings page is the restore point for sessions hidden from Workspace navigation. It lists each archived session with the Workspace that owns it and its last activity, newest archive first, and offers one Unarchive action per row. A search box filters the list by session title or Workspace name. Rows come from the archive set joined with the loaded Session summaries, so an archive entry whose session record is gone has no row and no action. Every restore goes through the shared Workspace command.

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

Open Settings and select **Archived sessions** to see the sessions currently hidden from every grouping surface. Mount `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` in a Web composition that already provides the settings shell, the Workspace service, and the Session list; the page registers its own navigation entry and needs no configuration.

### Reading a row

Each row shows the session's display title, the title of the Workspace that accounts for it or the ungrouped label, and its last activity as a compact relative time. The page lists the most recently archived session first, the reverse of the durable archive order. The page waits for the Session list before rendering rows; while that list loads it shows a reading status instead of an empty archive. An empty archive, an archive whose entries have no loaded Session to restore, and a query matching no row report three different messages, so neither a search nor an unaddressable entry ever looks like an empty archive.

### Restoring a session

Unarchive restores the session to its recorded position under its Workspace, or to the ungrouped sessions when it belongs to none, and the row disappears from the page. The action calls `ctx.uiWorkspace.unarchiveSession`, whose echoed archive set updates every surface that filters on it, so the session reappears in the sidebar and search as well. A rejected call is logged as a console diagnostic and leaves the row in place for another attempt.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page is one localized `settings.section` contribution with id `archived-sessions`; the Settings shell owns the navigation entry, the modal, and the mounted section, so none of that chrome lives here.

### Registration and data sources

`apply()` registers the locale namespace, binds it, and uses `ctx.slots.inject()` to contribute the section, so a late or restored slot declaration still reaches it. The page reads `state.archivedSessionIds` and `state.items` from `useWorkspaces` and the Session summaries from `useSessions`; it owns no store and no transport, and its only write is the injected `unarchive` callback that the registration closes over `ctx.uiWorkspace.unarchiveSession`.

### Row derivation

Rows are derived from the archive set joined with the loaded summaries: a member with no summary produces no row, which is why a session deleted outside the Workspace registry leaves no unarchive action behind. Workspace ownership is read from each Workspace's `sessionIds`; a member outside every Workspace renders with the ungrouped label. Search normalizes the query once and matches it against the row title and Workspace label.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host loader entry: the page is browser-only, so the plugin body is empty |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin: locale namespace, section registration, injected Unarchive operation |
| [`src/client/ArchivedSessionsSection.tsx`](src/client/ArchivedSessionsSection.tsx) | The page component: row derivation, search, per-row Unarchive |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English dictionaries for every visible and accessible string |
| [`src/client/ArchivedSessionsSection.module.css`](src/client/ArchivedSessionsSection.module.css) | Page styles |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface that hosts the page, the archive write behind it, and the state it renders.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section` and the namespace scope service.
- [ui-settings-general](../ui-settings-general/README.md) — the Settings shell that renders the navigation and mounts the section.
- [ui-workspace](../ui-workspace/README.md) — the sidebar browser whose Session rows archive, and the `ctx.uiWorkspace` service this page restores through.
- [Workspace Controller](../../api/workspace-controller/README.md) — the `workspace.unarchiveSession` Remote and the Client model that owns the archive set.
- [Workspace subsystem](../../../docs/subsystems/workspace.md) — the durable archive set, its domain field, and the registry operation behind a restore.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define which archived sessions this page can restore; they are current package constraints.

- **Archived sessions without a loaded summary are unaddressable** — the page derives its rows by joining the archive set with the Session list, so a member the list does not carry has no row and no Unarchive action even though the archive set still holds it; a set whose members are all in that state reports itself as unrestorable rather than empty.
- **The page lists sessions only; it offers no session deletion** — archives are reversible through this page, while deleting a session record remains a separate capability.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A browser-side settings page that registers one localized `settings.section` contribution and its locale namespace; it emits no Cordis events and owns no cross-plugin mutable relation.
