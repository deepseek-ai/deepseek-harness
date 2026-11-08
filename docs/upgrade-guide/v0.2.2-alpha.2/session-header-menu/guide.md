---
kind: upgrade-guide
description: "Custom Web compositions must provide context menus for Session actions, and export dialogs now remain visible across Session switches."
---

# Session Header menus and export dialogs

English | [中文](guide.zh.md)

## Change

The browser half of `@deepseek-ai/dsh-session-log-export` requires `contextMenus` to contribute copy, download, and feedback actions. Custom Web compositions without a context-menu provider must add one or these client actions cannot activate. The default Web composition already includes it. The Header More button belongs to `ui-conversation`, so removing the export plugin does not remove other registered Header actions such as Open in. The button hides when no Header-menu providers are registered.

Download dialogs are mounted in the root `shell.overlay`, rather than a Session Header. They identify the exported Session and remain visible when the user switches Sessions. Downloads may run concurrently, but dialogs appear one at a time in request order; closing one shows the next and does not cancel its download. Host export routes and the `/export` command are unchanged.

## Migration

1. Add `@deepseek-ai/dsh-client-ui-context-menu` to custom Web compositions that lack it, with the menu package's required services. See [context-menu composition](../../../../packages/client/ui-context-menu/README.md#use-this-package). Keep `ui-conversation` for the Session Header and the shell's root overlay for download feedback. Default Web profiles need no configuration change.
2. Custom client code using `SessionLogDownloadDialogProps` must use root-overlay runtime props instead of Session-header props and remove the `request` injection. `SessionLogDownloadEntry` includes an `order` value; the dialog reads Session identities and ordering from `bySession`.
3. Restart the profile. Confirm that Header More contains the registered actions, Open in remains after disabling the export plugin, and starting downloads for two Sessions presents their dialogs in request order even after switching Sessions.
