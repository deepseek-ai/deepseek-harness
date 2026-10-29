---
kind: upgrade-guide
description: "Custom Web compositions using session-log-export must provide the context-menu service."
---

# Session export requires context menus

English | [中文](guide.zh.md)

## Change

The browser half of `@deepseek-ai/dsh-session-log-export` requires `contextMenus` to render its Header More menu. Custom Web compositions that previously mounted session-log-export without a context-menu provider must add one; otherwise the browser plugin waits for the missing service. The default Web composition already includes the provider. Host export routes and the `/export` command are unchanged.

## Migration

1. In a custom Web composition that lacks the provider, add `@deepseek-ai/dsh-client-ui-context-menu` to the same client plugin tree as session-log-export, with the menu package’s required services. See [context-menu composition](../../../../packages/client/ui-context-menu/README.md#use-this-package). Default Web profiles need no configuration change.
2. Restart the profile. Open a Session’s Header More menu and confirm that Copy Session as Markdown and Download session log are available; confirm that downloading still opens its Session-scoped dialog.
