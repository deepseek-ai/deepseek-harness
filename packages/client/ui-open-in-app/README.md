---
description: "Web \"Open In...\" controls: the Session-header split button launching the remembered application on the workspace directory, and the document preview's default-application open and reveal controls for one file."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

English | [中文](README.zh.md)

## Summary

This package provides the browser surface of the open-in-app feature. A Session-header split button opens the current session's workspace directory (the summary's `cwd`) in the remembered application, and its chevron lists every catalog application the host probed as installed; availability, icons, and launches come from the host routes of [`dsh-host-open-in-app`](../../host/open-in-app/README.md), so mount the two packages together. In the right Sidebar's document preview, an "Open" split button and an empty-state button open the previewed file in its default application or show its location, through the Session Remote. A host without the capability renders none of these controls.

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

Mount this plugin in the Web composition beside [`dsh-host-open-in-app`](../../host/open-in-app/README.md); the pair composes the whole feature in two cordis.yml rows and this row takes no config. The Session header grows an "Open In..." split button whenever the host probed at least one installed catalog application and the session has a known workspace directory. The document preview of [`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.md) grows its file controls whenever the Host reports a desktop through the Session Remote's `session.canOpenWorkspacePath`; removing this row removes every control at once.

### What to expect

The Session header and document header use the same 24px-high split button with 9px corners. Both headers show only the icon; their tooltip names the default application or the reveal action. Both show the default action’s icon, mark its application with “(default)” in the menu, disable while their own gesture runs, and report failures through a transient toast. The directory adapter uses the existing cross-platform application catalog and remembers the last successful choice in `dsh.open-in-app.choice`; a missing choice falls back to the first available application.

The **Open locally** shortcut captures the main Session's directory and the same remembered application as the header button. The effective binding appears in the button tooltip and `aria-keyshortcuts`; Web follows the [shortcut service’s platform defaults](../shortcuts/README.md). The command runs only while the Conversation is selected and the header button has a directory and installed application to open. An in-flight launch also blocks the command. Pointer and keyboard gestures share the controller's launch state, so repeated gestures cannot launch twice or change the remembered choice mid-launch.

File menus list the discovered associated applications without a separate “Open in default app” row. “Show file location” stays in a fixed footer separated from the scrolling applications. A successful query with only one available action renders a single button without a dropdown. Initial file-association loading uses a gray skeleton icon. When the Host identifies a default application the menu marks it “(default)” and the main button opens it; otherwise the first associated application takes that place, so the main button reveals the file only when no application is registered. Directory menus have no reveal row. Choosing a file application does not change the system default. An unpreviewable file uses the same menu in a 40px-high split button with an icon and action text; its label is “Open” or “Show file location” according to the default action.

Mounted controls with the same association reader and file share one query and its results; opening either menu refreshes all of them. Releasing the last control cancels the query and discards its state. Cancelled queries cannot replace another file’s results. A failed query displays a menu message and leaves reveal available as the default action. File-association discovery follows [native-command](../../util/native-command/README.md); an empty result, including a platform without a discovery adapter, uses the same reveal fallback without platform branches in the control.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers the split button on `conversation.session.header.utilities` through the standard slot/inject currency and registers the `open-in-app` dictionaries as one effect. A page-lifetime controller ([`src/client/controller.ts`](src/client/controller.ts)) owns the once-per-page availability read, the persisted choice snapshot store, and the launch POST; the component receives the shared sources through the inject `hooks` compartment, so every Session header shares one truth. Document-relative route forms and wire payload types come from the host package's browser-safe `@deepseek-ai/dsh-host-open-in-app/shared` subpath. The controller guards in-flight launches and publishes their captured directory and status; header controls derive delayed busy and transient error visuals from that source.

The directory and file adapters supply application metadata and operations to [`OpenTargetButton`](src/client/OpenTargetButton.tsx), which owns menu ordering, default markers, icons, sizing, and gesture feedback. The file header and empty state share `FileOpenTarget`, while `OpenPathInjected.applications` queries `session.workspacePathApplications` through [`open-path.ts`](src/client/open-path.ts). Opening uses `session.openWorkspacePath`; the Host revalidates an explicitly selected handler before launch. The directory adapter keeps the existing catalog routes. `FileRouteAction` supplies the same control to delivery cards and change review through `deliverables.file.actions` and `deliverables.review.file.actions`; their authenticated routes retain Session file authorization. A failed or unavailable file query therefore needs no platform-specific UI implementation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-host-open-in-app](../../host/open-in-app/README.md) — the host routes serving availability, icons, and launches, and the catalog behind them.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the sibling Session-header action.
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.md) — the document preview declaring the header and empty-state child slots the file controls occupy.
- [ui-deliverables](../ui-deliverables/README.md) — the delivery cards, which still open declared files through their own routes.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the split button is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

The Host verifies the path through the composed filesystem before opening or revealing it. Paths without a matching Host mapping fail without launching a native application. Default opening follows the file-type association, including HTML and SVG.

<a id="known-limitations-and-deferred-work"></a>

- **The dictionaries gate the menu.** A host catalog extension without a matching `app.<id>` entry in both dictionaries stays invisible instead of showing a raw id; extending the catalog means extending [`dsh-host-open-in-app`](../../host/open-in-app/README.md) and this package's locales together.
- **Availability is read once per page.** An application installed while the page is open appears after a reload (and, host-side, after a host restart); the desktop answer behind the file controls is read once per page as well.
- **One reveal label for every platform.** The Session Remote reports whether a desktop exists, not which file manager it runs, so the menu says "Show file location" rather than naming Finder or File Explorer as the delivery cards do.
- **The delivery cards keep their own opener.** [`ui-deliverables`](../ui-deliverables/README.md) still opens declared files through its own Session-and-event routes; folding those cards onto the file controls here is deferred to the [Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature-level decisions, including the split into the host package and this surface, are recorded in the [promotion Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.md); the document preview's file controls are recorded in the [default-application Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.md).

</details>

**Runtime invariant:** No companion is published. The plugin registers one dictionary effect and five slot entries whose disposal the HMR-safety spec proves; application availability, the choice, and the desktop answer live in the controllers' snapshot stores with no second copy to diverge.
