# Left-sidebar entry

A left-sidebar entry is navigation, not a second content area. Use it when the user needs a persistent place to reopen a feature. Inspect `sidebar.panellist` and its current props, and the Client `layout` service. Register a localized, package-prefixed list entry with a meaningful icon and a working click action.

If the entry opens a main-area page, read `main-page.md` beside this file and register that page under its own key. Keep the entry's selected state synchronized with the actual selected panel. Do not replace the sidebar, read sibling DOM for position, or leave a launcher whose target is missing.

Register both the launcher and its target through `ctx.slots.inject` and release both on disposal. Leave unrelated entries and pages unchanged. Verify the entry after installation, the target on click, navigation back to the conversation, and removal of both the launcher and its target.
