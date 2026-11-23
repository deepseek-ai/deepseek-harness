# Right-sidebar widget

Use this location for information or controls that should stay beside a conversation. First inspect Client services `sidebarRightTabs` and `sidebarRight`, then the `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` slots. Query only their needed signatures; do not enumerate unrelated services.

Register a unique, package-prefixed tab kind with `sidebarRightTabs.register`, including a meaningful icon, then register its body and title into the matching keyed slots using `ctx.slots.inject`. A slot body alone does not make a tab. Use `sidebarRight.openTab` only after the kind is registered and an on-screen Session exists. If the requested widget must follow conversations, subscribe to `sidebarRight.mounted`; check existing tabs before opening so it does not multiply on every render.

Keep profile-wide data in plugin-owned persistent storage, separate from session-scoped tab layouts. State local to a React component cannot survive reload or a different conversation.

The plugin owns teardown. Register a `ctx.effect` disposer that first stops any auto-open subscriptions/timers, then iterates `sidebarRight.openTabs.getSnapshot()` and closes only occurrences whose `kind` exactly matches this plugin's registered kinds, via `sidebarRight.closeIn(sessionId, tabId)`. Return the slot/type registration disposers as well. Do not close the active tab blindly, remove every unknown kind, clear the whole sidebar, or reload the page. After removal, the widget and its tab must disappear while an unrelated tab remains usable. Verify this in the available live page; saved layouts for Sessions not adopted in this window require checking the current sidebar service's supported cleanup behavior rather than claiming universal cleanup.
