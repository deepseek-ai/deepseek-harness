# Session streaming tab

Use this location for streaming output or interaction tied to the current Session, including live task logs. A request to watch content while chatting needs the right sidebar instead, because only the selected conversation tab is visible. Inspect `conversation.view` and its registration props, and the relevant Session services. Register a package-prefixed list entry through `ctx.slots.inject('conversation.view', ...)`, with a localized label. This adds a tab beside Chat and Trajectory; preserve both existing tabs.

Resolve the Session binding from the registration's `sessionId`. Keep conversation data and pending actions scoped to that Session; switching Sessions must not show another Session's data or send an action to it. Use the supported Session event/projection interfaces for streaming state, not DOM scraping or an unbounded transcript scan. Read `references/user-actions.md` from the `cordis-plugin-development` skill when the tab initiates model work.

Use the tab's allocated space and host theme. Register the view, observers and resources for the plugin lifetime; release subscriptions and unregister the view on removal. Verify streaming updates, switching away and back, changing Sessions, cancellation where applicable, and removal without disturbing Chat/Trajectory. This is different from a global main-area page reached through the left sidebar.
