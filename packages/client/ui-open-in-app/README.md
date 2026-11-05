---
description: "Open Session directories from application submenus and open previewed files through their native applications."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

English | [中文](README.zh.md)

## Summary

Open a Session’s directory through **Open in** in its Header More menu or its row/title context menu. The submenu lists installed, localized applications in Host order with icons and names, without a default marker. File-tree, document-preview, and delivery controls also open files or directories through native applications. Availability, icons, and launches come from [`dsh-host-open-in-app`](../../host/open-in-app/README.md); mount both packages together. A Session without a known directory or eligible application has no Open in item.

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

Mount this plugin in the Web composition beside [`dsh-host-open-in-app`](../../host/open-in-app/README.md); this row takes no config. A known Session directory and at least one installed, localized catalog application enable its Open in submenu. The document preview of [`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.md) shows file controls when the Host reports a desktop through `session.canOpenWorkspacePath`; removing this row removes all its controls and menu contributions.

The Header entry uses the More button owned by [`ui-conversation`](../ui-conversation/README.md), with shared button behavior from [`ui-context-menu`](../ui-context-menu/README.md). Open in remains available there without the export plugin; this package supplies menu items rather than its own Header button.

### What to expect

The Session Header places **Open in** in a separated group after download and before feedback. Session-row More, row right-click, and title right-click place it after Copy session ID and before Archive. Even one application stays in a submenu. The file-tree and document headers retain their 24px-high, 9px-radius icon-only split buttons. Their tooltips name the default application or reveal action, and their menus retain the default marker. All application icons fall back to a native-open glyph when loading fails. The file-tree opener targets its owner-supplied `absolutePath` and shares application choice and launch occupancy with Session menus. Directory choices persist in `dsh.open-in-app.choice` only after successful launches; unavailable choices fall back to the first eligible application. A busy directory launch disables both the submenu parent and all application rows.

On iOS and Android phones and tablets, including installed PWAs, an acknowledged native open shows “Opened on another device”; reveal shows “File location shown on another device”. Desktop clients stay silent on success, including narrow browser windows and installed desktop PWAs. Every client receives a failure toast when the Host refuses or cannot be reached. Success means the Host accepted the native operation, not that the destination application finished loading the file. The feedback uses the existing mobile-device detector rather than viewport width or installation mode.

The **Open locally** shortcut captures the main Session’s directory and remembered application. The effective binding remains in the file-tree opener tooltip and `aria-keyshortcuts`; Web follows the [shortcut service’s platform defaults](../shortcuts/README.md). The command runs only while the Conversation is selected and that Session has a directory and installed application to open. An in-flight launch blocks the command; its outcome follows the same feedback policy as pointer gestures. Pointer and keyboard gestures share the controller’s launch state, so repeated gestures cannot launch twice or change the remembered choice mid-launch.

File menus list the discovered associated applications without a separate “Open in default app” row. “Show file location” stays in a fixed footer separated from the scrolling applications. A successful query with only one available action renders a single button without a dropdown. Initial file-association loading uses a gray skeleton icon. When the Host identifies a default application the menu marks it “(default)” and the main button opens it; otherwise the first associated application takes that place, so the main button reveals the file only when no application is registered. Directory menus have no reveal row. Choosing a file application does not change the system default. An unpreviewable file uses the same menu in a 40px-high split button with an icon and action text; its label is “Open” or “Show file location” according to the default action.

Mounted controls with the same association reader and file share one query and its results; opening either menu refreshes all of them. Releasing the last control cancels the query and discards its state. Cancelled queries cannot replace another file’s results. A failed query displays a menu message and leaves reveal available as the default action. File-association discovery follows [native-command](../../util/native-command/README.md); an empty result, including a platform without a discovery adapter, uses the same reveal fallback without platform branches in the control.

Workspace context menus reveal the captured folder through the shared directory application catalog. File-tree directories expose native reveal and Copy folder path; they do not offer file preview or save.

Context menus contribute file preview, native application opening, original-file reveal, and URL navigation and copying through [ui-context-menu](../ui-context-menu/README.md). Session submenus resolve the captured Session ID’s directory rather than the main view, and observe application, operation, Session-list, and locale changes. Native operations report through the feature’s global toast after menu dismissal or target changes, without a second registry toast. Native file actions resolve Session paths through authorized metadata before querying applications. Missing files disable path actions; image reveal requires an actual Host file and always targets that original. [ui-file-actions](../ui-file-actions/README.md) owns copy, download, save-as, and their completion feedback, including revealing the saved destination from its toast.

File menus copy absolute paths without line numbers; URL copying preserves query and fragment. Image files also expose image copy and original download, alongside the existing file actions. Successful downloads and saves show the shared Toast; picker cancellation is silent.

A file menu offers “Open in sidebar” and “Open in floating panel”, which call `ctx.sidebarRight.openResourceIn` with `destination: 'sidebar'` or `'float'` and the target's line, never the pane the menu was raised in. A file already open in the requested place is revealed; one open in the other place moves there with its reading position, so the menu can move a preview between the docked column and a floating panel. Left-click opens files as before.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`session-open-with.ts`](src/client/session-open-with.ts) shares one resolver across the shared context-menu package’s `session` and `sessionHeader` targets; other contributions do not cross between those targets. The file-tree slot uses `OpenInAppAction` with its owner’s `absolutePath`; there is no independent Session-header opener slot. A page-lifetime [`controller`](src/client/controller.ts) owns availability, persisted choice, and launch POST state. Menu observers and injected component hooks read those same sources. Document-relative routes and payload types come from the Host’s browser-safe `@deepseek-ai/dsh-host-open-in-app/shared` subpath. Adapters resolve native and transport failures to named outcomes; skipped requests announce nothing.

The directory and file adapters supply application metadata and operations to [`OpenTargetButton`](src/client/OpenTargetButton.tsx), which owns menu ordering, default markers, icons, and sizing. Its injected reporter sends outcomes to one feature-owned `shell.overlay` toast, so switching Sessions or closing the initiating preview cannot discard the result. The file header and empty state share `FileOpenTarget`, while `OpenPathInjected.applications` queries `session.workspacePathApplications` through [`open-path.ts`](src/client/open-path.ts). Opening uses `session.openWorkspacePath`; the Host revalidates an explicitly selected handler before launch. The directory adapter keeps the existing catalog routes. `FileRouteAction` supplies the same control to delivery cards and change review through `deliverables.file.actions` and `deliverables.review.file.actions`; their authenticated routes retain Session file authorization. A failed or unavailable file query therefore needs no platform-specific UI implementation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-host-open-in-app](../../host/open-in-app/README.md) — the host routes serving availability, icons, and launches, and the catalog behind them.
- [ui-conversation](../ui-conversation/README.md) — the Header owning the shared More button.
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.md) — the document preview declaring the header and empty-state child slots the file controls occupy.
- [ui-deliverables](../ui-deliverables/README.md) — the delivery cards, which still open declared files through their own routes.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as these opening controls and menus are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

The Host verifies the path through the composed filesystem before opening or revealing it. Paths without a matching Host mapping fail without launching a native application. Default opening follows the file-type association, including HTML and SVG.

<a id="known-limitations-and-deferred-work"></a>

- **The dictionaries gate the menu.** A host catalog extension without a matching `app.<id>` entry in both dictionaries stays invisible instead of showing a raw id; extending the catalog means extending [`dsh-host-open-in-app`](../../host/open-in-app/README.md) and this package's locales together.
- **Availability is read once per page.** An application installed while the page is open appears after a reload (and, host-side, after a host restart); the desktop answer behind the file controls is read once per page as well.
- **One reveal label for every platform.** The Session Remote reports whether a desktop exists, not which file manager it runs, so the menu says "Show file location" rather than naming Finder or File Explorer as the delivery cards do.
- **The delivery cards keep their own opener.** [`ui-deliverables`](../ui-deliverables/README.md) still opens declared files through its own Session-and-event routes; folding those cards onto the file controls here remains deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature-level decisions, including the split into the host package and this surface, are recorded in the [historical promotion Agent Note](../../../.agents/notes/archived/feature/2026-08-25-promote-open-anywhere-plugin.md); the document preview's file controls are recorded in the [historical default-application Agent Note](../../../.agents/notes/archived/feature/2026-09-16-open-in-default-app-for-sidebar-files.md).

</details>
