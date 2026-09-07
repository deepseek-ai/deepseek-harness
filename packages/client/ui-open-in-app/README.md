---
description: "Web Session-header \"Open In...\" split button: launches the remembered application on the session workspace directory and lists every application the host probed as installed."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

English | [中文](README.zh.md)

## Summary

This package provides the browser surface of the open-in-app feature: a Session-header split button whose main button opens the current session's workspace directory (the summary's `cwd`) in the remembered application, and whose chevron lists every catalog application the host probed as installed. Availability, icons, and launches come from the host routes of [`dsh-host-open-in-app`](../../host/open-in-app/README.md); mount the two packages together. A session without a workspace directory, or a host where nothing nameable is installed, renders no button at all.

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

Mount this plugin in the Web composition beside [`dsh-host-open-in-app`](../../host/open-in-app/README.md); the pair composes the whole feature in two cordis.yml rows and this row takes no config. The Session header grows an "Open In..." split button whenever the host probed at least one installed catalog application and the session has a known workspace directory.

### What to expect

The main button shows the remembered application's icon — the real application icon wherever the host extracts one (macOS bundle icons, Windows executable icons, Linux theme icons), a generic glyph where it serves none — and a design-system tooltip ("Open locally"); clicking launches immediately. The chevron opens a dense menu of the installed applications with the remembered one marked by a filled row. Availability is read once per page from the host; the last chosen application persists in the browser (`dsh.open-in-app.choice`), and a choice that is no longer installed falls back to the first available entry. A launch that finishes quickly leaves the button untouched — the dimmed busy treatment appears only after 250 ms in flight — and a failed launch shows the error tooltip and a red outline for two seconds. All copy lives in the bilingual `open-in-app` locale namespace; an application id the dictionaries cannot name is not offered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers the split button on `conversation.session.header.utilities` through the standard slot/inject currency and registers the `open-in-app` dictionaries as one effect. A page-lifetime controller ([`src/client/controller.ts`](src/client/controller.ts)) owns the once-per-page availability read, the persisted choice snapshot store, and the launch POST; the component receives both stores through the inject `hooks` compartment, so every Session header shares one truth. Route paths and wire payload types are inlined from the host package's browser-safe `@deepseek-ai/dsh-host-open-in-app/shared` subpath. In-flight launches are guarded by a ref — repeat clicks and menu picks during a launch are ignored whole (a pick would otherwise persist a choice the gesture never opened) — and the busy/error dress is timer-driven around the `launch` promise. The node half is an empty `apply` that keeps the plugin on the host roster.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-host-open-in-app](../../host/open-in-app/README.md) — the host routes serving availability, icons, and launches, and the catalog behind them.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the sibling Session-header action.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the split button is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The dictionaries gate the menu.** A host catalog extension without a matching `app.<id>` entry in both dictionaries stays invisible instead of showing a raw id; extending the catalog means extending [`dsh-host-open-in-app`](../../host/open-in-app/README.md) and this package's locales together.
- **Availability is read once per page.** An application installed while the page is open appears after a reload (and, host-side, after a host restart).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature-level decisions, including the split into the host package and this surface, are recorded in the [promotion Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.md).

</details>

**Runtime invariant:** No companion is published. The plugin registers one dictionary effect and one header-slot entry whose disposal the HMR-safety spec proves; availability and choice live in the controller's snapshot stores with no second copy to diverge.
